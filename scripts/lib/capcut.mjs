// Helpers shared by scripts/export-capcut.mjs and the review desk: where 剪映 keeps its drafts, and how a finished
// draft folder is put there.
import { spawn } from "node:child_process";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./storage.mjs";

const exists = (f) => stat(f).then(() => true, () => false);

// The folder 剪映 lists drafts from. Its "草稿位置" setting can point anywhere (here: another drive), so the real value is
// read from 剪映's own files, in this order: the setting currentCustomDraftPath in globalSetting; the drive folder the
// most recently edited draft lives in (root_meta_info.json); the default folder.
export async function jianyingDraftRoot() {
  const base = path.join(process.env.LOCALAPPDATA ?? "", "JianyingPro", "User Data");
  const candidates = [];
  const setting = await readFile(path.join(base, "Config", "globalSetting"), "utf8").catch(() => "");
  const custom = /^currentCustomDraftPath=(.+)$/m.exec(setting)?.[1]?.trim().replace(/\\/g, "\\");
  if (custom) candidates.push(custom);
  const meta = path.join(base, "Projects", "com.lveditor.draft", "root_meta_info.json");
  const info = await readJson(meta, null);
  const recent = [...(info?.all_draft_store ?? [])].sort((x, y) => (y.tm_draft_modified ?? 0) - (x.tm_draft_modified ?? 0))[0]?.draft_root_path;
  if (recent) candidates.push(recent);
  if (info?.root_path) candidates.push(info.root_path);
  candidates.push(path.dirname(meta));
  for (const c of candidates) if (c && (await exists(c))) return path.normalize(c);
  return null;
}

export const jianyingRunning = () => new Promise((resolve) => {
  if (process.platform !== "win32") return resolve(false);
  const child = spawn("tasklist", ["/FI", "IMAGENAME eq JianyingPro.exe", "/NH"], { windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("error", () => resolve(false));
  child.on("close", () => resolve(/JianyingPro\.exe/i.test(out)));
});

// Fill the blank meta file the library copies, the way 剪映 writes it, so the draft lists with a name and a cover.
export async function fillMeta(dir, name, rootPath, durationUs) {
  const file = path.join(dir, "draft_meta_info.json");
  const meta = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  const now = Date.now() * 1000;
  Object.assign(meta, { draft_name: name, draft_fold_path: dir.split(path.sep).join("/"), draft_root_path: rootPath.split("/").join("\\"), draft_cover: "draft_cover.jpg",
    tm_draft_create: now, tm_draft_modified: now, tm_duration: durationUs });
  await writeFile(file, JSON.stringify(meta));
}

// Copy a built draft folder into 剪映's draft folder. Never replaces an existing draft of the same name.
export async function installDraft(draftDir, name, target, durationUs) {
  const dest = path.join(target, name);
  if (await exists(dest)) throw new Error(`剪映草稿箱里已经有「${name}」。请换个名字，或先在剪映里删掉它。`);
  await cp(draftDir, dest, { recursive: true });
  await fillMeta(dest, name, target, durationUs);
  return dest;
}

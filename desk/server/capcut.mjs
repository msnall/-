// 剪映草稿 in the export center: build a draft from the current edit-plan, show what is in it, and put it into 剪映's draft folder.
//   projects/<id>/exports/capcut/<name>/            the draft (draft_content.json, draft_meta_info.json, cover)
//   projects/<id>/exports/capcut/<name>.summary.json  tracks, what could not be exported, plan revision
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { installDraft, jianyingDraftRoot, jianyingRunning } from "../../scripts/lib/capcut.mjs";
import { root } from "../../scripts/lib/media.mjs";
import { exists, projectFile, readJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict, HttpError } from "./errors.mjs";

const dirFor = (id) => projectFile(id, "exports", "capcut");
const safeName = (name) => {
  const clean = String(name ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  if (!clean || clean.length > 80 || clean === "." || clean === "..") throw badRequest("草稿名称不能为空，也不能包含 \\ / : * ? \" < > | 这些字符（最多 80 个字）");
  return clean;
};
let busy = false;

export async function capcutStatus(id) {
  const python = await exists(path.join(root, "tools", "python", "python.exe"));
  const target = await jianyingDraftRoot();
  const folder = dirFor(id);
  const drafts = [];
  for (const entry of (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())) {
    const summary = await readJson(path.join(folder, `${entry.name}.summary.json`), null);
    drafts.push({
      name: entry.name, path: path.join(folder, entry.name), builtAt: summary?.builtAt ?? (await stat(path.join(folder, entry.name))).mtime.toISOString(),
      planRevision: summary?.planRevision ?? null, tracks: summary?.tracks ?? [], skipped: summary?.skipped ?? [], durationUs: summary?.durationUs ?? null,
      installed: target ? await exists(path.join(target, entry.name)) : false,
    });
  }
  drafts.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  const live = await readJson(projectFile(id, "edit-plan.json"), null);
  return { pythonReady: python, jianyingRoot: target, jianyingRunning: await jianyingRunning(), planRevision: live ? (live.revision ?? 0) : null, drafts };
}

const runScript = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/export-capcut.mjs", ...args], { cwd: root, windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").slice(-4).join("\n") || `exit code ${code}`))));
});

export async function buildCapcut(id, body) {
  if (busy) throw conflict("正在生成另一份草稿");
  if (!(await exists(projectFile(id, "edit-plan.json")))) throw badRequest("还没有剪辑方案：先在「② 方案」选一套放进审阅精修");
  const plan = await readJson(projectFile(id, "edit-plan.json"));
  const name = safeName(body?.name || `${id} r${plan.revision ?? 0}`);
  busy = true;
  try { await runScript([id, `--name=${name}`]); }
  catch (error) { throw new HttpError(500, `生成失败：${error.message}`); }
  finally { busy = false; }
  return capcutStatus(id);
}

const draftPath = async (id, name) => {
  const dir = path.join(dirFor(id), safeName(name));
  if (!(await exists(dir))) throw new HttpError(404, "没有这份草稿");
  return dir;
};

// 多选：把方案页上选中的几套草稿各生成一份剪映草稿（不经过审阅台，用的是方案草稿原样；字幕样式、主题是默认值）。
// body: { variants: ["a","b"], install?: boolean }。逐份生成（导出组件一次只做一份）；某一份失败不影响其他份。
export async function buildCapcutVariants(id, body) {
  const variants = [...new Set(Array.isArray(body?.variants) ? body.variants.map(String) : [])];
  if (!variants.length) throw badRequest("请先勾选至少一套方案");
  if (busy) throw conflict("正在生成另一份草稿");
  for (const v of variants) {
    if (!/^[a-z]+$/.test(v) || !(await exists(projectFile(id, `edit-plan.draft.${v}.json`)))) throw badRequest(`没有这套方案：${v}（先在「③ 方案」生成）`);
  }
  busy = true;
  const results = [];
  try {
    for (const v of variants) {
      const cut = await readJson(projectFile(id, `cut-script.${v}.json`), null);
      const label = cut?.director?.direction?.name_zh ?? v;
      let name;
      try { name = safeName(`${id} ${label}`); } catch { name = `${id} ${v}`; }
      const row = { variant: v, label, name, built: false, installed: false, error: null };
      try { await runScript([id, `--plan=edit-plan.draft.${v}.json`, `--name=${name}`]); row.built = true; }
      catch (error) { row.error = `生成失败：${error.message}`; results.push(row); continue; }
      if (body?.install) {
        try { await installCapcut(id, { name }); row.installed = true; }
        catch (error) { row.error = `草稿已生成，但没能放进剪映草稿箱：${error.message}`; }
      }
      results.push(row);
    }
  } finally { busy = false; }
  return { results, status: await capcutStatus(id) };
}

export async function installCapcut(id, body) {
  const name = safeName(body?.name);
  const dir = await draftPath(id, name);
  const target = await jianyingDraftRoot();
  if (!target) throw badRequest("没有找到剪映的草稿文件夹。请先打开过一次剪映专业版。");
  const summary = await readJson(path.join(dirFor(id), `${name}.summary.json`), null);
  try { await installDraft(dir, name, target, summary?.durationUs ?? 0); }
  catch (error) { throw conflict(error.message); }
  return capcutStatus(id);
}

export async function revealCapcut(id, body) {
  if (process.platform !== "win32") throw new HttpError(501, "打开文件夹仅支持 Windows");
  const dir = await draftPath(id, body?.name);
  await new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [dir], { windowsHide: false, detached: true, stdio: "ignore" });
    child.once("error", reject); child.once("spawn", resolve); child.unref();
  });
  return { ok: true, path: dir };
}

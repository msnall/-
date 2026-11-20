// 口播清理 in the review desk: read the detections, flip decisions, re-detect, ask the model for a second look, confirm.
//   projects/<id>/cleanup.json   (written by scripts/cleanup-voice.mjs; format and rules in scripts/lib/cleanup.mjs)
import { spawn } from "node:child_process";
import path from "node:path";
import { stats } from "../../scripts/lib/cleanup.mjs";
import { transcriptPaths } from "../../scripts/lib/transcripts.mjs";
import { publicDir, root } from "../../scripts/lib/media.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict, HttpError } from "./errors.mjs";

let busy = false;
const file = (id) => projectFile(id, "cleanup.json");

export async function readCleanup(id) {
  const cleanup = await readJson(file(id), null);
  if (!cleanup) return { exists: false };
  const ingest = await readJson(projectFile(id, "ingest.json"), { assets: [] });
  const clips = {};
  for (const [clipId, c] of Object.entries(cleanup.clips)) {
    const asset = ingest.assets.find((a) => a.id === clipId);
    const words = asset ? await readJson(path.join(publicDir, transcriptPaths(asset).edited), []) : [];
    clips[clipId] = { ...c, name: asset?.originalName ?? clipId, words: words.map((w, i) => ({ i, text: w.text, startMs: c.timings[i]?.[0] ?? w.startMs, endMs: c.timings[i]?.[1] ?? w.endMs })), timings: undefined };
  }
  return { exists: true, confirmedAt: cleanup.confirmedAt, createdAt: cleanup.createdAt, model: cleanup.model, params: cleanup.params, stats: stats(cleanup), clips, busy };
}

const mutate = async (id, change) => {
  const cleanup = await readJson(file(id), null);
  if (!cleanup) throw new HttpError(404, "还没有做过口播清理检测");
  change(cleanup);
  cleanup.confirmedAt = null; // any change has to be confirmed again
  await writeJson(file(id), cleanup);
};

export const setDecision = (id, clip, editId, decision) => {
  if (!["delete", "keep"].includes(decision)) throw badRequest("decision 只能是 delete 或 keep");
  return mutate(id, (c) => {
    const edit = c.clips[clip]?.edits.find((e) => e.id === editId);
    if (!edit) throw new HttpError(404, "没有这处");
    edit.decision = decision;
  }).then(() => readCleanup(id));
};

// the editor marks (or un-marks) a single word as cut: a "slip" edit made by hand
export const setWord = (id, clip, word, cut) => mutate(id, (c) => {
  const entry = c.clips[clip];
  const t = entry?.timings[word];
  if (!t) throw new HttpError(404, "没有这个词");
  const mine = entry.edits.find((e) => e.source === "user" && e.wordFrom === word && e.wordTo === word);
  if (cut && !mine) entry.edits.push({ id: `u${Date.now().toString(36)}`, type: "slip", fromMs: Math.max(0, t[0] - 20), toMs: Math.min(entry.durationMs, t[1] + 20), reason: "你手动标的", source: "user", decision: "delete", wordFrom: word, wordTo: word });
  else if (cut && mine) mine.decision = "delete";
  else if (!cut) {
    // un-cutting a word that an automatic edit covers flips that edit instead
    const covering = entry.edits.filter((e) => e.wordFrom !== undefined && word >= e.wordFrom && word <= e.wordTo && e.decision === "delete");
    for (const e of covering) { if (e.source === "user") entry.edits.splice(entry.edits.indexOf(e), 1); else e.decision = "keep"; }
  }
  entry.edits.sort((x, y) => x.fromMs - y.fromMs);
}).then(() => readCleanup(id));

export const confirmCleanup = async (id) => {
  const cleanup = await readJson(file(id), null);
  if (!cleanup) throw badRequest("先检测一遍");
  cleanup.confirmedAt = new Date().toISOString();
  await writeJson(file(id), cleanup);
  return readCleanup(id);
};

export async function detectCleanup(id, { review = false } = {}) {
  if (busy) throw conflict("正在检测");
  busy = true;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/cleanup-voice.mjs", id, ...(review ? ["--review"] : [])], { cwd: root, windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new HttpError(500, err.trim().split("\n").slice(-3).join(" ") || `检测失败（${code}）`))));
    });
  } finally { busy = false; }
  return readCleanup(id);
}

// 风格库 (style library): reference videos are analysed locally, a model writes a style card, the editor edits and confirms it.
//   library/references/<refId>/analysis.json   facts, cuts, words, frames        (scripts/analyze-reference.mjs)
//   library/references/<refId>/run.json        progress of the background run
//   library/style-cards/<cardId>.json           the card (draft until confirmed)   (scripts/learn-style-card.mjs)
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { parseCard } from "../../scripts/lib/style-card.mjs";
import { exists, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict, HttpError } from "./errors.mjs";

const cardsDir = path.join(root, "library", "style-cards");
const refsDir = path.join(root, "library", "references");
const idOk = (id) => /^[a-z0-9][a-z0-9-]*$/.test(id ?? "");
const cardFile = (id) => { if (!idOk(id)) throw new HttpError(404, `没有风格卡 ${id}`); return path.join(cardsDir, `${id}.json`); };
const refDir = (id) => { if (!idOk(id)) throw new HttpError(404, `没有参考视频 ${id}`); return path.join(refsDir, id); };
const running = new Set();
const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];

const brief = (c) => ({ id: c.id, name: c.name, status: c.status, summary: c.summary, source: c.source, layout: c.inserts.layout, share: c.inserts.share, confirmedAt: c.confirmedAt, createdAt: c.createdAt });

export async function listCards() {
  const cards = [];
  for (const name of (await readdir(cardsDir).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    const raw = await readJson(path.join(cardsDir, name), null);
    try { if (raw) cards.push(brief(parseCard(raw))); } catch { /* a hand-edited file that no longer parses is skipped */ }
  }
  cards.sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "confirmed" ? -1 : 1));
  // runs that are still going or failed (no card yet)
  const runs = [];
  for (const entry of (await readdir(refsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())) {
    const run = await readJson(path.join(refsDir, entry.name, "run.json"), null);
    if (run && run.state !== "done") runs.push({ id: entry.name, ...run });
  }
  return { cards, runs };
}

export async function readCard(id) {
  const raw = await readJson(cardFile(id), null);
  if (!raw) throw new HttpError(404, `没有风格卡 ${id}`);
  const card = parseCard(raw);
  const ref = card.source.referenceId;
  const analysis = ref && idOk(ref) ? await readJson(path.join(refsDir, ref, "analysis.json"), null) : null;
  return { card, analysis: analysis && { facts: analysis.facts, pacing: analysis.pacing, cuts: analysis.cuts.timesMs, text: analysis.transcript.text, frames: analysis.frames.map((f) => f.t) } };
}

// body: any of summary, structure, rhythm, camera, captions, inserts, packaging, directorRules, name
export async function saveCard(id, body) {
  const { card } = await readCard(id);
  const next = parseCard({
    ...card, ...Object.fromEntries(["name", "summary", "structure", "rhythm", "camera", "captions", "inserts", "packaging", "directorRules"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])),
    status: "draft", confirmedAt: null, // any change has to be confirmed again
  });
  await writeJson(cardFile(id), next);
  return next;
}

export async function confirmCard(id, body) {
  const { card } = await readCard(id);
  const name = String(body?.name ?? card.name).trim();
  if (!name) throw badRequest("风格卡要有名字（比如「kika-UGC快节奏」）");
  const others = (await listCards()).cards.filter((c) => c.id !== id && c.status === "confirmed" && c.name === name);
  if (others.length) throw conflict(`已经有一张叫「${name}」的风格卡`);
  if (!card.structure.length) throw badRequest("结构一栏是空的，不能确认");
  const next = parseCard({ ...card, name, status: "confirmed", confirmedAt: new Date().toISOString() });
  await writeJson(cardFile(id), next);
  return next;
}

export async function deleteCard(id) {
  await readCard(id);
  await rm(cardFile(id), { force: true });
  return { id, deleted: true };
}

export async function confirmedCard(id) {
  const raw = id ? await readJson(cardFile(id), null) : null;
  if (!raw) return null;
  const card = parseCard(raw);
  return card.status === "confirmed" ? card : null;
}

// ---- 拆解新视频: analyse locally, then let the model write the card ----------------------------------------------------------
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export async function importReference({ file, title }) {
  if (typeof file !== "string" || !file.trim()) throw badRequest("请填写视频文件的完整路径");
  const input = path.resolve(file.trim().replace(/^"|"$/g, ""));
  const info = await stat(input).catch(() => null);
  if (!info?.isFile()) throw badRequest(`找不到文件：${input}`);
  if (!/\.(mp4|mov|m4v|webm)$/i.test(input)) throw badRequest("只支持 mp4 / mov / m4v / webm");
  const name = (title ?? "").trim() || path.parse(input).name;
  let id = slug(path.parse(input).name) || "reference";
  while (await exists(path.join(refsDir, id, "analysis.json"))) id = `${id.replace(/-\d+$/, "")}-${Number(id.match(/-(\d+)$/)?.[1] ?? 1) + 1}`;
  return run(id, input, name);
}

export async function relearn(refId) {
  const analysis = await readJson(path.join(refDir(refId), "analysis.json"), null);
  if (!analysis) throw badRequest("还没有分析数据");
  return run(refId, null, analysis.title);
}

async function run(id, input, title) {
  if (running.has(id)) throw conflict("这条视频正在拆解");
  const dir = refDir(id);
  await mkdir(dir, { recursive: true });
  const steps = [...(input ? [{ name: "本地分析：镜头切点、转录、关键帧", command: node("scripts/analyze-reference.mjs", id, input, `--title=${title}`) }] : []), { name: "模型写风格卡", command: node("scripts/learn-style-card.mjs", id) }];
  const record = { state: "running", title, startedAt: new Date().toISOString(), finishedAt: null, steps: steps.map((s) => ({ name: s.name, state: "pending" })), error: null };
  await writeJson(path.join(dir, "run.json"), record);
  running.add(id);
  (async () => {
    const log = createWriteStream(path.join(dir, "run.log"), { flags: "w" });
    const save = () => writeJson(path.join(dir, "run.json"), record);
    let current = 0;
    try {
      for (; current < steps.length; current++) {
        record.steps[current].state = "running"; await save();
        await new Promise((resolve, reject) => {
          const child = spawn(steps[current].command[0], steps[current].command[1], { cwd: root, windowsHide: true });
          let err = "";
          child.stdout.on("data", (d) => log.write(d));
          child.stderr.on("data", (d) => { log.write(d); err = (err + d).slice(-500); });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit code ${code}`))));
        });
        record.steps[current].state = "done"; await save();
      }
      record.state = "done";
    } catch (error) {
      record.state = "failed"; record.steps[current].state = "failed"; record.error = `${steps[current].name}失败：${error.message}`;
    } finally { log.end(); record.finishedAt = new Date().toISOString(); running.delete(id); await save(); }
  })();
  return { id, ...record };
}

export const referenceFrame = (id, name) => {
  if (!/^t\d{3}\.jpg$/.test(name)) throw new HttpError(404, "Not found");
  return path.join(refDir(id), "frames", name);
};

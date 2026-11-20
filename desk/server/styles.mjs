// 风格库 (style library): reference videos are analysed locally, a model writes a style card, the editor edits and confirms it.
//   library/references/<refId>/analysis.json   facts, cuts, words, frames        (scripts/analyze-reference.mjs)
//   library/references/<refId>/run.json        progress of the background run
//   library/style-cards/<cardId>.json           the card (draft until confirmed)   (scripts/learn-style-card.mjs)
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { isV2, parseCard } from "../../scripts/lib/style-card.mjs";
import { measure, productFreeProblems, ROLES2 } from "../../scripts/lib/style-card2.mjs";
import { exists, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict, HttpError } from "./errors.mjs";

const cardsDir = path.join(root, "library", "style-cards");
const refsDir = path.join(root, "library", "references");
const idOk = (id) => /^[a-z0-9][a-z0-9-]*$/.test(id ?? "");
const cardFile = (id) => { if (!idOk(id)) throw new HttpError(404, `没有风格卡 ${id}`); return path.join(cardsDir, `${id}.json`); };
const refDir = (id) => { if (!idOk(id)) throw new HttpError(404, `没有参考视频 ${id}`); return path.join(refsDir, id); };
const running = new Set();
const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];

const brief = (c) => (isV2(c)
  ? { id: c.id, version: 2, name: c.name, status: c.status, summary: c.summary_zh, source: { referenceId: c.source.referenceId, title: c.source.title, durationMs: c.source.durationMs, shots: c.timeline.length }, layout: c.direction.layoutBias, share: c.direction.brollRatioTarget, confirmedAt: c.confirmedAt, createdAt: c.createdAt,
    meta: c.meta, pacing: c.direction.pacing, hookTreatment: c.direction.hookTreatment, selfTest: c.selfTest ? { brollOverlap: c.selfTest.brollOverlap, zoomSame: c.selfTest.zoomSame } : null, unsupported: c.techniques.filter((t) => t.support !== "ready").length }
  : { id: c.id, version: 1, name: c.name, status: c.status, summary: c.summary, source: c.source, layout: c.inserts.layout, share: c.inserts.share, confirmedAt: c.confirmedAt, createdAt: c.createdAt });

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
    // a failed run whose reference has a card by now (it was run again by hand, or relearned) is only noise
    if (run && run.state !== "done" && !(run.state === "failed" && cards.some((c) => c.source.referenceId === entry.name))) runs.push({ id: entry.name, ...run });
  }
  return { cards, runs };
}

export async function readCard(id) {
  const raw = await readJson(cardFile(id), null);
  if (!raw) throw new HttpError(404, `没有风格卡 ${id}`);
  const card = parseCard(raw);
  const ref = card.source.referenceId;
  const analysis = ref && idOk(ref) ? await readJson(path.join(refsDir, ref, "analysis.json"), null) : null;
  return { card, analysis: analysis && { facts: analysis.facts, pacing: analysis.pacing, cuts: analysis.cuts.timesMs, text: analysis.transcript.text, frames: analysis.frames.map((f) => f.t) }, insights: isV2(card) ? await cardInsights(card) : null };
}

// where a card is used (projects whose cut scripts came from it) — so the editor knows what a change to the card touches
async function cardInsights(card) {
  const usedBy = [];
  const projects = path.join(root, "projects");
  for (const entry of (await readdir(projects, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())) {
    const run = await readJson(path.join(projects, entry.name, "director-run.json"), null);
    if (run?.card?.id === card.id) usedBy.push(entry.name);
  }
  return { usedBy, roles: ROLES2 };
}

// 风格库首页的两个汇总：待开发的效果（已确认卡里不是「已支持」的技巧，按几张卡用到排序），和每张卡被哪些项目用过
export async function libraryInsights() {
  const { cards } = await listCards();
  const todo = new Map();
  const usedBy = {};
  for (const brief of cards.filter((c) => c.version === 2)) {
    const card = parseCard(await readJson(cardFile(brief.id)));
    usedBy[card.id] = (await cardInsights(card)).usedBy;
    if (card.status !== "confirmed") continue;
    for (const t of card.techniques.filter((x) => x.support !== "ready")) {
      const key = t.effectId ?? t.name_zh;
      const row = todo.get(key) ?? { key, name: t.name_zh, effectId: t.effectId, support: t.support, cards: [] };
      if (!row.cards.includes(card.name)) row.cards.push(card.name);
      todo.set(key, row);
    }
  }
  return { toBuild: [...todo.values()].sort((a, b) => b.cards.length - a.cards.length).map((r) => ({ ...r, count: r.cards.length })), usedBy };
}

// body: any of summary, structure, rhythm, camera, captions, inserts, packaging, directorRules, name
export async function saveCard(id, body) {
  const { card } = await readCard(id);
  if (isV2(card)) return saveCardV2(id, card, body);
  const next = parseCard({
    ...card, ...Object.fromEntries(["name", "summary", "structure", "rhythm", "camera", "captions", "inserts", "packaging", "directorRules"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])),
    status: "draft", confirmedAt: null, // any change has to be confirmed again
  });
  await writeJson(cardFile(id), next);
  return next;
}

// v2: editable parts of a card. Editing the timeline recomputes every measured number; the rules are checked for product names again.
async function saveCardV2(id, card, body) {
  const keys = ["name", "summary_zh", "meta", "direction", "presetOverrides", "structure", "timeline", "techniques", "directorRules", "contentSpecific_zh", "captions", "packaging_zh", "productTerms"];
  const merged = { ...card, ...Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) };
  if (body.timeline !== undefined) merged.measured = measure(parseCard({ ...merged }).timeline, merged.source.durationMs);
  const next = parseCard({ ...merged, status: "draft", confirmedAt: null });
  if (next.directorRules.length > 8) throw badRequest("给自动导演的规则最多 8 条");
  const problems = productFreeProblems(next);
  if (problems.length) throw badRequest("规则里不能出现参考视频的产品名，产品相关的请写到「只属于参考视频的内容」：", { problems });
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
  if (isV2(card)) { const problems = productFreeProblems(card); if (problems.length) throw badRequest("规则里还有产品名，不能确认：", { problems }); }
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

// 复现度：用参考视频自己的口播和这张卡出一次方案，和参考视频比较（约 1 分钟，同步返回）
export async function selfTestCard(id) {
  const { card } = await readCard(id);
  if (!isV2(card)) throw badRequest("旧格式的卡不能自测，请先「重新拆解」");
  if (running.has(`selftest:${id}`)) throw conflict("正在自测");
  running.add(`selftest:${id}`);
  try {
    await new Promise((resolve, reject) => {
      const [cmd, args] = node("scripts/style-card-selftest.mjs", id);
      const child = spawn(cmd, args, { cwd: root, windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => (err = (err + d).slice(-400)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new HttpError(500, `自测失败：${err.trim().split("\n").pop() || code}`))));
    });
  } finally { running.delete(`selftest:${id}`); }
  return readCard(id);
}

// 拖进页面的参考视频：存到 library/references/_uploads/（只用来分析，不会进成片），返回本机路径，再交给 importReference
export async function saveReferenceUpload(params, request) {
  const original = String(params.get("name") ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!/\.(mp4|mov|m4v|webm)$/i.test(original)) throw badRequest("只支持 mp4 / mov / m4v / webm");
  const dir = path.join(refsDir, "_uploads");
  await mkdir(dir, { recursive: true });
  const ext = path.extname(original), base = path.basename(original, ext);
  let name = original, n = 1;
  while (await exists(path.join(dir, name))) name = `${base}-${++n}${ext}`;
  const final = path.join(dir, name), temp = `${final}.part`;
  let size = 0;
  request.on("data", (chunk) => { size += chunk.length; if (size > 4 * 1024 ** 3) request.destroy(new Error("文件超过 4 GB")); });
  try { await pipeline(request, createWriteStream(temp)); } catch (error) { await rm(temp, { force: true }); throw error; }
  if (!size) { await rm(temp, { force: true }); throw badRequest("文件是空的"); }
  await rename(temp, final);
  return { file: final, name, bytes: size };
}

// the × on a failed run in the list: forget the failure (the reference's analysis stays, so it can be run again)
export async function dismissRun(refId) {
  const file = path.join(refDir(refId), "run.json");
  const run = await readJson(file, null);
  if (run?.state === "running") throw conflict("这条视频还在拆解，不能关掉");
  await rm(file, { force: true });
  return { id: refId, dismissed: true };
}

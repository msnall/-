// Asset catalog: manual classification of everything an order brings, before any storyboard.
//
//   projects/<id>/ingest.json    machine facts (written by scripts/ingest-order.mjs)
//   projects/<id>/catalog.json   per-item AI draft + human corrections + confirmation
//
// The AI describer only ever writes `ai`; people write `human`. The effective value is
// human ?? ai ?? default, so a re-run of the describer can never overwrite a correction.
// 文案 items are not pre-written scripts: they are what each creator clip actually says
// (Whisper transcript, one sentence per line), meant to be proofread by a person.
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { publicDir, root, run } from "../../scripts/lib/media.mjs";
import { projectFile, readJson, writeJson, exists, projectsDir } from "../../scripts/lib/storage.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import { describeItem, providerInfo } from "./catalog-describe.mjs";
import { diffWords, tokensOf } from "../../scripts/lib/wordsim.mjs";

export const CATEGORIES = [
  { id: "script", label: "文案", hint: "达人口播里实际说的话（Whisper 转录，逐句，需要校对）" },
  { id: "talk", label: "达人口播", hint: "达人对镜头说话的片段（近景、半身）" },
  { id: "action", label: "达人动作", hint: "达人的手部、表情、拿手机等无台词动作" },
  { id: "screen", label: "游戏录屏", hint: "我们自己录制的软件/游戏操作录屏" },
  { id: "official", label: "官方素材", hint: "品牌方提供的视频、logo、截图" },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const cacheDir = (id) => path.join(root, "out/desk-cache", id, "catalog");
const FRAMING = { closeup: "近景", waist: "半身" };

export async function listCatalogs() {
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    if (!(await exists(path.join(projectsDir, entry.name, "ingest.json")))) continue;
    const catalog = await readCatalog(entry.name);
    const counted = catalog.items.filter((i) => i.counted);
    result.push({ id: entry.name, order: catalog.order, total: counted.length, confirmed: counted.filter((i) => i.confirmed).length });
  }
  return result;
}

const durationLabel = (ms) => (ms ? `${(ms / 1000).toFixed(1)} 秒` : null);

// Words -> sentences: break after . ! ? or a pause longer than 500 ms.
const sentencesOf = (words) => {
  const sentences = [];
  let current = null;
  words.forEach((w, i) => {
    current ??= { words: [], startMs: w.startMs, endMs: w.endMs };
    current.words.push(w.text); current.endMs = w.endMs;
    const next = words[i + 1];
    if (!next || /[.!?]$/.test(w.text) || next.startMs - w.endMs > 500) { sentences.push({ text: current.words.join(" "), startMs: current.startMs, endMs: current.endMs }); current = null; }
  });
  return sentences;
};

async function baseItems(id) {
  const ingest = await readJson(projectFile(id, "ingest.json"), null);
  if (!ingest) throw new HttpError(404, `项目 ${id} 还没有入库（缺 ingest.json）`);
  const items = [];
  for (const a of ingest.assets) {
    const isImage = a.kind === "image";
    items.push({
      id: a.id, type: isImage ? "image" : "video", title: a.originalName,
      defaultCategory: a.group === "creator" ? (a.speech ? "talk" : "action") : (a.intake ?? "official"),
      facts: [a.width ? `${a.width}×${a.height}` : null, durationLabel(a.durationMs), a.group === "creator" ? `达人 ${a.creator?.name ?? ""}`.trim() : null, a.framing ? (FRAMING[a.framing] ?? a.framing) : null,
        a.group === "creator" ? (a.speech ? "有人声" : "无人声") : null, a.warning ?? null].filter(Boolean),
      file: a.file, durationMs: a.durationMs ?? null,
      context: { group: a.group, tags: a.tags ?? [], usable: a.usable ?? null, framing: a.framing ?? null, speech: a.speech ?? null, transcriptWords: a.transcript?.words ?? null },
    });
  }
  for (const a of ingest.assets.filter((x) => x.group === "creator" && x.speech && x.transcript?.words)) {
    const sentences = sentencesOf(await readJson(path.join(publicDir, a.transcript.words), []));
    items.push({
      id: `script:${a.id}`, type: "text", title: `${a.originalName} · 口播文案`, body: sentences.map((s) => s.text).join("\n"),
      file: a.file, durationMs: a.durationMs, defaultCategory: "script",
      facts: [`来自口播 ${a.id}`, `${sentences.length} 句`, "Whisper 转录，需校对"], context: { assetId: a.id, sentences },
    });
  }
  return { order: ingest.order, items };
}

// The script the brand/we gave the creator to read (03_脚本/*.txt|md, copied at ingest): shown next to the transcripts so a person can compare.
async function readReference(id) {
  const dir = projectFile(id, "script-text");
  const names = (await readdir(dir).catch(() => [])).filter((n) => /\.(txt|md)$/i.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, text: (await readFile(path.join(dir, name), "utf8")).replace(/^﻿/, "").trim() })));
}

export async function readCatalog(id) {
  const base = await baseItems(id);
  const stored = await readJson(projectFile(id, "catalog.json"), { version: 1, items: {} });
  const items = base.items.map((item) => {
    const s = stored.items[item.id] ?? {};
    const ai = s.ai ?? null, human = s.human ?? null;
    const isText = item.type === "text";
    const description = human?.description ?? (isText ? item.body : ai?.description) ?? "";
    let textCheck = null;
    if (isText) {
      const original = tokensOf(item.body), edited = tokensOf(description);
      textCheck = original.length !== edited.length ? { wordCountFrom: original.length, wordCountTo: edited.length, changes: [] } : { wordCountFrom: original.length, wordCountTo: edited.length, changes: diffWords(original, edited) };
    }
    return {
      ...item, ai, human, confirmed: !!s.confirmed, confirmedAt: s.confirmedAt ?? null, counted: true,
      category: human?.category ?? ai?.category ?? item.defaultCategory,
      description, textCheck,
      tags: human?.tags ?? ai?.tags ?? [],
      descriptionSource: human?.description !== undefined ? "human" : isText ? "transcript" : ai?.description ? "ai" : "none",
    };
  });
  return { id, order: base.order, categories: CATEGORIES, provider: await providerInfo(), items, reference: await readReference(id) };
}

const writeStored = async (id, mutate) => {
  const file = projectFile(id, "catalog.json");
  const stored = await readJson(file, { version: 1, items: {} });
  mutate(stored.items);
  stored.updatedAt = new Date().toISOString();
  await writeJson(file, stored);
};
const requireItem = async (id, itemId) => {
  const catalog = await readCatalog(id);
  const item = catalog.items.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, `没有素材 ${itemId}`);
  return item;
};

// Human edit: only the fields that are present change; a field set to null clears the override.
export async function saveItem(id, itemId, body) {
  await requireItem(id, itemId);
  if (body.category !== undefined && body.category !== null && !CATEGORY_IDS.has(body.category)) throw badRequest(`未知分类 ${body.category}`);
  if (body.tags !== undefined && body.tags !== null && !(Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string"))) throw badRequest("tags 必须是字符串数组");
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") throw badRequest("description 必须是字符串");
  await writeStored(id, (items) => {
    const entry = (items[itemId] ??= {});
    const human = { ...(entry.human ?? {}) };
    for (const key of ["category", "description", "tags", "note"]) {
      if (body[key] === undefined) continue;
      if (body[key] === null) delete human[key]; else human[key] = key === "tags" ? body.tags.map((t) => t.trim()).filter(Boolean) : body[key];
    }
    human.editedAt = new Date().toISOString();
    entry.human = human;
    if (body.confirmed !== undefined) { entry.confirmed = !!body.confirmed; entry.confirmedAt = body.confirmed ? human.editedAt : null; }
    else if (entry.confirmed) { entry.confirmed = false; entry.confirmedAt = null; } // editing reopens review
  });
  return requireItem(id, itemId);
}

export async function confirmItem(id, itemId, confirmed) {
  await requireItem(id, itemId);
  await writeStored(id, (items) => { const e = (items[itemId] ??= {}); e.confirmed = !!confirmed; e.confirmedAt = confirmed ? new Date().toISOString() : null; });
  return requireItem(id, itemId);
}

// Confirm (or reopen) many items at once; the page sends the currently listed ones.
export async function confirmMany(id, itemIds, confirmed) {
  if (!Array.isArray(itemIds) || !itemIds.length) throw badRequest("没有选中素材");
  const catalog = await readCatalog(id);
  const known = new Set(catalog.items.map((i) => i.id));
  const ids = itemIds.filter((x) => known.has(x));
  const at = new Date().toISOString();
  await writeStored(id, (items) => { for (const x of ids) { const e = (items[x] ??= {}); e.confirmed = !!confirmed; e.confirmedAt = confirmed ? at : null; } });
  return { changed: ids.length, catalog: await readCatalog(id) };
}

// Frames used both for the page and as input for an external describer.
export async function framesFor(id, itemId, count = 4) {
  const item = await requireItem(id, itemId);
  if (!item.file || item.type === "image") throw badRequest("只有视频有关键帧");
  const dir = path.join(cacheDir(id), item.id.replace(/^script:/, "script-"));
  await mkdir(dir, { recursive: true });
  const files = [];
  for (let n = 0; n < count; n++) {
    const out = path.join(dir, `f${n}.jpg`);
    if (!(await stat(out).catch(() => null))) {
      const at = Math.max(0, ((n + 0.5) / count) * (item.durationMs / 1000));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", path.join(publicDir, item.file), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", out]);
    }
    files.push(out);
  }
  return files;
}
export const frameFile = async (id, itemId, n) => (await framesFor(id, itemId))[Math.min(3, Math.max(0, Number(n) || 0))];
// One still of a clip at an exact time (for the table: what the creator looks like on this line).
export async function frameAt(id, itemId, ms) {
  const item = await requireItem(id, itemId);
  if (!item.file || item.type === "image") throw badRequest("只有视频有画面");
  const at = Math.max(0, Math.min(Number(ms) || 0, (item.durationMs ?? 1000) - 100));
  const dir = path.join(cacheDir(id), "at");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${item.id.replace(/[^a-z0-9-]/gi, "_")}-${Math.round(at)}.jpg`);
  if (!(await stat(out).catch(() => null))) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", (at / 1000).toFixed(2), "-i", path.join(publicDir, item.file), "-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "5", out]);
  return out;
}

export const mediaPath = async (id, itemId) => {
  const item = await requireItem(id, itemId);
  if (!item.file) throw new HttpError(404, "该素材没有媒体文件");
  return path.join(publicDir, item.file);
};

// AI first pass. Never touches `human`; items that already have an AI draft are skipped unless force.
// Transcript (文案) items are not described: their text already is the transcript.
export async function describeItems(id, { items: only, force = false } = {}) {
  const catalog = await readCatalog(id);
  const eligible = catalog.items.filter((i) => i.type !== "text");
  const targets = eligible.filter((i) => (!only || only.includes(i.id)) && (force || !i.ai));
  const results = {};
  const errors = {};
  for (const item of targets) {
    try {
      const frames = item.type === "video" ? await framesFor(id, item.id) : [];
      results[item.id] = await describeItem(item, { frames, catalog });
    } catch (error) { errors[item.id] = error.message; }
  }
  if (Object.keys(results).length) await writeStored(id, (items) => { for (const [k, v] of Object.entries(results)) (items[k] ??= {}).ai = { ...v, at: new Date().toISOString() }; });
  return { described: Object.keys(results).length, skipped: eligible.length - targets.length, errors, catalog: await readCatalog(id) };
}

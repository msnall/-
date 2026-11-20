// Auto director (方案 v1.2): choose a creative direction and, per direction, the zoom of every beat, the b-roll and the caption emphasis
// — from the catalog descriptions, key frames and the proofread / cleaned transcripts, using the model from 「API 设置」.
// Code does everything that can be checked.
//
//   node scripts/auto-director.mjs <projectId> --stage=directions [--card=<style card id>]
//        one model call: 3 distinct directions -> projects/<id>/analysis/directions.json
//   node scripts/auto-director.mjs <projectId> --stage=plan --slot=a|b|c [--card=<id>] [--retries=2]
//        one plan for direction 1/2/3 -> projects/<id>/cut-script.<slot>.json (a v2 cut script, status "draft")
//   node scripts/auto-director.mjs <projectId> --stage=compare [--card=<id>]
//        the three plans must differ; the one most like the others is asked again (feedback names the similarity)
//   add --dry to print what would be sent without calling the model
//
// The model only gives words (beat id + word index); milliseconds, frame snapping, overlap, the b-roll share, forbidden claims and every
// effect id are computed or validated here. A rejected answer goes back to the model with the exact errors.
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readCatalog } from "../desk/server/catalog.mjs";
import { callModel, readApiSettings } from "../desk/server/settings.mjs";
import { publicDir, root } from "./lib/media.mjs";
import { FORBIDDEN } from "./lib/claims.mjs";
import { FPS, baseLines, beatLengthMs, loadClips, mapToBeatMs, seedBeats } from "./lib/beats.mjs";
import { COLOR_HEX, COLOR_IDS, HOOK_TREATMENTS, LAYOUT_BIAS, PACING_IDS, PACING_PRESETS, PIP_SLOTS, PLACEMENTS, STRUCTURES, ZOOM_IDS, ZOOM_PATTERNS, ZOOM_SCALE, directionsSchema, effectsText, planSchema, zoomIdOf } from "./lib/effects.mjs";
import { DIRECTIONS_SYSTEM, PLAN_SYSTEM, fill } from "./lib/director-prompts.mjs";
import { similarity } from "./lib/plan-similarity.mjs";
import { examplesText, labelLines, readSegments, retrieveExamples, tendenciesText } from "./lib/segments.mjs";
import { directorGuide, parseCard } from "./lib/style-card.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const stage = opt("stage", "plan");
const SLOTS = ["a", "b", "c"];
if (!projectId || !["directions", "plan", "compare"].includes(stage)) { console.error("Usage: node scripts/auto-director.mjs <projectId> --stage=directions|plan|compare [--slot=a|b|c] [--card=<id>] [--retries=2] [--dry]"); process.exit(1); }
// An old page/server still starts this script the old way (--variant=full …): say so instead of quietly doing something else.
if (args.some((x) => x.startsWith("--variant"))) { console.error("服务还是旧版本（它按旧方式调用了方案脚本）。请关掉运行 npm run desk 的窗口，重新运行 npm run desk。"); process.exit(4); }
const dir = path.join(root, "projects", projectId);
const maxRetries = Number(opt("retries", "2"));
const dry = args.includes("--dry");
const useExamples = !args.includes("--no-examples"); // for comparing runs with and without the segment library
const frameMs = 1000 / FPS;
const MIN_BEAT_MS = 1200;
const analysisFile = (name) => path.join(dir, "analysis", name);
const cutFile = (slot) => path.join(dir, `cut-script.${slot}.json`);

// ---- context ---------------------------------------------------------------------------------------------------
const cardId = opt("card", "");
let card = null;
if (cardId) {
  const raw = await readJson(path.join(root, "library", "style-cards", `${cardId}.json`), null);
  card = raw ? parseCard(raw) : null;
  if (!card || card.status !== "confirmed") { console.error(`style card "${cardId}" does not exist or is not confirmed (风格库 page)`); process.exit(3); }
}
const cardGuide = card ? directorGuide(card) : null;
const catalog = await readCatalog(projectId);
const brief = await readJson(path.join(dir, "brief.json"), null);
const clips = await loadClips(projectId);
if (!clips.length) { console.error("No creator clip with speech and an .edited transcript (run order:transcribe and order:sync-text first)"); process.exit(1); }
const lines = await baseLines(projectId);
const lineById = new Map(lines.map((l) => [l.id, l]));
const baseId = (id) => String(id).replace(/[a-z]$/, "");
const wordsOf = Object.fromEntries(clips.map((c) => [c.clip.id, c.words]));
const secs = (ms) => (ms / 1000).toFixed(2);
const ingest = await readJson(path.join(dir, "ingest.json"));
const facts = new Map(ingest.assets.map((a) => [a.id, a]));
const pool = catalog.items.filter((i) => i.type === "video" && ["screen", "official", "action"].includes(i.category) && i.durationMs);
const poolById = new Map(pool.map((i) => [i.id, i]));
const END_CARD = /结尾|end[- ]?card|下载引导|品牌结尾|download/i;
const endCards = pool.filter((i) => END_CARD.test(`${i.description} ${(i.tags ?? []).join(" ")}`));
const CTA = /\b(tap|click|download|try|get|link|shop|order|sign up|install|check out)\b/i;
const FILLER = new Set(["the", "a", "an", "and", "or", "to", "of", "i", "you", "so", "but", "just", "really", "very", "is", "it", "its", "in", "on", "at", "for", "with", "that", "this", "my", "me", "are", "was", "be", "um", "uh", "like", "if", "do", "dont", "have", "has"]);
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const brandText = brief ? `Brand: ${brief.product?.name}. Allowed claims: ${brief.product?.claimsAllowed?.join("; ")}. Forbidden: ${brief.product?.claimsForbidden?.join("; ")}. Restrictions: ${brief.restrictions?.join("; ")}.` : "";
const cardText = cardGuide?.text ? `STYLE CARD GUIDE (rhythm and visual habits; anything about another product is reference only):\n${cardGuide.text}` : "";
// role + features of every beat (one cheap model call per generation, saved so the three plan calls reuse it)
const labelsFile = analysisFile("line-labels.json");
async function loadLabels(fresh) {
  const saved = await readJson(labelsFile, null);
  if (!fresh && saved && lines.every((l) => saved.labels?.[l.id])) return saved.labels;
  const labels = await labelLines(lines, { productTerms: [] });
  await mkdir(path.dirname(labelsFile), { recursive: true });
  await writeJson(labelsFile, { at: new Date().toISOString(), labels });
  return labels;
}
const library = useExamples ? await readSegments() : [];
const labelOf = dry ? {} : await loadLabels(stage === "directions");
const beatsForRetrieval = lines.map((l) => ({ id: l.id, text: l.text, role: labelOf[l.id]?.role ?? "benefit", features: labelOf[l.id]?.features ?? [] }));
const linesText = lines.map((l) => `${l.id} (${secs(l.endMs - l.startMs)} s)${labelOf[l.id] ? ` [${labelOf[l.id].role} | ${labelOf[l.id].features.join(", ") || "-"}]` : ""}: "${l.text}"`).join("\n");
const assetLine = (i) => `ASSET ${i.id}: ${secs(i.durationMs)} s, size ${facts.get(i.id)?.width}x${facts.get(i.id)?.height}, category ${i.category}. ${i.description} tags: ${(i.tags ?? []).join(", ")}.`;

const settings = await readApiSettings();
if (!dry && !settings.apiKey) { console.error("No API key saved (设置 → API 设置)."); process.exit(1); }
const callSettings = { ...settings, maxTokens: Math.max(settings.maxTokens, 8000), timeoutSec: Math.max(settings.timeoutSec, 180) };
const parseJson = (raw) => { try { return JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? ""); } catch { return null; } };
const ask = async ({ system, parts, schema, name }) => {
  const reply = await callModel({ system, parts, settings: callSettings, cache: true, tool: { name, description: "Return the answer as this object.", schema } });
  return { ...reply, answer: parseJson(reply.text) };
};

const STRIPS = 8;
const stripFor = async (item) => {
  const cache = path.join(root, "out/desk-cache", projectId, "director");
  await mkdir(cache, { recursive: true });
  const out = path.join(cache, `${item.id}.jpg`);
  if (!(await stat(out).catch(() => null))) {
    const fps = STRIPS / (item.durationMs / 1000);
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(publicDir, item.file), "-vf", `fps=${fps.toFixed(5)},scale=150:-2,tile=${STRIPS}x1`, "-frames:v", "1", "-q:v", "5", out], { windowsHide: true });
      p.on("error", reject); p.on("close", (c) => (c ? reject(new Error(`ffmpeg exited ${c}`)) : resolve()));
    });
  }
  return out;
};

// ================================================================================================================
// stage 1: creative directions
// ================================================================================================================
function checkDirections(answer) {
  const errors = [];
  const list = answer?.directions;
  if (!Array.isArray(list) || list.length !== 3) return ["return exactly 3 directions"];
  list.forEach((d, n) => {
    const at = `direction ${n + 1}`;
    if (!HOOK_TREATMENTS.some((h) => h.id === d.hookTreatment)) errors.push(`${at}: hookTreatment must be one of ${HOOK_TREATMENTS.map((h) => h.id).join(", ")}`);
    if (!STRUCTURES.includes(d.structureEmphasis)) errors.push(`${at}: structureEmphasis must be one of ${STRUCTURES.join(", ")}`);
    if (!PACING_IDS.includes(d.pacing)) errors.push(`${at}: pacing must be one of ${PACING_IDS.join(", ")}`);
    if (!PLACEMENTS.includes(d.brollPlacement)) errors.push(`${at}: brollPlacement must be one of ${PLACEMENTS.join(", ")}`);
    if (!LAYOUT_BIAS.includes(d.layoutBias)) errors.push(`${at}: layoutBias must be one of ${LAYOUT_BIAS.join(", ")}`);
    if (!ZOOM_PATTERNS.includes(d.zoomPattern)) errors.push(`${at}: zoomPattern must be one of ${ZOOM_PATTERNS.join(", ")}`);
    for (const key of ["hookBeat", "climaxBeat"]) if (!lineById.has(d[key])) errors.push(`${at}: ${key} "${d[key]}" is not a beat id (${[...lineById.keys()].join(", ")})`);
    if (typeof d.name_zh !== "string" || !d.name_zh.trim()) errors.push(`${at}: name_zh missing`);
    if (typeof d.oneLineSummary_zh !== "string" || !d.oneLineSummary_zh.trim()) errors.push(`${at}: oneLineSummary_zh missing`);
  });
  if (errors.length) return errors;
  for (const key of ["hookTreatment", "pacing", "structureEmphasis"]) {
    if (new Set(list.map((d) => d[key])).size < 3) errors.push(`the 3 directions must all differ in ${key} (got ${list.map((d) => d[key]).join(", ")})`);
  }
  const follows = list.filter((d) => d.followsStyleCard === true).length;
  if (card && follows !== 1) errors.push("followsStyleCard must be true for exactly one direction");
  return errors;
}

async function runDirections() {
  const effects = effectsText();
  const fixed = cardGuide?.v2 ? cardGuide.direction : null;
  const fixedText = fixed ? `DIRECTION 1 IS FIXED by the style card (do not change these fields; add name_zh, hookBeat, climaxBeat, why_zh, oneLineSummary_zh and followsStyleCard:true to it): ${JSON.stringify(fixed)}\nThe other two directions must differ from it AND from each other in hookTreatment, pacing and structureEmphasis, and have followsStyleCard:false.` : "";
  const user = [
    brandText, cardText, fixedText,
    `VOICEOVER BEATS:\n${linesText}`,
    `B-ROLL ASSETS (talking clips are not available as b-roll):\n${pool.map(assetLine).join("\n")}`,
    tendenciesText(library),
    `HOOK_TREATMENTS:\n${JSON.stringify(HOOK_TREATMENTS, null, 1)}`,
    `PACING PRESETS (max b-roll ratio per pacing): ${PACING_IDS.map((p) => `${p}=${PACING_PRESETS[p].maxBrollRatio}`).join(", ")}`,
    `EFFECTS (what the renderer can do):\n${effects}`,
  ].filter(Boolean).join("\n\n");
  if (dry) { console.log(`dry run: directions prompt ${DIRECTIONS_SYSTEM.length + user.length} chars, ${lines.length} beats, ${pool.length} assets`); return; }
  let feedback = null, result = null;
  const attempts = [];
  for (let attempt = 0; attempt <= 2; attempt++) {
    console.log(`director: asking ${settings.model} for 3 directions (attempt ${attempt + 1}/3)…`);
    const parts = [{ type: "text", text: feedback ? `${user}\n\nYour previous answer was rejected. Fix every error and answer again with the full JSON.\nPrevious answer:\n${feedback.answer}\nErrors:\n- ${feedback.errors.join("\n- ")}` : user }];
    const reply = await ask({ system: DIRECTIONS_SYSTEM, parts, schema: directionsSchema(), name: "directions" });
    if (fixed && Array.isArray(reply.answer?.directions)) { const k = reply.answer.directions.findIndex((d) => d.followsStyleCard === true); if (k >= 0) Object.assign(reply.answer.directions[k], fixed); } // the card's fields win, then the diversity check sees the real thing
    const errors = reply.answer ? checkDirections(reply.answer) : ["the answer was not valid JSON"];
    attempts.push({ errors });
    if (errors.length) { feedback = { answer: reply.text.slice(0, 3000), errors }; console.log(`  rejected:\n   - ${errors.join("\n   - ")}`); continue; }
    result = { directions: reply.answer.directions, model: reply.model };
    break;
  }
  if (!result) { console.error("director failed: no valid set of 3 directions"); process.exit(1); }
  if (fixed) { // the card's fields win over whatever the model wrote for the direction that follows it
    const follow = result.directions.findIndex((d) => d.followsStyleCard === true);
    if (follow >= 0) Object.assign(result.directions[follow], fixed);
  }
  const directions = result.directions.map((d) => ({ ...d, followsStyleCard: !!card && d.followsStyleCard === true, brollRatioTarget: Math.max(0.15, Math.min(d.followsStyleCard && cardGuide?.v2 ? cardGuide.presetOverrides.maxBrollRatio : PACING_PRESETS[d.pacing].maxBrollRatio, Number(d.brollRatioTarget) || 0.3)) }));
  await mkdir(path.dirname(analysisFile("x")), { recursive: true });
  await writeJson(analysisFile("directions.json"), { at: new Date().toISOString(), model: result.model, card: card ? card.id : null, attempts: attempts.length, directions });
  directions.forEach((d, n) => console.log(`${SLOTS[n]}: ${d.name_zh}｜${d.oneLineSummary_zh}`));
}

// ================================================================================================================
// stage 2: one plan per direction
// ================================================================================================================
const limitsFor = (direction) => {
  const l = { ...PACING_PRESETS[direction.pacing] };
  if (direction.followsStyleCard && cardGuide?.v2) {
    const o = cardGuide.presetOverrides ?? {};
    for (const k of ["noFullBrollBeforeMs", "noPipBeforeMs", "minShotMs", "maxShotMs", "maxBrollRatio", "maxStaticMs"]) if (Number.isFinite(o[k])) l[k] = o[k];
    l.noFullBrollBeforeMs = Math.max(2000, l.noFullBrollBeforeMs);
  } else if (direction.followsStyleCard && cardGuide) {
    const c = cardGuide.limits ?? {};
    if (c.minShotMs) { l.minShotMs = c.minShotMs; l.maxShotMs = c.maxShotMs ?? l.maxShotMs; }
    if (c.noBrollBeforeMs !== undefined) { l.noFullBrollBeforeMs = Math.max(2000, c.noBrollBeforeMs); l.noPipBeforeMs = c.noBrollBeforeMs; }
    if (c.maxBrollShare) l.maxBrollRatio = c.maxBrollShare;
  }
  return l;
};


const wordLine = (l) => `${l.id} (${secs(l.endMs - l.startMs)} s) "${l.text}"\n   words (index:text@startSeconds): ${(wordsOf[l.clip] ?? []).map((w, i) => (i >= l.wordStart && i <= l.wordEnd && !w.dropped ? `${i}:${w.text}@${secs(w.startMs)}` : null)).filter(Boolean).join(" ")}`;

async function loadDirections() {
  const stored = await readJson(analysisFile("directions.json"), null);
  if (!stored?.directions?.length) { console.error("no directions yet: run --stage=directions first"); process.exit(1); }
  return stored.directions;
}

// ---- validate + convert one answer ----------------------------------------------------------------------------
async function convert(answer, direction, limits, { final }) {
  const errors = [], warnings = [];
  const directions = await loadDirections();
  // splits
  const splits = {};
  for (const [n, s] of (answer.splits ?? []).entries()) {
    const line = lineById.get(baseId(s.beat));
    const at = `split ${n + 1} (${s.beat} word ${s.word})`;
    if (!line) { errors.push(`${at}: no such beat`); continue; }
    if (!Number.isInteger(s.word) || s.word <= line.wordStart || s.word > line.wordEnd) { errors.push(`${at}: word must be inside ${line.id} (${line.wordStart + 1}..${line.wordEnd})`); continue; }
    (splits[line.clip] ??= []).push(s.word);
  }
  for (const k of Object.keys(splits)) splits[k] = [...new Set(splits[k])].sort((a, b) => a - b);
  if (errors.length) return { errors };
  // beats as the model sees them (after its splits), then very short ones are joined with a neighbour here
  const asked = (await seedBeats(projectId, splits)).map((b) => b.id);
  const zoomAnswer = new Map();
  for (const z of answer.beats ?? []) {
    if (!asked.includes(z.beat)) { errors.push(`beats: "${z.beat}" is not a beat after your splits (${asked.join(", ")})`); continue; }
    if (z.zoom === "punch" || !ZOOM_IDS.includes(z.zoom)) errors.push(`beat ${z.beat} zoom "${z.zoom}" is not available (use ${ZOOM_IDS.join(", ")})`);
    else zoomAnswer.set(z.beat, z.zoom);
  }
  for (const id of asked) if (!zoomAnswer.has(id) && !errors.some((e) => e.includes(`beat ${id} zoom`))) errors.push(`beat ${id} missing zoom`);
  if (errors.length) return { errors };
  const joins = {};
  let beats = await seedBeats(projectId, splits, joins);
  for (let guard = 0; guard < 60; guard += 1) {
    const short = beats.findIndex((b, i) => beatLengthMs(b) < MIN_BEAT_MS && beats.some((o, k) => k !== i && o.voice.asset === b.voice.asset));
    if (short < 0) break;
    const b = beats[short], next = beats[short + 1];
    const cut = next && next.voice.asset === b.voice.asset ? next.voice.wordStart : b.voice.wordStart;
    if ((splits[b.voice.asset] ?? []).includes(cut)) splits[b.voice.asset] = splits[b.voice.asset].filter((n) => n !== cut);
    else (joins[b.voice.asset] ??= []).push(cut);
    beats = await seedBeats(projectId, splits, joins);
  }
  for (const b of beats) if (beatLengthMs(b) < MIN_BEAT_MS) errors.push(`beat "${b.text}" is only ${Math.round(beatLengthMs(b))} ms; remove a split so beats are at least ${MIN_BEAT_MS} ms`);
  const beatOf = (clipId, word) => beats.find((b) => b.voice.asset === clipId && word >= b.voice.wordStart && word <= b.voice.wordEnd);
  let offset = 0;
  for (const b of beats) { b.timelineStartMs = offset; b.lengthMs = Math.round(beatLengthMs(b) / frameMs) * frameMs; offset += b.lengthMs; b.zoomId = zoomAnswer.get(b.id) ?? zoomAnswer.get(asked.find((id) => baseId(id) === baseId(b.id))); b.zoom = ZOOM_SCALE[b.zoomId]; }
  const totalMs = offset;
  // shots
  const anchorClip = (beatId) => lineById.get(baseId(beatId))?.clip;
  let brollMs = 0;
  const shots = [...(answer.broll ?? [])].map((s) => ({ ...s }));
  for (const [n, s] of shots.entries()) {
    const label = `shot ${n + 1} (${s.asset} at ${s.beat} word ${s.word})`;
    const clipId = anchorClip(s.beat), words = wordsOf[clipId];
    if (!words) { errors.push(`${label}: unknown beat ${s.beat}`); continue; }
    if (!Number.isInteger(s.word) || s.word < 0 || s.word >= words.length) { errors.push(`${label}: word outside 0..${words.length - 1}`); continue; }
    if (words[s.word].dropped) { errors.push(`${label}: word ${s.word} was cut by the voice cleanup`); continue; }
    const item = poolById.get(s.asset);
    if (!item) { errors.push(`${label}: asset "${s.asset}" is not in the b-roll list (${[...poolById.keys()].join(", ")})`); continue; }
    if (!Number.isFinite(s.srcStartMs) || !Number.isFinite(s.durationMs)) { errors.push(`${label}: srcStartMs/durationMs must be numbers`); continue; }
    s.clip = clipId; s.layout = s.layout === "pip" ? "pip" : "full";
    const isEnd = endCards.some((c) => c.id === s.asset);
    if (s.layout === "pip" && !PIP_SLOTS.includes(s.slot)) errors.push(`${label}: pip needs "slot" from ${PIP_SLOTS.join(", ")}`);
    if (direction.layoutBias === "full" && s.layout === "pip") errors.push(`${label}: this direction uses full-screen shots only`);
    if (direction.layoutBias === "pip" && s.layout === "full" && !isEnd) errors.push(`${label}: this direction uses picture-in-picture (only the closing end card may be full-screen)`);
    if (s.durationMs < limits.minShotMs || s.durationMs > limits.maxShotMs) errors.push(`${label}: duration ${s.durationMs} ms is outside ${limits.minShotMs}-${limits.maxShotMs}`);
    if (s.srcStartMs < 0 || s.srcStartMs + s.durationMs > item.durationMs) errors.push(`${label}: source range ${s.srcStartMs}-${s.srcStartMs + s.durationMs} ms is outside ${s.asset} (0-${item.durationMs} ms)`);
    const beat = beatOf(clipId, s.word);
    if (!beat) { errors.push(`${label}: no beat contains that word`); continue; }
    const atMs = Math.max(0, Math.round(mapToBeatMs(beat, words[s.word].startMs)));
    const timelineAt = beat.timelineStartMs + atMs;
    const earliest = s.layout === "full" ? limits.noFullBrollBeforeMs : limits.noPipBeforeMs;
    if (timelineAt < earliest) errors.push(`${label}: ${s.layout} B-roll at ${Math.round(timelineAt)} ms; it may not start before ${earliest} ms (the creator must be visible first)`);
    if (atMs + s.durationMs > beat.lengthMs + 50) errors.push(`${label}: runs ${Math.round(atMs + s.durationMs - beat.lengthMs)} ms past the end of its beat ("${beat.text}", ${Math.round(beat.lengthMs)} ms). Shorten it, start it earlier, or split the beat.`);
    s._beat = beat; s._atMs = atMs; s._timelineAt = timelineAt;
    brollMs += s.durationMs;
  }
  for (const b of beats) {
    const mine = shots.filter((s) => s._beat === b).sort((x, y) => x._atMs - y._atMs);
    mine.forEach((s, k) => { if (k && mine[k - 1]._atMs + mine[k - 1].durationMs > s._atMs) errors.push(`shots in beat ${b.id} overlap: ${mine[k - 1].asset} and ${s.asset}`); });
  }
  if (brollMs > totalMs * limits.maxBrollRatio) errors.push(`b-roll covers ${Math.round((brollMs / totalMs) * 100)}% of the voiceover; the limit is ${Math.round(limits.maxBrollRatio * 100)}%`);
  const ratio = totalMs ? brollMs / totalMs : 0;
  // F7 end card
  const last = beats.at(-1);
  if (last && CTA.test(last.text) && endCards.length && !shots.some((s) => s._beat === last && endCards.some((c) => c.id === s.asset))) errors.push(`last beat ${last.id} is a call to action but the end card "${endCards[0].id}" is not used there`);
  // logo
  let logo = null;
  if (answer.logo) {
    const clipId = answer.logo.clip ?? anchorClip(answer.logo.beat);
    const word = answer.logo.word ?? answer.logo.atWord;
    const words = wordsOf[clipId];
    const beat = words && Number.isInteger(word) ? beatOf(clipId, word) : null;
    if (!beat) errors.push("logo: beat/word does not exist");
    else if (!cardGuide?.wantsLogo) errors.push('logo: the style card does not ask for a persistent logo; set "logo" to null');
    else logo = { beat: beat.id, atMs: Math.max(0, Math.round(mapToBeatMs(beat, words[word].startMs))), position: "top-left" };
  }
  // emphasis
  const emphasis = [];
  const perBeat = {};
  for (const e of answer.emphasis ?? []) {
    const clipId = anchorClip(e.beat), words = wordsOf[clipId];
    if (!words || !Number.isInteger(e.word) || e.word < 0 || e.word >= words.length || words[e.word].dropped) { errors.push(`emphasis: ${e.beat} word ${e.word} does not exist`); continue; }
    const beat = beatOf(clipId, e.word);
    if (!beat) { errors.push(`emphasis: no beat contains word ${e.word}`); continue; }
    if (e.color !== undefined && !COLOR_IDS.includes(e.color)) { errors.push(`emphasis: color "${e.color}" is not available (use ${COLOR_IDS.join(", ")})`); continue; }
    const text = words[e.word].text;
    if (FILLER.has(norm(text))) { errors.push(`emphasis: "${text}" in ${beat.id} is a filler word; emphasize the word that carries the meaning`); continue; }
    perBeat[beat.id] = (perBeat[beat.id] ?? 0) + 1;
    if (perBeat[beat.id] > 3) { errors.push(`emphasis: at most 3 words in beat ${beat.id}`); continue; }
    emphasis.push({ beat: beat.id, word: text, ...(COLOR_HEX[e.color ?? "default"] ? { color: COLOR_HEX[e.color] } : {}), colorId: e.color ?? "default" });
  }
  // brand claims (hard only when the order has a brief)
  for (const b of beats) for (const [re, why] of FORBIDDEN) if (re.test(b.text)) { if (brief) errors.push(`beat "${b.text}" contains a forbidden claim (${why}); the creator's line cannot be used as is`); else console.log(`  warning: "${b.text}" may break a brand claim rule (${why}); this order has no brief, so check it by hand`); }
  // ---- rhythm checks (F3, F4, F6) ----
  const covered = (b) => shots.some((s) => s._beat === b && s.layout === "full" && s.durationMs >= b.lengthMs * 0.7);
  const talking = beats.filter((b) => !covered(b));
  const soft = (message) => (final ? warnings.push(message) : errors.push(message));
  // F3: the longest stretch with no change (a b-roll in/out or a beat with another zoom)
  const changes = new Set([0, totalMs]);
  beats.forEach((b, i) => { if (i && b.zoomId !== beats[i - 1].zoomId) changes.add(b.timelineStartMs); });
  for (const s of shots) { changes.add(s._timelineAt); changes.add(s._timelineAt + s.durationMs); }
  const sorted = [...changes].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > limits.maxStaticMs + 50) {
    const at = (ms) => beats.findLast((b) => b.timelineStartMs <= ms + 1)?.id ?? "?";
    soft(`${at(sorted[i - 1])} → ${at(sorted[i] - 1)}: ${(Math.round(sorted[i] - sorted[i - 1]) / 1000).toFixed(1)}s without visual change (max ${(limits.maxStaticMs / 1000).toFixed(1)}s). Change the zoom on a beat or add B-roll.`);
  }
  // F4: zoom pattern
  const hookB = beats.find((b) => baseId(b.id) === direction.hookBeat), climaxB = beats.find((b) => baseId(b.id) === direction.climaxBeat) ?? hookB;
  if (direction.zoomPattern === "alternate" && limits.alternateZoom) {
    for (let i = 1; i < beats.length; i++) if (!covered(beats[i]) && !covered(beats[i - 1]) && beats[i].zoomId === beats[i - 1].zoomId) errors.push(`zoomPattern alternate but ${beats[i - 1].id} and ${beats[i].id} are both ${beats[i].zoomId}`);
  } else if (direction.zoomPattern === "peaks_only") {
    for (const b of talking) if (b.zoomId !== "z100" && baseId(b.id) !== direction.hookBeat && baseId(b.id) !== direction.climaxBeat) errors.push(`zoomPattern peaks_only but ${b.id} is ${b.zoomId}; only the hook beat and the climax beat may zoom`);
  } else if (direction.zoomPattern === "build_up" && climaxB) {
    const before = talking.filter((b) => b.timelineStartMs <= climaxB.timelineStartMs);
    for (let i = 1; i < before.length; i++) if (ZOOM_SCALE[before[i].zoomId] < ZOOM_SCALE[before[i - 1].zoomId]) errors.push(`zoomPattern build_up but ${before[i].id} (${before[i].zoomId}) is looser than ${before[i - 1].id} (${before[i - 1].zoomId}) before the climax`);
  }
  // F6: direction execution
  if (direction.hookTreatment === "creator_punch" && hookB && hookB.zoomId !== "z120") errors.push(`direction creator_punch but hook beat ${hookB.id} is ${hookB.zoomId} (use z120)`);
  if (direction.hookTreatment === "slow_tension" && hookB && !["z100", "z110"].includes(hookB.zoomId)) errors.push(`direction slow_tension but hook beat ${hookB.id} is ${hookB.zoomId} (start with z100 or z110)`);
  if (direction.hookTreatment === "pip_hook" && !shots.some((s) => s.layout === "pip" && s._timelineAt >= limits.noPipBeforeMs && s._timelineAt <= limits.noPipBeforeMs + 2000)) errors.push(`direction pip_hook but no pip B-roll starts between ${limits.noPipBeforeMs} and ${limits.noPipBeforeMs + 2000} ms`);
  if (direction.hookTreatment === "color_hook" && hookB) {
    const strong = emphasis.filter((e) => e.beat === hookB.id && e.colorId !== "default").length;
    if (strong < 2) errors.push(`direction color_hook but hook beat ${hookB.id} has ${strong} strongly coloured emphasis word(s) (need 2-3, color other than default)`);
    if (!["z100", "z110"].includes(hookB.zoomId)) errors.push(`direction color_hook but hook beat ${hookB.id} is ${hookB.zoomId} (use z100 or z110)`);
  }
  if (Math.abs(ratio - direction.brollRatioTarget) > 0.1 && !(ratio < direction.brollRatioTarget && brollMs >= pool.reduce((t, i) => t + i.durationMs, 0) * 0.9)) soft(`B-roll ratio is ${ratio.toFixed(2)}, the direction aims for ${direction.brollRatioTarget} (±0.1)`);
  void directions;
  if (errors.length) return { errors };
  for (const b of beats) {
    const mine = shots.filter((s) => s._beat === b).sort((x, y) => x._atMs - y._atMs);
    b.broll = mine.map((s, k) => ({ id: `${b.id}-${k + 1}`, asset: s.asset, srcStartMs: Math.round(s.srcStartMs), atMs: s._atMs, durationMs: Math.round(s.durationMs), layout: s.layout, ...(s.layout === "pip" ? { slot: s.slot } : {}), note: String(s.reason_zh ?? "").slice(0, 200) }));
    delete b.timelineStartMs; delete b.lengthMs; delete b.zoomId;
  }
  return { beats, emphasis: emphasis.map(({ colorId, ...e }) => e), logo, warnings, ratio, errors: [] };
}

async function runPlan(slot, extraFeedback = null) {
  const index = SLOTS.indexOf(slot);
  if (index < 0) { console.error("--slot must be a, b or c"); process.exit(1); }
  const directions = await loadDirections();
  const direction = directions[index];
  if (!direction) { console.error(`no direction ${index + 1}`); process.exit(1); }
  const limits = limitsFor(direction);
  // examples: the card's own segments for the plan that follows the card, the whole library for the others
  let examples = library.length ? retrieveExamples(beatsForRetrieval, library, { cardId: direction.followsStyleCard && card ? card.id : null, productType: card?.meta?.productType ?? null }) : {};
  if (!Object.keys(examples).length && library.length) examples = retrieveExamples(beatsForRetrieval, library, { productType: card?.meta?.productType ?? null });
  const examplesBlock = examplesText(beatsForRetrieval, examples);
  if (args.includes("--show-examples")) console.log(examplesBlock || "(no examples)");
  const system = fill(PLAN_SYSTEM, { ...limits, brollRatioTarget: direction.brollRatioTarget });
  const others = directions.filter((_, k) => k !== index).map((d) => `- ${d.name_zh}: ${d.oneLineSummary_zh}`).join("\n");
  const head = [
    `DIRECTION:\n${JSON.stringify(direction, null, 1)}`,
    `OTHER DIRECTIONS (your plan must look different from these):\n${others}`,
    `PACING (numbers used by the checker): ${JSON.stringify(limits)}`,
    brandText, cardText,
    direction.followsStyleCard && cardGuide?.v2 && cardGuide.timeline?.length ? `WORKED EXAMPLE — how the reference video was cut, in plan terms (copy its rhythm and structure, never its content; translate every role to this product):\n${cardGuide.timeline.map((t) => `${(t.startMs / 1000).toFixed(1)}-${(t.endMs / 1000).toFixed(1)}s ${t.role} ${t.visual}${t.layout ? "/" + t.layout : ""}${t.zoom ? " " + t.zoom : ""}${t.assetType ? " " + t.assetType : ""}: ${t.what_zh}`).join("\n")}` : "",
    `BEATS (id, length, text, then word index:word@seconds):\n${lines.map(wordLine).join("\n")}`,
    examplesBlock,
    `EFFECTS (only these ids exist):\n${effectsText()}`,
    endCards.length ? `END CARD assets (use one on a closing call-to-action beat): ${endCards.map((c) => c.id).join(", ")}` : "",
    "B-ROLL ASSETS (talking clips are not available as b-roll). Each is followed by a picture strip of 8 frames; the time marks are the frame centres:",
  ].filter(Boolean).join("\n\n");
  const buildParts = async (feedback) => {
    const parts = [{ type: "text", text: head }];
    for (const item of pool) {
      parts.push({ type: "text", text: `${assetLine(item)} Strip frames at t = ${Array.from({ length: STRIPS }, (_, k) => secs(((k + 0.5) / STRIPS) * item.durationMs)).join(", ")} s.` });
      parts.push({ type: "image", mediaType: "image/jpeg", data: (await readFile(await stripFor(item))).toString("base64") });
    }
    if (feedback) parts.push({ type: "text", text: `Your previous answer was rejected by the checker. Fix every error and answer again with the full JSON.\nPrevious answer:\n${feedback.answer}\nErrors:\n- ${feedback.errors.join("\n- ")}` });
    return parts;
  };
  if (dry) { const parts = await buildParts(null); console.log(`dry run slot ${slot}: ${parts.filter((p) => p.type === "image").length} images, ${system.length + parts.filter((p) => p.type === "text").reduce((s, p) => s + p.text.length, 0)} chars, ${pool.length} assets`); return; }
  const schema = planSchema({ assetIds: pool.map((i) => i.id) });
  let feedback = extraFeedback, result = null, raw = "";
  const attempts = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    console.log(`director ${slot} (${direction.name_zh}): asking ${settings.model} (attempt ${attempt + 1}/${maxRetries + 1})…`);
    const reply = await ask({ system, parts: await buildParts(feedback), schema, name: "plan" });
    raw = reply.text;
    if (!reply.answer) { feedback = { answer: raw.slice(0, 1500), errors: ["the answer was not valid JSON; reply with exactly one JSON object"] }; attempts.push({ errors: feedback.errors }); console.log("  rejected: not JSON"); continue; }
    const converted = await convert(reply.answer, direction, limits, { final: attempt === maxRetries });
    attempts.push({ errors: converted.errors });
    if (converted.errors.length) { feedback = { answer: JSON.stringify(reply.answer), errors: converted.errors }; console.log(`  rejected: ${converted.errors.length} error(s)\n   - ${converted.errors.join("\n   - ")}`); continue; }
    result = { ...converted, notes: String(reply.answer.notes_zh ?? ""), model: reply.model, answer: reply.answer };
    break;
  }
  await mkdir(path.dirname(analysisFile("x")), { recursive: true });
  await writeJson(analysisFile(`director-log.${slot}.json`), { at: new Date().toISOString(), model: settings.model, ok: !!result, direction: direction.name_zh, attempts, lastAnswer: raw.slice(0, 6000) });
  if (!result) { console.error(`director failed: the answers for direction ${slot} did not pass the checks (see projects/<id>/analysis/director-log.${slot}.json)`); process.exit(1); }
  await writeJson(cutFile(slot), { schemaVersion: 2, projectId, scriptId: "creator", status: "draft", builtAt: new Date().toISOString(), fps: FPS,
    director: { slot, direction, model: result.model, at: new Date().toISOString(), notes: result.notes, attempts: attempts.length, warnings: result.warnings, brollRatio: Number(result.ratio.toFixed(2)), styleCard: direction.followsStyleCard && card ? { id: card.id, name: card.name } : null, examples: Object.values(examples).reduce((n, list) => n + list.length, 0), answer: result.answer },
    note: "Beats from the creators' proofread transcripts; zoom, b-roll and emphasis proposed by the auto director and validated by code. Review in the desk.",
    beats: result.beats.map((b) => ({ ...b, zoom: b.zoom })), emphasis: result.emphasis, ...(result.logo ? { logo: result.logo } : {}) });
  const shotCount = result.beats.reduce((s, b) => s + b.broll.length, 0);
  console.log(`director ${slot}: ${result.beats.length} beats, ${shotCount} b-roll shots, ratio ${result.ratio.toFixed(2)} -> ${path.relative(root, cutFile(slot))}`);
  for (const b of result.beats) console.log(`${b.id} z${Math.round(b.zoom * 100)} "${b.text}"${b.broll.map((s) => `\n    + ${s.asset} ${s.layout} src ${s.srcStartMs}ms @${s.atMs}ms for ${s.durationMs}ms  ${s.note}`).join("")}`);
  for (const w of result.warnings ?? []) console.log(`  warning: ${w}`);
  if (result.notes) console.log(`notes: ${result.notes}`);
}

// ================================================================================================================
// stage 3: the three plans must differ
// ================================================================================================================
async function runCompare() {
  const cuts = {};
  for (const slot of SLOTS) { const cut = await readJson(cutFile(slot), null); if (cut?.beats) cuts[slot] = cut; }
  const slots = Object.keys(cuts);
  if (slots.length < 2) { console.log("compare: fewer than two plans, nothing to compare"); return; }
  const pairs = [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const s = similarity(cuts[slots[i]], cuts[slots[j]]);
    pairs.push({ a: slots[i], b: slots[j], ...s, bad: s.sameZoom > 0.7 || s.overlap > 0.6 || s.sameHook });
    console.log(`compare ${slots[i]}/${slots[j]}: same zoom ${Math.round(s.sameZoom * 100)}%, b-roll overlap ${Math.round(s.overlap * 100)}%, same hook ${s.sameHook}`);
  }
  const bad = pairs.filter((p) => p.bad);
  if (!bad.length) { console.log("compare: the plans are different enough"); return; }
  const score = Object.fromEntries(slots.map((s) => [s, 0]));
  for (const p of pairs) { const v = p.sameZoom + p.overlap + (p.sameHook ? 1 : 0); score[p.a] += v; score[p.b] += v; }
  const worst = slots.filter((s) => bad.some((p) => p.a === s || p.b === s)).sort((x, y) => score[y] - score[x])[0];
  const partner = bad.find((p) => p.a === worst || p.b === worst);
  const other = partner.a === worst ? partner.b : partner.a;
  const why = [];
  if (partner.sameZoom > 0.7) why.push(`same zoom on ${Math.round(partner.sameZoom * 100)}% of the words`);
  if (partner.overlap > 0.6) why.push(`B-roll overlaps ${Math.round(partner.overlap * 100)}%`);
  if (partner.sameHook) why.push("the hook beat is treated the same way");
  const directions = await loadDirections();
  const error = `Too similar to plan "${directions[SLOTS.indexOf(other)]?.name_zh ?? other}": ${why.join("; ")}. Make the hook and zoom pattern clearly different.`;
  console.log(`compare: plan ${worst} is asked again — ${error}`);
  await runPlan(worst, { answer: JSON.stringify(cuts[worst].director?.answer ?? {}), errors: [error] });
}

if (stage === "directions") await runDirections();
else if (stage === "plan") await runPlan(opt("slot", "a"));
else await runCompare();

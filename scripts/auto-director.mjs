// Auto director: choose which b-roll goes where, from the catalog descriptions, key frames and the proofread
// transcripts, using the model configured in 「API 设置」. Code does everything that can be checked.
//
//   node scripts/auto-director.mjs <projectId> [--variant=full|minimal|pip] [--card=<style card id>] [--out=cut-script.json] [--retries=2] [--dry]
//
// The model only proposes: extra beat split points, b-roll shots anchored to a word of the creator's speech
// (clip + word index), and caption emphasis words. Everything else — cut points, frame snapping, timing
// inside the beat, source ranges, overlap, share of b-roll, forbidden claims — is computed or validated here;
// invalid answers are sent back to the model with the exact errors (up to --retries times). Output is a
// v2 cut script (docs/cut-script.md) with status "draft"; compile it with scripts/compile-cut-script.mjs.
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readCatalog } from "../desk/server/catalog.mjs";
import { callModel, readApiSettings } from "../desk/server/settings.mjs";
import { publicDir, root } from "./lib/media.mjs";
import { FORBIDDEN } from "./lib/claims.mjs";
import { FPS, beatLengthMs, loadClips, mapToBeatMs, seedBeats } from "./lib/beats.mjs";
import { directorGuide, parseCard } from "./lib/style-card.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
if (!projectId) { console.error("Usage: node scripts/auto-director.mjs <projectId> [--out=cut-script.json] [--retries=2] [--dry]"); process.exit(1); }
const dir = path.join(root, "projects", projectId);
// Styles ("variants"): default = follow the style card if one is given; full = full-screen cutaways only; pip = follow
// the style card exactly (needs --card); minimal = creator first, only a few strong cutaways.
const variant = opt("variant", "default");
if (!["default", "full", "pip", "minimal"].includes(variant)) { console.error(`Unknown --variant "${variant}"`); process.exit(1); }
const outFile = path.join(dir, opt("out", variant === "default" ? "cut-script.json" : `cut-script.${variant}.json`));
const maxRetries = Number(opt("retries", "2"));
const dry = args.includes("--dry");
const frameMs = 1000 / FPS;

const LIMITS = { minShotMs: 600, maxShotMs: 3500, maxBrollShare: 0.65, noBrollBeforeMs: 2000, minBeatMs: 1200, maxEmphasis: 6 };
const PIP_SLOTS = ["top-left", "top-right", "lower-left", "lower-right"];

// The style card the editor confirmed in the 风格库 page (--card=<id>): its one-line rules go into the prompt and its numbers
// tighten/loosen the limits above. "full" and "minimal" ignore the card; "pip" and "default" follow it. No card, no guide.
const cardId = opt("card", "");
let card = null;
if (cardId) {
  const raw = await readJson(path.join(root, "library", "style-cards", `${cardId}.json`), null);
  card = raw ? parseCard(raw) : null;
  if (!card || card.status !== "confirmed") { console.error(`style card "${cardId}" does not exist or is not confirmed (风格库 page)`); process.exit(3); }
}
if (variant === "full" || variant === "minimal") card = null;
if (variant === "pip" && !card) { console.error("variant pip needs a confirmed style card (--card=<id>)"); process.exit(3); }
const cardGuide = card ? directorGuide(card) : null;
const allowsPip = !!cardGuide?.allowsPip, wantsLogo = !!cardGuide?.wantsLogo;
if (cardGuide) Object.assign(LIMITS, cardGuide.limits);
if (variant === "minimal") Object.assign(LIMITS, { maxBrollShare: 0.25, noBrollBeforeMs: 3000, minShotMs: 800, maxShotMs: 2200 });
const variantNote = variant === "minimal" ? "VARIANT: minimal, creator-first. Give b-roll only to the two or three moments where a picture adds the most (the product/theme being named, the call to action). Everything else stays on the creator." : variant === "full" ? "VARIANT: full-screen cutaways only. Use layout \"full\" for every shot and no logo." : "";
const guide = cardGuide?.text ?? "";

// An empty or unreadable leftover (an interrupted earlier run) is not something to protect: it gets replaced.
const existing = (await stat(outFile).catch(() => null)) ? await readJson(outFile).catch(() => null) : null;
if (existing && existing.status !== "draft") { console.error(`${path.basename(outFile)} is not a draft; refusing to overwrite`); process.exit(1); }

const catalog = await readCatalog(projectId);
const brief = await readJson(path.join(dir, "brief.json"), null);
const clips = await loadClips(projectId);
if (!clips.length) { console.error("No creator clip with speech and an .edited transcript (run order:transcribe and order:sync-text first)"); process.exit(1); }
const unconfirmed = catalog.items.filter((i) => i.counted && !i.confirmed);
if (unconfirmed.length) console.error(`warning: ${unconfirmed.length} catalog item(s) not confirmed yet: ${unconfirmed.map((i) => i.id).join(", ")}`);

// ---- b-roll candidates: every confirmed/unconfirmed video that is not a talking clip or a transcript --------
const pool = catalog.items.filter((i) => i.type === "video" && ["screen", "official", "action"].includes(i.category) && i.durationMs);
const ingest = await readJson(path.join(dir, "ingest.json"));
const facts = new Map(ingest.assets.map((a) => [a.id, a]));

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

// ---- prompt ---------------------------------------------------------------------------------------------------
const system = `You are the editing director for a TikTok e-commerce UGC video (vertical 9:16, English voice-over by a creator).
The creator's speech is already recorded and fixed. You decide only: (1) where to start extra beats inside long sentences, (2) which b-roll clip to show over which words, (3) which words get caption emphasis.
Rules:
- B-roll are muted cutaways laid over the creator while her voice continues. Use only the listed b-roll assets, with srcStartMs inside the asset.
- Match pictures to meaning: show a theme/keyboard clip when the words talk about fonts, themes, stickers, typing or the product; keep the creator on screen for the hook and for emotional or personal lines.
- The video opens on the creator: no b-roll in the first ${LIMITS.noBrollBeforeMs / 1000} s of the video. Each shot lasts ${LIMITS.minShotMs}-${LIMITS.maxShotMs} ms. B-roll may cover at most ${Math.round(LIMITS.maxBrollShare * 100)}% of the total speech time. Shots must not overlap and must end inside the beat that contains their first word.
- A shot is anchored to a word: "clip" + "atWord" (index in that clip's word list). It starts when that word starts. If a clip's last words are a call to action and an end card exists in a b-roll clip (e.g. app icon with a download button), end on it.
- Beats: every line of the creator's text is one beat. Add "splits" (word indexes where a NEW beat starts) only inside very long lines so each beat is about 1.5-6 s and ends at a natural phrase break. Never split inside a phrase.
- Never use b-roll that contradicts the words, shows competitors, or looks blurry; low-resolution clips (see "size") can be used but will be shown small, so prefer others when equal.
- Layout: every shot has "layout": "full" (covers the creator) or "pip" (a small picture-in-picture window; the creator stays visible and her face is never covered). Use "pip" only if the STYLE GUIDE below asks for picture-in-picture, otherwise use "full". A pip shot needs "slot": one of ${PIP_SLOTS.join(", ")}. The share limit applies to "full" shots only.
- Optional "logo": {"clip":"<clipId>","atWord":<int>} puts the brand logo in the top-left corner from that word until the end. Use it only if the STYLE GUIDE asks for a persistent brand icon, and only after the product name is spoken; otherwise "logo": null.
- Do not invent product claims; you do not write any text, only choose pictures and timing.
Answer with ONE JSON object and nothing else:
{"splits":{"<clipId>":[<wordIndex>,...]},"shots":[{"clip":"<clipId>","atWord":<int>,"asset":"<assetId>","srcStartMs":<int>,"durationMs":<int>,"layout":"full|pip","slot":"<only for pip>","why":"<short reason, Chinese>"}],"logo":null,"emphasis":[{"clip":"<clipId>","word":<wordIndex>}],"notes":"<one or two sentences in Chinese for the editor>"}`;

const secs = (ms) => (ms / 1000).toFixed(2);
const clipText = clips.map(({ clip, words, lines }) => `CLIP ${clip.id} (${secs(clip.durationMs)} s, creator: ${clip.creator?.name ?? "?"})\nlines: ${lines.map((l) => `"${l.text}"`).join(" / ")}\nwords (index:text@startSeconds): ${words.map((w, i) => (w.dropped ? null : `${i}:${w.text}@${secs(w.startMs)}`)).filter(Boolean).join(" ")}`).join("\n\n");
const poolText = pool.map((i) => {
  const f = facts.get(i.id);
  return `ASSET ${i.id}: ${secs(i.durationMs)} s, size ${f?.width}x${f?.height}, category ${i.category}. ${i.description} tags: ${(i.tags ?? []).join(", ")}. The picture strip below shows ${STRIPS} frames at t = ${Array.from({ length: STRIPS }, (_, k) => secs(((k + 0.5) / STRIPS) * i.durationMs)).join(", ")} s.`;
});
const brandText = brief ? `Brand: ${brief.product?.name}. Allowed claims: ${brief.product?.claimsAllowed?.join("; ")}. Forbidden: ${brief.product?.claimsForbidden?.join("; ")}. Restrictions: ${brief.restrictions?.join("; ")}.` : "";

const buildParts = async (feedback) => {
  const parts = [{ type: "text", text: `${brandText}${guide ? `\n\n${guide}` : ""}${variantNote ? `\n\n${variantNote}` : ""}\n\n${clipText}\n\nB-ROLL ASSETS (talking clips are not available as b-roll):` }];
  for (let k = 0; k < pool.length; k++) {
    parts.push({ type: "text", text: poolText[k] });
    parts.push({ type: "image", mediaType: "image/jpeg", data: (await readFile(await stripFor(pool[k]))).toString("base64") });
  }
  if (feedback) parts.push({ type: "text", text: `Your previous answer was rejected by the validator. Fix every error and answer again with the full JSON.\nPrevious answer:\n${feedback.answer}\nErrors:\n- ${feedback.errors.join("\n- ")}` });
  return parts;
};

if (dry) { const parts = await buildParts(null); console.log(`dry run: ${parts.filter((p) => p.type === "image").length} images, ${parts.filter((p) => p.type === "text").reduce((s, p) => s + p.text.length, 0)} chars of text, ${pool.length} b-roll assets, ${clips.length} clips`); process.exit(0); }

// ---- validate + convert ---------------------------------------------------------------------------------
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
async function convert(answer) {
  const errors = [];
  const wordsOf = Object.fromEntries(clips.map((c) => [c.clip.id, c.words]));
  const poolById = new Map(pool.map((i) => [i.id, i]));
  const splits = {};
  for (const [clipId, list] of Object.entries(answer.splits ?? {})) {
    if (!wordsOf[clipId]) { errors.push(`splits: unknown clip "${clipId}"`); continue; }
    for (const idx of list) if (!Number.isInteger(idx) || idx < 1 || idx >= wordsOf[clipId].length) errors.push(`splits: word index ${idx} is outside ${clipId} (1..${wordsOf[clipId].length - 1})`);
    splits[clipId] = [...new Set(list)].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  }
  if (errors.length) return { errors };
  // A creator sentence that is shorter than minBeatMs on its own cannot be fixed by the model: join it with its neighbour here.
  const joins = {};
  let beats = await seedBeats(projectId, splits, joins);
  for (let guard = 0; guard < 60; guard += 1) {
    const short = beats.findIndex((b, i) => beatLengthMs(b) < LIMITS.minBeatMs && beats.some((o, k) => k !== i && o.voice.asset === b.voice.asset));
    if (short < 0) break;
    const b = beats[short], next = beats[short + 1];
    const cut = next && next.voice.asset === b.voice.asset ? next.voice.wordStart : b.voice.wordStart; // the split that separates it from the next (or, for the last one, from the previous) beat
    if ((splits[b.voice.asset] ?? []).includes(cut)) splits[b.voice.asset] = splits[b.voice.asset].filter((n) => n !== cut);
    else (joins[b.voice.asset] ??= []).push(cut);
    beats = await seedBeats(projectId, splits, joins);
  }
  for (const b of beats) if (beatLengthMs(b) < LIMITS.minBeatMs) errors.push(`beat "${b.text}" is only ${Math.round(beatLengthMs(b))} ms; remove a split so beats are at least ${LIMITS.minBeatMs} ms`);
  const beatOf = (clipId, word) => beats.find((b) => b.voice.asset === clipId && word >= b.voice.wordStart && word <= b.voice.wordEnd);
  // timeline offset of each beat (for the "first 2 s" rule and the share rule)
  let offset = 0;
  for (const b of beats) { b.timelineStartMs = offset; offset += Math.round(beatLengthMs(b) / frameMs) * frameMs; }
  const totalMs = offset;
  let brollMs = 0;
  const shots = [...(answer.shots ?? [])];
  for (const [n, s] of shots.entries()) {
    const label = `shot ${n + 1} (${s.asset} at ${s.clip} word ${s.atWord})`;
    const words = wordsOf[s.clip];
    if (words?.[s.atWord]?.dropped) { errors.push(`${label}: word ${s.atWord} was cut by the voice cleanup`); continue; }
    if (!words) { errors.push(`${label}: unknown clip`); continue; }
    if (!Number.isInteger(s.atWord) || s.atWord < 0 || s.atWord >= words.length) { errors.push(`${label}: atWord outside 0..${words.length - 1}`); continue; }
    const item = poolById.get(s.asset);
    if (!item) { errors.push(`${label}: asset "${s.asset}" is not in the b-roll list (${[...poolById.keys()].join(", ")})`); continue; }
    if (!Number.isFinite(s.srcStartMs) || !Number.isFinite(s.durationMs)) { errors.push(`${label}: srcStartMs/durationMs must be numbers`); continue; }
    s.layout = s.layout === "pip" ? "pip" : "full";
    if (s.layout === "pip" && !PIP_SLOTS.includes(s.slot)) errors.push(`${label}: pip needs "slot" from ${PIP_SLOTS.join(", ")}`);
    if (s.layout === "pip" && !allowsPip) errors.push(`${label}: the style card does not use picture-in-picture; use layout "full"`);
    if (s.durationMs < LIMITS.minShotMs || s.durationMs > LIMITS.maxShotMs) errors.push(`${label}: duration ${s.durationMs} ms is outside ${LIMITS.minShotMs}-${LIMITS.maxShotMs}`);
    if (s.srcStartMs < 0 || s.srcStartMs + s.durationMs > item.durationMs) errors.push(`${label}: source range ${s.srcStartMs}-${s.srcStartMs + s.durationMs} ms is outside ${s.asset} (0-${item.durationMs} ms)`);
    const beat = beatOf(s.clip, s.atWord);
    if (!beat) { errors.push(`${label}: no beat contains that word`); continue; }
    const beatFrames = Math.round(beatLengthMs(beat) / frameMs);
    const atMs = Math.max(0, Math.round(mapToBeatMs(beat, words[s.atWord].startMs)));
    if (beat.timelineStartMs + atMs < LIMITS.noBrollBeforeMs) errors.push(`${label}: starts at ${Math.round(beat.timelineStartMs + atMs)} ms of the video; the first ${LIMITS.noBrollBeforeMs} ms must stay on the creator`);
    if (atMs + s.durationMs > beatFrames * frameMs + 50) errors.push(`${label}: runs ${Math.round(atMs + s.durationMs - beatFrames * frameMs)} ms past the end of its beat ("${beat.text}", ${Math.round(beatFrames * frameMs)} ms). Shorten it, start it earlier, or split the beat.`);
    s._beat = beat; s._atMs = atMs;
    if (s.layout === "full") brollMs += s.durationMs;
  }
  // overlaps
  for (const b of beats) {
    const mine = shots.filter((s) => s._beat === b).sort((x, y) => x._atMs - y._atMs);
    mine.forEach((s, k) => { if (k && mine[k - 1]._atMs + mine[k - 1].durationMs > s._atMs) errors.push(`shots in beat "${b.text}" overlap: ${mine[k - 1].asset} and ${s.asset}`); });
  }
  if (brollMs > totalMs * LIMITS.maxBrollShare) errors.push(`b-roll covers ${Math.round((brollMs / totalMs) * 100)}% of the video; the limit is ${Math.round(LIMITS.maxBrollShare * 100)}%`);
  let logo = null;
  if (answer.logo) {
    const words = wordsOf[answer.logo.clip];
    const beat = words && Number.isInteger(answer.logo.atWord) ? beatOf(answer.logo.clip, answer.logo.atWord) : null;
    if (!beat) errors.push("logo: clip/word does not exist");
    else if (!wantsLogo) errors.push('logo: the style card does not ask for a persistent logo; set "logo" to null');
    else logo = { beat: beat.id, atMs: Math.max(0, Math.round(mapToBeatMs(beat, words[answer.logo.atWord].startMs))), position: "top-left" };
  }
  const emphasis = [];
  for (const e of answer.emphasis ?? []) {
    const words = wordsOf[e.clip];
    if (!words || !Number.isInteger(e.word) || e.word < 0 || e.word >= words.length) { errors.push(`emphasis: ${e.clip} word ${e.word} does not exist`); continue; }
    const beat = beatOf(e.clip, e.word);
    emphasis.push({ beat: beat.id, word: words[e.word].text });
  }
  if (emphasis.length > LIMITS.maxEmphasis) errors.push(`emphasis: at most ${LIMITS.maxEmphasis} words`);
  // Brand claim rules come from the order's brief; without one (no brief.json) a hit is only a warning for the editor.
  for (const b of beats) for (const [re, why] of FORBIDDEN) if (re.test(b.text)) { if (brief) errors.push(`beat "${b.text}" contains a forbidden claim (${why}); the creator's line cannot be used as is`); else console.log(`  warning: "${b.text}" may break a brand claim rule (${why}); this order has no brief, so check it by hand`); }
  if (errors.length) return { errors };
  for (const b of beats) {
    const mine = shots.filter((s) => s._beat === b).sort((x, y) => x._atMs - y._atMs);
    b.broll = mine.map((s, k) => ({ id: `${b.id}-${k + 1}`, asset: s.asset, srcStartMs: Math.round(s.srcStartMs), atMs: s._atMs, durationMs: Math.round(s.durationMs), layout: s.layout, ...(s.layout === "pip" ? { slot: s.slot } : {}), note: String(s.why ?? "").slice(0, 200) }));
  }
  return { beats, emphasis, logo, errors: [] };
}

// ---- ask the model ---------------------------------------------------------------------------------------
const settings = await readApiSettings();
if (!settings.apiKey) { console.error("No API key saved (设置 → API 设置)."); process.exit(1); }
const callSettings = { ...settings, maxTokens: Math.max(settings.maxTokens, 8000), timeoutSec: Math.max(settings.timeoutSec, 180) };
let feedback = null;
let result = null;
let raw = "";
const attempts = [];
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  console.log(`director: asking ${settings.model} (attempt ${attempt + 1}/${maxRetries + 1}, ${pool.length} b-roll assets, ${clips.length} clips)…`);
  const reply = await callModel({ system, parts: await buildParts(feedback), settings: callSettings });
  raw = reply.text;
  let answer;
  try { answer = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? ""); } catch { feedback = { answer: raw.slice(0, 1500), errors: ["the answer was not valid JSON; reply with exactly one JSON object"] }; attempts.push({ errors: feedback.errors }); console.log("  rejected: not JSON"); continue; }
  const converted = await convert(answer);
  attempts.push({ errors: converted.errors });
  if (converted.errors.length) { feedback = { answer: JSON.stringify(answer), errors: converted.errors }; console.log(`  rejected: ${converted.errors.length} error(s)\n   - ${converted.errors.join("\n   - ")}`); continue; }
  result = { ...converted, notes: String(answer.notes ?? ""), model: reply.model, answer };
  break;
}
await mkdir(path.join(dir, "analysis"), { recursive: true });
await writeJson(path.join(dir, "analysis", variant === "default" ? "director-log.json" : `director-log.${variant}.json`), { at: new Date().toISOString(), model: settings.model, baseUrl: settings.baseUrl, ok: !!result, attempts, lastAnswer: raw.slice(0, 6000) });
if (!result) { console.error("director failed: the model's answers did not pass validation (see projects/<id>/analysis/director-log.json)"); process.exit(1); }

await writeJson(outFile, { schemaVersion: 2, projectId, scriptId: "creator", status: "draft", builtAt: new Date().toISOString(), fps: FPS,
  director: { variant, model: result.model, at: new Date().toISOString(), notes: result.notes, attempts: attempts.length, styleCard: card ? { id: card.id, name: card.name } : null },
  note: "Beats from the creators' proofread transcripts; b-roll and emphasis proposed by the auto director and validated by code. Review in the desk.",
  beats: result.beats, emphasis: result.emphasis, ...(result.logo ? { logo: result.logo } : {}) });
const shotCount = result.beats.reduce((s, b) => s + b.broll.length, 0);
console.log(`director: ${result.beats.length} beats, ${shotCount} b-roll shots, ${result.emphasis.length} emphasis words -> ${path.relative(root, outFile)}`);
for (const b of result.beats) console.log(`${b.id} "${b.text}"${b.broll.map((s) => `\n    + ${s.asset} src ${s.srcStartMs}ms @${s.atMs}ms for ${s.durationMs}ms  ${s.note}`).join("")}`);
if (result.notes) console.log(`notes: ${result.notes}`);

// Style card self-test (风格库优化 v1, section 5): cut the reference video's OWN voice-over with this card and compare the result with
// how the reference was really cut.
//
//   node scripts/style-card-selftest.mjs <cardId>
//
// The reference's transcript becomes the voice-over, its own cutaways become the b-roll "assets" (text descriptions only; this stays
// inside library/ and never reaches a video), the card's direction and rules are the only guidance — the reference timeline itself is
// NOT shown to the model (that would be copying). The plan is compared with the card's `timeline` at 100 ms steps:
//   brollOverlap  share of cutaway time that coincides with the reference's cutaways
//   zoomSame      share of talking time with the same zoom step
//   brollRatio    plan vs reference
// The numbers are stored in the card (selfTest) and shown on the card page as 复现度. Approximate: the plan is not run through the
// director's full validator (no real assets, no cleanup).
import path from "node:path";
import { callModel, readApiSettings } from "../desk/server/settings.mjs";
import { root } from "./lib/media.mjs";
import { PLAN_SYSTEM, fill } from "./lib/director-prompts.mjs";
import { PACING_PRESETS, effectsText, planSchema } from "./lib/effects.mjs";
import { directorGuide, parseCard } from "./lib/style-card.mjs";
import { isV2 } from "./lib/style-card.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const cardId = process.argv[2];
if (!cardId) { console.error("Usage: node scripts/style-card-selftest.mjs <cardId>"); process.exit(1); }
const file = path.join(root, "library", "style-cards", `${cardId}.json`);
const card = parseCard(await readJson(file));
if (!isV2(card)) { console.error("only v2 cards can be self-tested (re-analyse the reference: 风格库 → 重新拆解)"); process.exit(1); }
const analysis = await readJson(path.join(root, "library", "references", card.source.referenceId, "analysis.json"), null);
if (!analysis?.transcript?.words?.length) { console.log("self-test skipped: the reference has no transcript"); process.exit(0); }
const settings = await readApiSettings();
if (!settings.apiKey) { console.error("No API key saved."); process.exit(1); }

// ---- the voice-over: sentences of the reference transcript ------------------------------------------------------------------
const words = analysis.transcript.words;
const lines = [];
let start = 0;
words.forEach((w, i) => { if (/[.!?]$/.test(w.text) || i === words.length - 1) { lines.push({ id: `b${String(lines.length + 1).padStart(2, "0")}`, wordStart: start, wordEnd: i, startMs: words[start].startMs, endMs: w.endMs, text: words.slice(start, i + 1).map((x) => x.text).join(" ") }); start = i + 1; } });
const secs = (ms) => (ms / 1000).toFixed(2);
// ---- the reference's own cutaways as assets -----------------------------------------------------------------------------------
const refBroll = card.timeline.filter((s) => s.visual === "broll" || s.layout === "pip");
const assets = refBroll.map((s, i) => ({ id: `ref-${i + 1}`, durationMs: s.endMs - s.startMs, text: `ASSET ref-${i + 1}: ${secs(s.endMs - s.startMs)} s, category screen, ${s.assetType ?? "other"}. ${s.what_zh}` }));
const d = card.direction;
const direction = { name_zh: card.name, ...d, hookBeat: lines[0].id, climaxBeat: lines[Math.floor(lines.length / 2)].id, followsStyleCard: true, why_zh: "self-test", oneLineSummary_zh: card.summary_zh };
const limits = { ...PACING_PRESETS[d.pacing], ...card.presetOverrides };
const guide = directorGuide(card).text;
const system = fill(PLAN_SYSTEM, { ...limits, brollRatioTarget: d.brollRatioTarget });
const wordLine = (l) => `${l.id} (${secs(l.endMs - l.startMs)} s) "${l.text}"\n   words (index:text@startSeconds): ${words.slice(l.wordStart, l.wordEnd + 1).map((w, k) => `${l.wordStart + k}:${w.text}@${secs(w.startMs)}`).join(" ")}`;
const user = [
  `DIRECTION:\n${JSON.stringify(direction, null, 1)}`, "OTHER DIRECTIONS (your plan must look different from these):\n- none (self-test)",
  `PACING (numbers used by the checker): ${JSON.stringify(limits)}`, guide,
  `BEATS (id, length, text, then word index:word@seconds):\n${lines.map(wordLine).join("\n")}`,
  `EFFECTS (only these ids exist):\n${effectsText()}`,
  `B-ROLL ASSETS (text descriptions only in this self-test; srcStartMs 0 is fine):\n${assets.map((a) => a.text).join("\n")}`,
].join("\n\n");
console.log(`self-test: ${lines.length} beats, ${assets.length} cutaway assets, asking ${settings.model}…`);
let answer = null;
for (let attempt = 0; attempt < 2 && !answer; attempt++) {
  const reply = await callModel({ system, parts: [{ type: "text", text: user }], settings: { ...settings, maxTokens: Math.max(settings.maxTokens, 8000), timeoutSec: Math.max(settings.timeoutSec, 240) }, cache: true, tool: { name: "plan", description: "Return the plan.", schema: planSchema({ assetIds: assets.map((a) => a.id) }) } });
  try { answer = JSON.parse(/\{[\s\S]*\}/.exec(reply.text)?.[0] ?? ""); } catch { console.log("  attempt rejected: not JSON"); }
}
if (!answer) { console.error("self-test: the model did not answer"); process.exit(1); }

// ---- the plan on a 100 ms grid ------------------------------------------------------------------------------------------------
const total = card.source.durationMs || analysis.facts.durationMs;
const steps = Math.floor(total / 100);
const lineOf = (id) => lines.find((l) => l.id === String(id).replace(/[a-z]$/, ""));
const splitsAt = new Map(); // base id -> word indices where a new beat starts
for (const sp of answer.splits ?? []) { const l = lineOf(sp.beat); if (l) (splitsAt.get(l.id) ?? splitsAt.set(l.id, []).get(l.id)).push(sp.word); }
const zoomOf = new Map((answer.beats ?? []).map((b) => [b.beat, b.zoom]));
const planZoom = new Array(steps).fill(null);
for (const l of lines) {
  const cuts = [l.wordStart, ...(splitsAt.get(l.id) ?? []).sort((a, b) => a - b), l.wordEnd + 1];
  const ids = cuts.length > 2 ? cuts.slice(0, -1).map((_, k) => `${l.id}${String.fromCharCode(97 + k)}`) : [l.id];
  ids.forEach((id, k) => {
    const from = words[cuts[k]].startMs, to = k === ids.length - 1 ? l.endMs : words[cuts[k + 1]].startMs;
    for (let t = Math.floor(from / 100); t < Math.min(steps, Math.ceil(to / 100)); t++) planZoom[t] = zoomOf.get(id) ?? null;
  });
}
const planCover = new Array(steps).fill(false);
for (const s of answer.broll ?? []) {
  const w = words[s.word];
  if (!w) continue;
  for (let t = Math.floor(w.startMs / 100); t < Math.min(steps, Math.ceil((w.startMs + (s.durationMs ?? 0)) / 100)); t++) planCover[t] = true;
}
const refCover = new Array(steps).fill(false), refZoom = new Array(steps).fill(null);
for (const s of card.timeline) for (let t = Math.floor(s.startMs / 100); t < Math.min(steps, Math.ceil(s.endMs / 100)); t++) { if (s.visual === "broll" || s.layout === "pip") refCover[t] = true; else refZoom[t] = s.zoom ?? null; }
const count = (a) => a.filter(Boolean).length;
const both = refCover.map((v, t) => v && planCover[t]);
const overlap = count(both) / Math.max(count(refCover), count(planCover), 1);
let talkBoth = 0, talkSame = 0;
for (let t = 0; t < steps; t++) if (refZoom[t] && planZoom[t] && !refCover[t] && !planCover[t]) { talkBoth += 1; if (refZoom[t] === planZoom[t]) talkSame += 1; }
const r = (x) => Number(x.toFixed(2));
const result = { at: new Date().toISOString(), brollRatioRef: r(count(refCover) / steps), brollRatioPlan: r(count(planCover) / steps), zoomSame: r(talkBoth ? talkSame / talkBoth : 0), brollOverlap: r(overlap),
  note: `${lines.length} 句口播、${assets.length} 个参考插画素材；只比较了插画位置和推近档位，没有跑完整校验` };
await writeJson(file, { ...card, selfTest: result });
console.log(`复现度: 插画位置重合 ${Math.round(result.brollOverlap * 100)}%，推近一致 ${Math.round(result.zoomSame * 100)}%，插画占比 参考 ${Math.round(result.brollRatioRef * 100)}% / 方案 ${Math.round(result.brollRatioPlan * 100)}%`);

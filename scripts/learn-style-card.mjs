// Turn an analysed reference video into a style card v2 (library/style-cards/<id>.json, status "draft").
//
//   node scripts/learn-style-card.mjs <refId> [--no-selftest]
//
// 1. program   : analysis.json from scripts/analyze-reference.mjs — hard cuts, one frame per second, spoken words with times
// 2. model A   : annotate the video segment by segment (visual talk/broll, layout, zoom step, role, what happens)
// 3. program   : every number of the card ("measured") is computed from that annotation, never estimated by the model
// 4. model B   : abstract the annotated timeline into a card: direction, structure, techniques, rules, product-specific notes
// 5. program   : checks (no product names in the rules, legal values, numbers agree) — failures go back to the model
// 6. program   : self-test (scripts/style-card-selftest.mjs): cut the reference's own voice-over with this card and compare
// A confirmed card is never overwritten; an older v1 card of the same id is kept in library/style-cards/_history/.
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { callModel, readApiSettings } from "../desk/server/settings.mjs";
import { root } from "./lib/media.mjs";
import { ASSET_TYPES, FORMATS, ROLE_IDS, ROLES2, SUPPORT2, VISUALS, effectIds, measure, nameLikeTerms, pacingFor, parseCardV2, presetFrom, productFreeProblems, scrubProductTerms } from "./lib/style-card2.mjs";
import { EFFECTS, HOOK_TREATMENTS, LAYOUT_BIAS, PACING_IDS, PLACEMENTS, STRUCTURES, ZOOM_IDS, ZOOM_PATTERNS, effectsText } from "./lib/effects.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const refId = process.argv[2];
if (!refId || !/^[a-z0-9][a-z0-9-]*$/.test(refId)) { console.error("Usage: node scripts/learn-style-card.mjs <refId> [--no-selftest]"); process.exit(1); }
const refDir = path.join(root, "library", "references", refId);
const analysis = await readJson(path.join(refDir, "analysis.json"));
const settings = await readApiSettings();
if (!settings.apiKey) { console.error("No API key saved (设置 → API 设置)."); process.exit(1); }
const callSettings = { ...settings, maxTokens: Math.max(settings.maxTokens, 8000), timeoutSec: Math.max(settings.timeoutSec, 240) };
const dur = analysis.facts.durationMs;
const secs = (ms) => (ms / 1000).toFixed(1);
const parseJson = (raw) => { try { return JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? ""); } catch { return null; } };
const ask = async ({ system, parts, schema, name }) => {
  const reply = await callModel({ system, parts, settings: callSettings, cache: true, tool: { name, description: "Return the answer as this object.", schema } });
  return { ...reply, answer: parseJson(reply.text) };
};

// ---- strips of 5 one-second frames each (as before) -------------------------------------------------------------------
const PER = 5;
const strips = [];
for (let i = 0; i < analysis.frames.length; i += PER) {
  const group = analysis.frames.slice(i, i + PER);
  const out = path.join(refDir, `strip-${String(i / PER).padStart(2, "0")}.jpg`);
  if (!(await stat(out).catch(() => null))) {
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...group.flatMap((f) => ["-i", path.join(refDir, f.file)]), "-filter_complex", group.length > 1 ? `hstack=${group.length}` : "null", "-q:v", "4", out], { windowsHide: true });
      p.on("error", reject); p.on("close", (c) => (c ? reject(new Error(`ffmpeg exited ${c}`)) : resolve()));
    });
  }
  strips.push({ file: out, times: group.map((f) => f.t) });
}
const words = analysis.transcript.words ?? [];
const cuts = analysis.cuts.timesMs ?? [];
const bounds = [0, ...cuts, dur];
const intervalsText = bounds.slice(0, -1).map((a, i) => {
  const b = bounds[i + 1];
  return `hard cut interval ${i + 1}: ${a}-${b} ms | said: "${words.filter((w) => w.startMs >= a && w.startMs < b).map((w) => w.text).join(" ")}"`;
}).join("\n");
const imageParts = async () => {
  const parts = [];
  for (const s of strips) {
    parts.push({ type: "text", text: `Strip with frames at t = ${s.times.map((t) => `${t}.3`).join(", ")} s (left to right):` });
    parts.push({ type: "image", mediaType: "image/jpeg", data: (await readFile(s.file)).toString("base64") });
  }
  return parts;
};

// ============================================================================================================================
// model A: annotate
// ============================================================================================================================
const SYSTEM_A = `You annotate a FINISHED vertical TikTok UGC reference video, segment by segment, so that its editing can be reused for another product.
You see one frame per second (in strips), the hard cuts found by scene detection, and the spoken words with times.
Return contiguous segments covering the whole video (from 0 to the end), split wherever the picture changes: a hard cut, a cutaway starting or ending, a picture-in-picture window appearing or going, or a clearly different zoom of the creator. Times are in milliseconds.
For each segment:
- role: one of ${ROLE_IDS.join(", ")} — what the spoken line does (hook = first attention grab; problem = the pain; product_intro = the product is named / first shown; demo = showing how it works; benefit = a reason to want it; proof = trust, verification, results; cta = call to action)
- visual: "talk" (the creator is the picture) or "broll" (a screen recording / product picture / other cutaway is the picture)
- layout: for broll "full" (covers the creator) or "pip" (a small window; the creator stays visible); for talk "pip" if a small window is shown over the creator, otherwise omit
- zoom (only when visual is "talk"): the creator's framing as one of ${ZOOM_IDS.join(", ")}: z100 = wide/medium, z110 = slightly closer, z115 = close, z120 = tight close-up (judge by the size of the face / upper body in the frame; when unsure choose the nearest)
- assetType (only for broll or pip): one of ${ASSET_TYPES.join(", ")}
- emphasisWords: words that the captions emphasise in this segment (empty when none)
- what_zh: one short Chinese sentence about what is on screen
Describe only what you see or measure. Do not invent anything.`;
const schemaA = { type: "object", required: ["timeline"], properties: { timeline: { type: "array", items: { type: "object", required: ["startMs", "endMs", "role", "visual", "what_zh"], properties: {
  startMs: { type: "integer" }, endMs: { type: "integer" }, role: { type: "string", enum: ROLE_IDS }, visual: { type: "string", enum: VISUALS }, layout: { type: "string", enum: ["full", "pip"] },
  zoom: { type: "string", enum: ZOOM_IDS }, assetType: { type: "string", enum: ASSET_TYPES }, emphasisWords: { type: "array", items: { type: "string" } }, what_zh: { type: "string" } } } } } };

// bring the model's segments into a clean, contiguous timeline; returns { timeline, errors }
function cleanTimeline(raw) {
  const errors = [];
  let list = (Array.isArray(raw) ? raw : []).filter((s) => Number.isFinite(Number(s.startMs)) && Number.isFinite(Number(s.endMs))).map((s) => ({ ...s, startMs: Math.round(Number(s.startMs)), endMs: Math.round(Number(s.endMs)) })).sort((a, b) => a.startMs - b.startMs);
  if (list.length < 3) return { timeline: [], errors: ["return at least 3 segments covering the whole video"] };
  list.forEach((s, i) => {
    if (!ROLE_IDS.includes(s.role)) errors.push(`segment ${i + 1}: role "${s.role}" is not one of ${ROLE_IDS.join(", ")}`);
    if (!VISUALS.includes(s.visual)) errors.push(`segment ${i + 1}: visual must be talk or broll`);
    if (s.zoom !== undefined && !ZOOM_IDS.includes(s.zoom)) errors.push(`segment ${i + 1}: zoom "${s.zoom}" is not one of ${ZOOM_IDS.join(", ")}`);
  });
  if (errors.length) return { timeline: [], errors };
  // contiguous: each segment starts where the previous ends; tiny ones (< 300 ms) are absorbed by the previous
  const out = [];
  for (const s of list) {
    const start = out.length ? out.at(-1).endMs : 0;
    const end = Math.min(dur, Math.max(s.endMs, start));
    if (end - start < 300 && out.length) { out.at(-1).endMs = Math.max(out.at(-1).endMs, end); continue; }
    out.push({ ...s, startMs: start, endMs: end, emphasisWords: s.emphasisWords ?? [] });
  }
  if (out.length) out.at(-1).endMs = dur;
  return { timeline: out.filter((s) => s.endMs > s.startMs), errors: [] };
}

console.log(`style card v2: annotating ${strips.length} strips with ${settings.model}…`);
let timeline = null, modelName = null, feedback = null;
for (let attempt = 0; attempt < 3 && !timeline; attempt++) {
  const head = `Reference: ${analysis.title}. ${secs(dur)} s, ${analysis.facts.width}x${analysis.facts.height}. ${cuts.length} hard cuts at ${cuts.map((c) => `${c}`).join(", ") || "none"} ms.\n${intervalsText}\n\nFull transcript with times (word@ms): ${words.map((w) => `${w.text}@${w.startMs}`).join(" ")}`;
  const parts = [{ type: "text", text: head }, ...(await imageParts())];
  if (feedback) parts.push({ type: "text", text: `Your previous answer was rejected. Fix every error and answer again with the full JSON.\nErrors:\n- ${feedback.join("\n- ")}` });
  const reply = await ask({ system: SYSTEM_A, parts, schema: schemaA, name: "timeline" });
  const { timeline: cleaned, errors } = reply.answer ? cleanTimeline(reply.answer.timeline) : { timeline: [], errors: ["the answer was not valid JSON"] };
  if (errors.length) { feedback = errors; console.log(`  annotation attempt ${attempt + 1} rejected: ${errors.slice(0, 3).join("; ")}`); continue; }
  timeline = cleaned; modelName = reply.model;
}
if (!timeline) { console.error("the model did not return a usable annotation"); process.exit(1); }
const measured = measure(timeline, dur);
console.log(`  ${timeline.length} segments; measured: avg ${measured.avgShotMs} ms, b-roll ${Math.round(measured.brollRatio * 100)}%, first b-roll ${measured.firstBrollMs} ms`);

// ============================================================================================================================
// model B: abstract into a card
// ============================================================================================================================
const SYSTEM_B = `You turn an annotated reference video into a reusable STYLE CARD for editing other products the same way.
The card is a pre-filled "creative direction" plus rules. Everything must transfer to a DIFFERENT product:
- "directorRules" and every "technique_zh" in "structure" describe the EDITING only (timing, zoom, where pictures go, what to cut to). They must NOT contain the reference's product name, brand name, or product features. Put anything specific to that product (its features, screens, comparisons) into "contentSpecific_zh" (Chinese) instead.
- "productTerms": list every word in the transcript or frames that is the reference product's name, brand, or product-specific noun (used for an automatic check that the rules are product-free).
- "direction" fields can only take the listed values. The program computes all numbers itself; do not return numbers except brollRatioTarget (which should equal measured.brollRatio).
- "directorRules": at most 8 one-sentence rules in English, imperative, concrete, about THIS style (e.g. "Cut to a product visual on the exact beat the product is first named.").
- "structure": use the generic roles ${ROLE_IDS.join(", ")} only, with startMs/endMs covering the video and a Chinese "technique_zh" saying how that part is edited.
- "techniques": the editing techniques you can see, each tied to the effect registry: effectId is one of ${[...effectIds()].join(", ")} when the technique matches an effect (z115 alternating zoom, punch = snap zoom on a word, pushIn = slow push on a screen recording, full/pip layouts), otherwise null. "support": "ready" if the effect is ready in EFFECTS, "partial" if only approximately possible, "unsupported" if the engine cannot do it (stickers, sound effects, music, glow text, speed ramps…). "evidenceMs": at least one time in the video where you saw it.
- "meta": productType app|physical, format ${FORMATS.join("|")}, language, tags_zh (3-5 short Chinese tags).
- "captions": position / case / wordsPerBlock / emphasis as seen. "packaging_zh": stickers, sound effects, music as seen (recorded only).
- "summary_zh": 1-2 Chinese sentences about the style, WITHOUT the product name.
Return ONE JSON object matching the schema.`;
const schemaB = { type: "object", required: ["direction", "structure", "techniques", "directorRules", "contentSpecific_zh", "meta", "productTerms", "summary_zh"], properties: {
  summary_zh: { type: "string" },
  direction: { type: "object", required: ["hookTreatment", "structureEmphasis", "pacing", "brollPlacement", "layoutBias", "zoomPattern", "brollRatioTarget"], properties: {
    hookTreatment: { type: "string", enum: HOOK_TREATMENTS.map((h) => h.id) }, structureEmphasis: { type: "string", enum: STRUCTURES }, pacing: { type: "string", enum: PACING_IDS },
    brollPlacement: { type: "string", enum: PLACEMENTS }, layoutBias: { type: "string", enum: LAYOUT_BIAS }, zoomPattern: { type: "string", enum: ZOOM_PATTERNS }, brollRatioTarget: { type: "number" } } },
  structure: { type: "array", items: { type: "object", required: ["role", "startMs", "endMs", "technique_zh"], properties: { role: { type: "string", enum: ROLE_IDS }, startMs: { type: "integer" }, endMs: { type: "integer" }, technique_zh: { type: "string" } } } },
  techniques: { type: "array", items: { type: "object", required: ["name_zh", "support", "evidenceMs"], properties: { name_zh: { type: "string" }, effectId: { type: ["string", "null"] }, support: { type: "string", enum: SUPPORT2 }, evidenceMs: { type: "array", items: { type: "integer" } } } } },
  directorRules: { type: "array", maxItems: 8, items: { type: "string" } },
  contentSpecific_zh: { type: "string" }, packaging_zh: { type: "string" }, productTerms: { type: "array", items: { type: "string" } },
  meta: { type: "object", properties: { productType: { type: "string", enum: ["app", "physical"] }, format: { type: "string", enum: FORMATS }, language: { type: "string" }, tags_zh: { type: "array", items: { type: "string" } } } },
  captions: { type: "object", properties: { position: { type: "string" }, case: { type: "string" }, wordsPerBlock: { type: "integer" }, emphasis: { type: "string" } } },
} };

const autoTerms = nameLikeTerms(words);
const enumIssues = (d) => {
  const e = [];
  if (!HOOK_TREATMENTS.some((h) => h.id === d?.hookTreatment)) e.push(`direction.hookTreatment must be one of ${HOOK_TREATMENTS.map((h) => h.id).join(", ")}`);
  if (!STRUCTURES.includes(d?.structureEmphasis)) e.push(`direction.structureEmphasis must be one of ${STRUCTURES.join(", ")}`);
  if (!PACING_IDS.includes(d?.pacing)) e.push(`direction.pacing must be one of ${PACING_IDS.join(", ")}`);
  if (!PLACEMENTS.includes(d?.brollPlacement)) e.push(`direction.brollPlacement must be one of ${PLACEMENTS.join(", ")}`);
  if (!LAYOUT_BIAS.includes(d?.layoutBias)) e.push(`direction.layoutBias must be one of ${LAYOUT_BIAS.join(", ")}`);
  if (!ZOOM_PATTERNS.includes(d?.zoomPattern)) e.push(`direction.zoomPattern must be one of ${ZOOM_PATTERNS.join(", ")}`);
  return e;
};

console.log("style card v2: abstracting the card…");
const notes = [];
let abstracted = null; feedback = null;
for (let attempt = 0; attempt < 3 && !abstracted; attempt++) {
  const user = [
    `Reference: ${analysis.title}. ${secs(dur)} s.`,
    `ANNOTATED TIMELINE (from the previous step):\n${timeline.map((s) => `${s.startMs}-${s.endMs} ms ${s.role} ${s.visual}${s.layout ? `/${s.layout}` : ""}${s.zoom ? ` ${s.zoom}` : ""}${s.assetType ? ` ${s.assetType}` : ""}${s.emphasisWords.length ? ` emph[${s.emphasisWords.join(",")}]` : ""}: ${s.what_zh}`).join("\n")}`,
    `MEASURED (by the program): ${JSON.stringify(measured)}`,
    `TRANSCRIPT: ${analysis.transcript.text}`,
    `HOOK_TREATMENTS:\n${JSON.stringify(HOOK_TREATMENTS)}`,
    `EFFECTS (ready ones; punch and pushIn are known but not ready yet):\n${effectsText()}\nnot ready yet: ${EFFECTS.zoom.concat(EFFECTS.brollMotion).filter((x) => x.ready === false).map((x) => x.id).join(", ")}`,
    feedback ? `Your previous answer was rejected. Fix every error and answer again with the full JSON.\nErrors:\n- ${feedback.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  const reply = await ask({ system: SYSTEM_B, parts: [{ type: "text", text: user }], schema: schemaB, name: "style_card" });
  const a = reply.answer;
  if (!a) { feedback = ["the answer was not valid JSON"]; console.log("  abstraction rejected: not JSON"); continue; }
  const errors = enumIssues(a.direction);
  if (!Array.isArray(a.directorRules) || a.directorRules.length > 8 || a.directorRules.some((r) => String(r).split(/[.!?]\s/).filter(Boolean).length > 2)) errors.push("directorRules: at most 8 rules, each one sentence");
  if (!Array.isArray(a.structure) || a.structure.length < 2) errors.push("structure: at least 2 generic-role segments");
  else a.structure.forEach((s, i) => { if (!ROLE_IDS.includes(s.role)) errors.push(`structure[${i}].role "${s.role}" is not one of ${ROLE_IDS.join(", ")}`); });
  const problems = productFreeProblems({ directorRules: a.directorRules ?? [], structure: a.structure ?? [], techniques: a.techniques ?? [], productTerms: a.productTerms ?? [] }, autoTerms);
  if (problems.length && !errors.length && attempt === 2) { // last attempt, nothing else wrong: scrub instead of failing the whole card
    const scrubbed = scrubProductTerms({ directorRules: a.directorRules ?? [], structure: a.structure ?? [], techniques: a.techniques ?? [], productTerms: a.productTerms ?? [] }, autoTerms);
    Object.assign(a, { directorRules: scrubbed.card.directorRules, structure: scrubbed.card.structure, techniques: scrubbed.card.techniques });
    notes.push(...scrubbed.notes);
    problems.length = 0;
  }
  if (problems.length) errors.push(`the rules must be product-free; remove or move to contentSpecific_zh: ${problems.join("; ")}`);
  if (errors.length) { feedback = errors; console.log(`  abstraction attempt ${attempt + 1} rejected:\n   - ${errors.join("\n   - ")}`); continue; }
  abstracted = { ...a, model: reply.model };
}
if (!abstracted) { console.error("the model did not return a usable card (see the messages above)"); process.exit(1); }

// ---- program corrections (spec section 4: numbers agree, evidence inside the video) -----------------------------------------------
const direction = { ...abstracted.direction };
if (Math.abs(direction.brollRatioTarget - measured.brollRatio) > 0.05) { notes.push(`brollRatioTarget ${direction.brollRatioTarget} → ${measured.brollRatio} (measured)`); direction.brollRatioTarget = measured.brollRatio; }
const pacing = pacingFor(measured.avgShotMs);
if (direction.pacing !== pacing) { notes.push(`pacing ${direction.pacing} → ${pacing} (average shot ${measured.avgShotMs} ms)`); direction.pacing = pacing; }
const ids = effectIds();
const techniques = (abstracted.techniques ?? []).map((t) => ({ ...t, evidenceMs: (t.evidenceMs ?? []).filter((ms) => Number.isFinite(ms) && ms >= 0 && ms <= dur) }))
  .filter((t) => { if (!t.evidenceMs.length) { notes.push(`technique "${t.name_zh}" dropped: no evidence inside the video`); return false; } return true; })
  .map((t) => (t.effectId && !ids.has(t.effectId) ? { ...t, effectId: null, support: "unsupported" } : t));
const defaults = { noFullBrollBeforeMs: 2000, noPipBeforeMs: 1500, minShotMs: 800, maxShotMs: 3500, maxBrollRatio: 0.55, maxStaticMs: 3500 };

// never overwrite a confirmed card: a second run of the same reference gets a new id; an older v1 draft is kept as history
const cardsDir = path.join(root, "library", "style-cards");
await mkdir(cardsDir, { recursive: true });
let id = refId, n = 1;
while (true) {
  const existing = await readJson(path.join(cardsDir, `${id}.json`), null);
  if (!existing || existing.status === "draft") break;
  id = `${refId}-${++n}`;
}
const old = await readJson(path.join(cardsDir, `${id}.json`), null);
if (old && old.schemaVersion !== 2) {
  await mkdir(path.join(cardsDir, "_history"), { recursive: true });
  await copyFile(path.join(cardsDir, `${id}.json`), path.join(cardsDir, "_history", `${id}.v1.json`));
  console.log(`  the older v1 card was kept as library/style-cards/_history/${id}.v1.json`);
}
const card = parseCardV2({
  schemaVersion: 2, id, name: old?.name ?? analysis.title, status: "draft",
  source: { referenceId: refId, path: analysis.source?.file ?? "", title: analysis.title, durationMs: dur, sha256: analysis.source?.sha256 ?? "" },
  summary_zh: abstracted.summary_zh ?? "", meta: abstracted.meta, measured, direction, presetOverrides: presetFrom(measured, defaults, timeline),
  structure: abstracted.structure.map((s) => ({ ...s, startMs: Math.max(0, Math.min(dur, Number(s.startMs) || 0)), endMs: Math.max(0, Math.min(dur, Number(s.endMs) || 0)) })),
  timeline, techniques, directorRules: abstracted.directorRules, contentSpecific_zh: abstracted.contentSpecific_zh ?? "", captions: abstracted.captions, packaging_zh: abstracted.packaging_zh ?? "",
  productTerms: abstracted.productTerms ?? [], selfTest: null, model: abstracted.model ?? modelName, createdAt: new Date().toISOString(), confirmedAt: null,
});
await writeJson(path.join(cardsDir, `${id}.json`), card);
console.log(`style card ${id}: ${card.structure.map((s) => `${ROLES2[s.role]} ${secs(s.startMs)}–${secs(s.endMs)}s`).join(" / ")}`);
console.log(`  direction: ${card.direction.hookTreatment} · ${card.direction.pacing} · ${card.direction.layoutBias} · ${card.direction.zoomPattern} · b-roll ${Math.round(card.direction.brollRatioTarget * 100)}%`);
for (const t of card.techniques.filter((x) => x.support !== "ready")) console.log(`  not ready: ${t.name_zh} (${t.effectId ?? "no effect"}) ${t.support}`);
for (const note of notes) console.log(`  corrected: ${note}`);

if (!process.argv.includes("--no-selftest")) {
  const test = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/style-card-selftest.mjs", id], { cwd: root, stdio: "inherit", windowsHide: true });
  await new Promise((resolve) => test.on("close", resolve));
}

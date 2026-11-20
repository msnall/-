// Style card v2 (风格库优化 v1): a card is a pre-filled creative direction plus a worked example.
//   direction   same fields and values as the director's creative directions (scripts/lib/effects.mjs)
//   measured    numbers the PROGRAM computes from the annotated timeline (never estimated by the model)
//   timeline    the reference video, cut by cut, in the plan's own words (visual / layout / zoom / role): the few-shot example
//   structure   generic roles only (no product names), techniques tied to the effect registry, rules for the director
//   contentSpecific_zh / captions / packaging_zh are recorded for the editor only and never go to the model as rules
import { z } from "zod";
import { COLOR_IDS, HOOK_TREATMENTS, LAYOUT_BIAS, PACING_IDS, PLACEMENTS, STRUCTURES, ZOOM_IDS, ZOOM_PATTERNS, EFFECTS } from "./effects.mjs";

const num = (fallback) => z.coerce.number().finite().catch(fallback);
const text = (fallback = "", max = 600) => z.string().catch(fallback).transform((s) => s.slice(0, max));

export const ROLES2 = { hook: "钩子", problem: "痛点", product_intro: "产品引入", demo: "演示", benefit: "好处", proof: "证明", cta: "行动号召" };
export const ROLE_IDS = Object.keys(ROLES2);
export const VISUALS = ["talk", "broll"];
export const ASSET_TYPES = ["screen_recording", "product_shot", "action_clip", "end_card", "text_card", "other"];
export const SUPPORT2 = ["ready", "partial", "unsupported"];
export const FORMATS = ["single_creator_talking", "reaction", "comparison", "list", "story"];

const directionSchema = z.object({
  hookTreatment: z.enum(HOOK_TREATMENTS.map((h) => h.id)).catch("creator_punch"),
  structureEmphasis: z.enum(STRUCTURES).catch("story"),
  pacing: z.enum(PACING_IDS).catch("medium"),
  brollPlacement: z.enum(PLACEMENTS).catch("spread"),
  layoutBias: z.enum(LAYOUT_BIAS).catch("mixed"),
  zoomPattern: z.enum(ZOOM_PATTERNS).catch("alternate"),
  brollRatioTarget: num(0.3),
});

export const cardSchemaV2 = z.object({
  schemaVersion: z.literal(2).catch(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: text("未命名风格", 80).transform((s) => s.trim() || "未命名风格"),
  status: z.enum(["draft", "confirmed"]).catch("draft"),
  source: z.object({ referenceId: z.string().catch(""), path: z.string().catch(""), title: z.string().catch(""), durationMs: num(0), sha256: z.string().catch("") }).catch({ referenceId: "", path: "", title: "", durationMs: 0, sha256: "" }),
  summary_zh: text(),
  meta: z.object({ productType: z.enum(["app", "physical"]).catch("app"), format: z.enum(FORMATS).catch("single_creator_talking"), language: text("en", 10), tags_zh: z.array(text("", 20)).catch([]) })
    .catch({ productType: "app", format: "single_creator_talking", language: "en", tags_zh: [] }),
  measured: z.object({ cutCount: num(0), avgShotMs: num(0), medianShotMs: num(0), maxStaticMs: num(0), firstBrollMs: num(0), brollRatio: num(0), fullRatio: num(0), pipRatio: num(0), zoomChangesPerTalkBeat: num(0) })
    .catch({ cutCount: 0, avgShotMs: 0, medianShotMs: 0, maxStaticMs: 0, firstBrollMs: 0, brollRatio: 0, fullRatio: 0, pipRatio: 0, zoomChangesPerTalkBeat: 0 }),
  direction: directionSchema.catch({ hookTreatment: "creator_punch", structureEmphasis: "story", pacing: "medium", brollPlacement: "spread", layoutBias: "mixed", zoomPattern: "alternate", brollRatioTarget: 0.3 }),
  presetOverrides: z.object({ noFullBrollBeforeMs: num(2000), noPipBeforeMs: num(1500), minShotMs: num(800), maxShotMs: num(3500), maxBrollRatio: num(0.55), maxStaticMs: num(3500) })
    .catch({ noFullBrollBeforeMs: 2000, noPipBeforeMs: 1500, minShotMs: 800, maxShotMs: 3500, maxBrollRatio: 0.55, maxStaticMs: 3500 }),
  structure: z.array(z.object({ role: z.enum(ROLE_IDS).catch("benefit"), startMs: num(0), endMs: num(0), technique_zh: text() })).catch([]),
  timeline: z.array(z.object({
    startMs: num(0), endMs: num(0), role: z.enum(ROLE_IDS).catch("benefit"), visual: z.enum(VISUALS).catch("talk"),
    layout: z.enum(["full", "pip"]).optional().catch(undefined), zoom: z.enum(ZOOM_IDS).optional().catch(undefined),
    assetType: z.enum(ASSET_TYPES).optional().catch(undefined), emphasisWords: z.array(z.string()).catch([]), what_zh: text("", 200),
  })).catch([]),
  techniques: z.array(z.object({ name_zh: text("", 80), effectId: z.string().nullable().catch(null), support: z.enum(SUPPORT2).catch("partial"), evidenceMs: z.array(num(0)).catch([]) })).catch([]),
  directorRules: z.array(z.string().transform((s) => s.slice(0, 300))).catch([]),
  contentSpecific_zh: text(),
  captions: z.object({ position: text("lower-center", 40), case: text("upper", 20), wordsPerBlock: num(3), emphasis: text("", 100) }).catch({ position: "lower-center", case: "upper", wordsPerBlock: 3, emphasis: "" }),
  packaging_zh: text(),
  productTerms: z.array(text("", 40)).catch([]), // words that belong to the reference's product (checked against the rules)
  selfTest: z.object({ at: z.string(), brollRatioRef: num(0), brollRatioPlan: num(0), zoomSame: num(0), brollOverlap: num(0), note: text() }).nullable().catch(null),
  model: z.string().nullable().catch(null),
  createdAt: z.string().catch(""),
  confirmedAt: z.string().nullable().catch(null),
});
export const parseCardV2 = (raw) => cardSchemaV2.parse(raw);

// ---- numbers computed from the annotated timeline -----------------------------------------------------------------------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
export function measure(timeline, durationMs) {
  const total = durationMs || timeline.at(-1)?.endMs || 1;
  const len = (s) => Math.max(0, s.endMs - s.startMs);
  const lens = timeline.map(len);
  const pip = timeline.filter((s) => s.layout === "pip"); // a window over the creator (visual may be "talk" or "broll")
  const full = timeline.filter((s) => s.visual === "broll" && s.layout !== "pip");
  const covered = [...full, ...pip];
  // a "talking beat" change = two neighbouring talking shots with a different zoom
  const talk = timeline.filter((s) => s.visual === "talk" && s.zoom);
  let changes = 0, pairs = 0;
  for (let i = 1; i < talk.length; i++) { pairs += 1; if (talk[i].zoom !== talk[i - 1].zoom) changes += 1; }
  const r = (x, d = 2) => Number(x.toFixed(d));
  const sum = (list) => list.reduce((t, s) => t + len(s), 0);
  return {
    cutCount: Math.max(0, timeline.length - 1), avgShotMs: Math.round(sum(timeline) / Math.max(1, lens.length)), medianShotMs: Math.round(median(lens)),
    maxStaticMs: Math.max(0, ...lens), firstBrollMs: covered.length ? Math.min(...covered.map((s) => s.startMs)) : total,
    brollRatio: r(sum(covered) / total), fullRatio: r(sum(full) / total), pipRatio: r(sum(pip) / total),
    zoomChangesPerTalkBeat: r(pairs ? changes / pairs : 0),
  };
}

// pacing implied by the average shot length (the spec's example: under 2000 ms is fast)
export const pacingFor = (avgShotMs) => (avgShotMs < 2000 ? "fast" : avgShotMs < 3200 ? "medium" : "calm");
export const presetFrom = (m, current, timeline = []) => ({
  noFullBrollBeforeMs: Math.max(2000, Math.round(m.firstBrollMs / 100) * 100 || 2000),
  noPipBeforeMs: Math.round(Math.min(...timeline.filter((s) => s.layout === "pip").map((s) => s.startMs), m.firstBrollMs, 5000) / 100) * 100,
  minShotMs: Math.max(500, Math.round((m.medianShotMs * 0.45) / 100) * 100 || current.minShotMs),
  maxShotMs: Math.min(5000, Math.max(1500, Math.round((m.maxStaticMs * 1.0) / 100) * 100 || current.maxShotMs)),
  maxBrollRatio: Math.min(0.9, Math.max(0.2, Number((m.brollRatio + 0.12).toFixed(2)))),
  maxStaticMs: Math.max(1500, Math.round((m.maxStaticMs * 1.05) / 100) * 100 || current.maxStaticMs),
});

// ---- the checks after the model has abstracted the card (spec section 4) -------------------------------------------------------
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// words in the transcript that look like names: capitalised in the middle of a sentence, or brand-like (kika, App names)
export function nameLikeTerms(words) {
  const out = new Set();
  words.forEach((w, i) => {
    const t = String(w.text ?? "").replace(/[^A-Za-z0-9']/g, "");
    if (t.length < 3 || !/^[A-Z]/.test(t)) return;
    const prev = String(words[i - 1]?.text ?? "");
    if (i === 0 || /[.!?]$/.test(prev)) return; // sentence-initial capital proves nothing
    if (/^I('|$)/.test(t)) return;
    out.add(t.toLowerCase());
  });
  return [...out];
}
// Words every editing rule needs ("caption block", "full-screen", "the first line"): never product terms, even when the reference's product
// (a block puzzle, a line-clearing game, a text keyboard) happens to use them too.
const GENERIC = new Set(["block", "blocks", "line", "lines", "text", "screen", "screens", "card", "cards", "clip", "clips", "shot", "shots", "cut", "cuts", "frame", "frames", "caption", "captions", "word", "words", "zoom", "hook", "beat", "beats", "overlay", "window", "icon", "logo", "video", "creator", "product", "app", "demo", "button", "buttons", "game", "games", "step", "steps", "result", "results", "free", "new", "best", "easy", "play", "hands", "hand", "face", "phone", "story", "time", "end", "start", "first", "last", "top", "bottom", "left", "right", "color", "colour", "big", "small", "full", "tight", "wide", "close", "pip", "b-roll", "broll", "talk", "talking"]);
export const termsOf = (card, extraTerms = []) => [...new Set([...(card.productTerms ?? []), ...extraTerms].map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3 && !GENERIC.has(t)))];
const hasTerm = (term, value) => new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`, "i").test(value);
// Last resort when the model keeps putting a product word into the rules: drop the offending rules and neutralise the word in the
// Chinese technique notes, and say so. Returns { card, notes }.
export function scrubProductTerms(card, extraTerms = []) {
  const terms = termsOf(card, extraTerms);
  const notes = [];
  const directorRules = card.directorRules.filter((r) => { const hit = terms.find((t) => hasTerm(t, r)); if (hit) notes.push(`rule dropped (mentions "${hit}"): ${r}`); return !hit; });
  const clean = (text) => terms.reduce((t, term) => t.replace(new RegExp(escapeRe(term), "gi"), "产品"), text);
  const structure = card.structure.map((s) => ({ ...s, technique_zh: clean(s.technique_zh) }));
  const techniques = card.techniques.map((t) => ({ ...t, name_zh: clean(t.name_zh) }));
  return { card: { ...card, directorRules, structure, techniques }, notes };
}
export function productFreeProblems(card, extraTerms = []) {
  const terms = termsOf(card, extraTerms);
  const hits = [];
  const scan = (label, value) => { for (const t of terms) if (new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, "i").test(value)) hits.push(`${label} mentions "${t}"`); };
  card.directorRules.forEach((r, i) => scan(`directorRules[${i}]`, r));
  card.structure.forEach((s, i) => scan(`structure[${i}].technique_zh`, s.technique_zh));
  card.techniques.forEach((t, i) => scan(`techniques[${i}].name_zh`, t.name_zh));
  return hits;
}
export const effectIds = () => new Set([...EFFECTS.zoom.map((z) => z.id), ...EFFECTS.brollMotion.map((m) => m.id), ...EFFECTS.brollLayout.map((l) => l.id)]);
export const COLORS = COLOR_IDS;

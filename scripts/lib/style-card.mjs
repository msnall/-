// Style card: what one reference video does, in the six areas an editor thinks in, plus which parts the engine can do.
// Stored as library/style-cards/<id>.json. A card starts as "draft" (written by the model) and only a confirmed card can
// steer the auto director. See docs/style-card.md.
import { z } from "zod";

const num = (fallback) => z.coerce.number().finite().catch(fallback);
const text = (fallback = "") => z.string().catch(fallback).transform((s) => s.slice(0, 600));
const range = (a, b) => z.array(z.coerce.number().finite()).length(2).catch([a, b]);

export const ROLES = { hook: "钩子", pain: "痛点", demo: "产品演示", proof: "证明", benefit: "卖点", cta: "行动号召", other: "其他" };
export const SUPPORT = ["supported", "partial", "needs-effect"];

export const cardSchema = z.object({
  version: z.literal(1).catch(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: text("未命名风格").transform((s) => s.trim() || "未命名风格"),
  status: z.enum(["draft", "confirmed"]).catch("draft"),
  source: z.object({ referenceId: z.string().catch(""), title: z.string().catch(""), durationMs: num(0), shots: num(0) }).catch({ referenceId: "", title: "", durationMs: 0, shots: 0 }),
  summary: text(),
  structure: z.array(z.object({ role: z.enum(Object.keys(ROLES)).catch("other"), label: text(), fromMs: num(0), toMs: num(0), what: text() })).catch([]),
  rhythm: z.object({ avgCutMs: num(2000), removePauses: z.coerce.boolean().catch(true), maxPauseMs: num(220), note: text() }).catch({ avgCutMs: 2000, removePauses: true, maxPauseMs: 220, note: "" }),
  camera: z.object({ zoomOnKeywords: z.coerce.boolean().catch(false), zoomRange: range(1.1, 1.2), alternateFraming: z.coerce.boolean().catch(false), note: text() }).catch({ zoomOnKeywords: false, zoomRange: [1.1, 1.2], alternateFraming: false, note: "" }),
  captions: z.object({ position: text("center-low"), yRatio: num(0.65), look: text(), highlight: text(), animation: text(), wordsPerChunk: range(2, 4), upper: z.coerce.boolean().catch(true), emoji: z.coerce.boolean().catch(false), note: text() })
    .catch({ position: "center-low", yRatio: 0.65, look: "", highlight: "", animation: "", wordsPerChunk: [2, 4], upper: true, emoji: false, note: "" }),
  inserts: z.object({ layout: z.enum(["full", "pip", "mixed"]).catch("full"), firstAtMs: num(2000), shotMs: range(800, 2500), share: num(0.3), triggers: text(), logoPersistent: z.coerce.boolean().catch(false), ending: z.enum(["fullscreen", "end-card", "none"]).catch("none"), note: text() })
    .catch({ layout: "full", firstAtMs: 2000, shotMs: [800, 2500], share: 0.3, triggers: "", logoPersistent: false, ending: "none", note: "" }),
  packaging: z.object({ stickers: text(), sfx: text(), music: text(), duckDb: num(-20), note: text() }).catch({ stickers: "", sfx: "", music: "", duckDb: -20, note: "" }),
  support: z.array(z.object({ area: text(), feature: text(), level: z.enum(SUPPORT).catch("partial"), note: text() })).catch([]),
  directorRules: z.array(z.string().transform((s) => s.slice(0, 300))).catch([]),
  model: z.string().nullable().catch(null),
  createdAt: z.string().catch(""),
  confirmedAt: z.string().nullable().catch(null),
});

export const parseCard = (raw) => cardSchema.parse(raw);

// What the auto director takes from a confirmed card: one-line rules for the prompt plus the numbers that tighten its limits.
export function directorGuide(card) {
  const lines = [...card.directorRules];
  const i = card.inserts;
  if (i.layout !== "full") lines.push(`Use picture-in-picture (layout "pip") for most cutaways; the creator stays visible.`);
  if (i.logoPersistent) lines.push("Show the brand logo in the top-left corner from the moment the product name is spoken until the end.");
  if (i.ending === "fullscreen") lines.push("End on a full-screen product showcase (an end card or theme clip) for the call to action.");
  if (card.rhythm.removePauses) lines.push("Keep the pace tight: no dead air between sentences.");
  const limits = {};
  if (Number.isFinite(i.shotMs?.[0])) { limits.minShotMs = Math.max(500, Math.round(i.shotMs[0])); limits.maxShotMs = Math.min(5000, Math.max(limits.minShotMs + 300, Math.round(i.shotMs[1]))); }
  if (Number.isFinite(i.firstAtMs)) limits.noBrollBeforeMs = Math.max(0, Math.round(i.firstAtMs));
  if (i.layout === "full" && Number.isFinite(i.share)) limits.maxBrollShare = Math.min(0.9, Math.max(0.1, i.share));
  return { text: lines.length ? `STYLE CARD "${card.name}":\n${lines.map((l) => `- ${l}`).join("\n")}` : "", limits, allowsPip: i.layout !== "full", wantsLogo: i.logoPersistent };
}

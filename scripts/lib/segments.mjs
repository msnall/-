// 片段库 (L3 segment library) — "learning" here means: proven edits are stored as small structured examples, and the director gets the
// most relevant ones in its prompt. Nothing is trained.
//
//   library/segments/segments.jsonl   one JSON object per line (override the path with VA_SEGMENTS_FILE, used by tests)
//   source: "reference"      a sentence of a confirmed style card's reference video, with how it was cut
//           "human_edited"   a beat of a finished video that the editor changed in 精修 (highest weight)
//           "ai_accepted"    a beat the editor kept as the AI proposed it
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callModel, readApiSettings } from "../../desk/server/settings.mjs";
import { root } from "./media.mjs";
import { ROLE_IDS } from "./style-card2.mjs";
import { readJson } from "./storage.mjs";

export const FEATURES = ["opens_with_scene", "asks_question", "names_product", "turning_point", "feature", "result", "emotion", "number", "cta"];
const SOURCE_WEIGHT = { human_edited: 1.0, reference: 0.8, ai_accepted: 0.6 };
export const segmentsFile = () => process.env.VA_SEGMENTS_FILE || path.join(root, "library", "segments", "segments.jsonl");

export async function readSegments() {
  const text = await readFile(segmentsFile(), "utf8").catch(() => "");
  return text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export async function writeSegments(list) {
  const file = segmentsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, list.map((s) => JSON.stringify(s)).join("\n") + (list.length ? "\n" : ""));
}
// replace everything that matches `drop` with `add` (a card re-confirmed or a video exported again does not pile up copies)
export async function replaceSegments(drop, add) {
  const keep = (await readSegments()).filter((s) => !drop(s));
  await writeSegments([...keep, ...add]);
  return keep.length + add.length;
}

// ---- features and roles for lines ---------------------------------------------------------------------------------------------
const CTA = /\b(tap|click|download|try|get|link|shop|order|sign up|install|check out|follow)\b/i;
export function heuristicLabel(text, { first = false, last = false, productTerms = [] } = {}) {
  const f = new Set();
  const t = String(text);
  if (/\?/.test(t)) f.add("asks_question");
  if (/\d/.test(t)) f.add("number");
  if (CTA.test(t) && last) f.add("cta");
  if (/\b(then|until|but|finally|turns out|that's when|that is when|so i)\b/i.test(t)) f.add("turning_point");
  if (/!|\b(love|hate|ridiculous|tired|boring|amazing|crazy|worst|favorite|obsessed|annoying)\b/i.test(t)) f.add("emotion");
  if (productTerms.some((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t))) f.add("names_product");
  if (/\b(can|lets? you|allows?|has|have|comes with|built|features?)\b/i.test(t)) f.add("feature");
  if (/\b(now|result|saved|better|easier|faster|no more|finally)\b/i.test(t)) f.add("result");
  if (first && !f.has("asks_question") && /\b(it's|i was|i heard|at \d|last night|today|yesterday)\b/i.test(t)) f.add("opens_with_scene");
  const role = first ? "hook" : last && f.has("cta") ? "cta" : f.has("names_product") ? "product_intro" : f.has("feature") ? "benefit" : f.has("result") ? "proof" : "problem";
  return { role, features: [...f] };
}

// one model call labels every line: role + features from the fixed lists (falls back to the heuristics above)
export async function labelLines(lines, { productTerms = [], quiet = false } = {}) {
  const fallback = () => Object.fromEntries(lines.map((l, i) => [l.id, heuristicLabel(l.text, { first: i === 0, last: i === lines.length - 1, productTerms })]));
  let settings;
  try { settings = await readApiSettings(); } catch { return fallback(); }
  if (!settings?.apiKey) return fallback();
  const schema = { type: "object", required: ["lines"], properties: { lines: { type: "array", items: { type: "object", required: ["id", "role", "features"], properties: { id: { type: "string" }, role: { type: "string", enum: ROLE_IDS }, features: { type: "array", items: { type: "string", enum: FEATURES } } } } } } };
  const system = `For each beat of a short TikTok UGC voice-over return its role (${ROLE_IDS.join(" | ")}) and lineFeatures from this fixed list: ${FEATURES.join(", ")}.
- opens_with_scene: opens with a concrete scene or moment; asks_question; names_product: the first time the product/brand is named; turning_point: a turn ("then I found…", "until…"); feature: describes a function; result: an effect or change; emotion; number; cta: call to action.
Be conservative: only tag what the words clearly say. Return JSON only.`;
  const user = `${productTerms.length ? `Product words: ${productTerms.join(", ")}\n` : ""}BEATS:\n${lines.map((l) => `${l.id}: "${l.text}"`).join("\n")}`;
  try {
    const reply = await callModel({ system, parts: [{ type: "text", text: user }], settings: { ...settings, maxTokens: Math.max(settings.maxTokens, 3000), timeoutSec: Math.max(settings.timeoutSec, 120) }, tool: { name: "labels", description: "Return the labels.", schema } });
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(reply.text)?.[0] ?? "");
    const out = fallback();
    for (const l of parsed.lines ?? []) if (out[l.id] && ROLE_IDS.includes(l.role)) out[l.id] = { role: l.role, features: (l.features ?? []).filter((f) => FEATURES.includes(f)) };
    return out;
  } catch (error) {
    if (!quiet) console.error(`  line labels: model call failed (${String(error.message).slice(0, 120)}); using the keyword rules`);
    return fallback();
  }
}

// ---- reference video -> segments -----------------------------------------------------------------------------------------------
const sentencesOf = (words) => {
  const out = [];
  let start = 0;
  words.forEach((w, i) => { if (/[.!?]$/.test(w.text) || i === words.length - 1) { out.push({ wordStart: start, wordEnd: i, startMs: words[start].startMs, endMs: w.endMs, text: words.slice(start, i + 1).map((x) => x.text).join(" ") }); start = i + 1; } });
  return out;
};
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export async function segmentsFromCard(card, { quiet = false } = {}) {
  const analysis = await readJson(path.join(root, "library", "references", card.source.referenceId, "analysis.json"), null);
  const words = analysis?.transcript?.words ?? [];
  if (!words.length) return [];
  const sentences = sentencesOf(words).map((s, i) => ({ ...s, id: `s${String(i + 1).padStart(2, "0")}` }));
  const labels = await labelLines(sentences, { productTerms: card.productTerms, quiet });
  const out = [];
  for (const s of sentences) {
    const segs = card.timeline.map((t) => ({ ...t, ov: overlap(t.startMs, t.endMs, s.startMs, s.endMs) })).filter((t) => t.ov > 0);
    if (!segs.length) continue;
    const dominant = [...segs].sort((a, b) => b.ov - a.ov)[0];
    const cover = segs.filter((t) => t.visual === "broll" || t.layout === "pip");
    const talk = segs.filter((t) => t.visual === "talk" && t.zoom).sort((a, b) => b.ov - a.ov)[0];
    const n = s.wordEnd - s.wordStart + 1;
    let brollAtWord = null;
    if (cover.length) {
      const first = [...cover].sort((a, b) => a.startMs - b.startMs)[0];
      const k = words.slice(s.wordStart, s.wordEnd + 1).findIndex((w) => w.startMs >= first.startMs - 100);
      brollAtWord = Math.max(0, k < 0 ? n - 1 : k);
    }
    const startsOnCover = cover.length && cover.some((c) => c.startMs <= s.startMs + 150);
    const emphasis = [...new Set(segs.flatMap((t) => t.emphasisWords ?? []))].filter((w) => s.text.toLowerCase().includes(String(w).toLowerCase()));
    const label = labels[s.id] ?? heuristicLabel(s.text);
    out.push({
      id: `seg-${card.id}-${s.id}`, source: "reference", cardId: card.id, productType: card.meta?.productType ?? "app", role: dominant.role ?? label.role,
      text: s.text, durationMs: Math.round(s.endMs - s.startMs), lineFeatures: label.features,
      treatment: {
        visual: !cover.length ? "talk" : startsOnCover ? "broll" : "talk→broll", ...(brollAtWord !== null ? { brollAtWord } : {}),
        ...(cover.length ? { layout: cover[0].layout ?? "full", assetType: cover[0].assetType ?? "other" } : {}), ...(talk ? { zoom: talk.zoom } : {}), emphasisWords: emphasis,
        what_zh: [...new Set(segs.map((t) => t.what_zh).filter(Boolean))].join("；").slice(0, 160),
      },
      prevRole: null, nextRole: null,
    });
  }
  out.forEach((s, i) => { s.prevRole = out[i - 1]?.role ?? null; s.nextRole = out[i + 1]?.role ?? null; });
  return out;
}
export const syncCardSegments = async (card, opts) => { const added = card.status === "confirmed" ? await segmentsFromCard(card, opts) : []; await replaceSegments((s) => s.source === "reference" && s.cardId === card.id, added); return added.length; };
export const removeCardSegments = (cardId) => replaceSegments((s) => s.source === "reference" && s.cardId === cardId, []);

// ---- retrieval -----------------------------------------------------------------------------------------------------------------
const STOP = new Set(["the", "and", "you", "for", "that", "this", "with", "was", "are", "have", "has", "had", "but", "not", "its", "it's", "just", "your", "from", "they", "them", "then", "than", "what", "when", "will", "can", "all", "out", "about", "into", "like", "more", "some", "one", "get", "got"]);
const tokens = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n += 1; return n / (a.size + b.size - n); };
// No embedding model yet: wording overlap and length stand in for the text-vector similarity of the spec (same weights).
export function scoreSegment(beat, seg, productType) {
  const lex = 0.7 * jaccard(tokens(beat.text), tokens(seg.text)) + 0.3 * (Math.min(beat.text.length, seg.text.length) / Math.max(beat.text.length, seg.text.length, 1));
  const feat = jaccard(new Set(beat.features ?? []), new Set(seg.lineFeatures ?? []));
  return 0.5 * lex + 0.3 * feat + 0.2 * (SOURCE_WEIGHT[seg.source] ?? 0.5) + (productType && seg.productType === productType ? 0.03 : 0);
}
// beats: [{ id, text, role, features }]. Up to k per beat, at most one per source video / project (so one reference cannot fill the list).
export function retrieveExamples(beats, library, { cardId = null, excludeCardId = null, productType = null, k = 3 } = {}) {
  let pool = library;
  if (cardId) pool = pool.filter((s) => s.cardId === cardId);
  if (excludeCardId) pool = pool.filter((s) => s.cardId !== excludeCardId);
  const out = {};
  for (const beat of beats) {
    let cand = pool.filter((s) => s.role === beat.role);
    if (cand.length < k) cand = [...cand, ...pool.filter((s) => s.role !== beat.role)];
    const ranked = cand.map((s) => ({ s, score: scoreSegment(beat, s, productType) })).sort((a, b) => b.score - a.score);
    const picked = [], seen = new Set();
    for (const { s } of ranked) {
      const group = s.cardId ?? s.projectId ?? s.id;
      if (seen.has(group)) continue;
      seen.add(group); picked.push(s);
      if (picked.length >= k) break;
    }
    if (picked.length) out[beat.id] = picked;
  }
  return out;
}
const treatmentLine = (t, text) => {
  const words = text.split(/\s+/);
  const parts = [t.visual === "talk" ? "creator" : t.visual === "broll" ? "cut to B-roll" : "creator, then B-roll"];
  if (t.zoom) parts.push(t.zoom);
  if (t.emphasisWords?.length) parts.push(`emphasis "${t.emphasisWords.join(", ")}"`);
  if (t.layout && t.visual !== "talk") parts.push(`${t.layout === "pip" ? "pip" : "full-screen"} ${String(t.assetType ?? "").replace(/_/g, " ")}${t.brollAtWord !== undefined && t.brollAtWord !== null ? ` at word ${t.brollAtWord + 1} ("${words[t.brollAtWord] ?? ""}")` : ""}`.trim());
  else if (t.visual === "talk") parts.push("no B-roll");
  return parts.join(", ");
};
export function examplesText(beats, examples) {
  const blocks = beats.filter((b) => examples[b.id]).map((b) => `${b.id} [${b.role} | ${(b.features ?? []).join(", ") || "no tags"}]\n${examples[b.id].map((s) => `  - "${s.text}" (${(s.durationMs / 1000).toFixed(1)}s, ${s.source === "reference" ? "reference" : s.source === "human_edited" ? "editor-polished" : "accepted"}) → ${treatmentLine(s.treatment, s.text)}`).join("\n")}`);
  return blocks.length ? `REFERENCE EXAMPLES (how good editors treated similar lines; adapt to this product and these assets, never copy assets)\n\n${blocks.join("\n")}` : "";
}

// ---- tendencies of the whole library (for the creative-direction call) ------------------------------------------------------------
export function tendenciesText(library) {
  const refs = library.length;
  if (refs < 8) return "";
  const cards = new Set(library.map((s) => s.cardId ?? s.projectId)).size;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const lines = [];
  for (const role of ROLE_IDS) {
    const rows = library.filter((s) => s.role === role);
    if (rows.length < 2) continue;
    const talk = rows.filter((s) => s.treatment.visual === "talk");
    const broll = rows.filter((s) => s.treatment.visual !== "talk");
    const withZoom = rows.filter((s) => s.treatment.zoom);
    const avg = rows.reduce((t, s) => t + s.durationMs, 0) / rows.length / 1000;
    const bits = [`avg ${avg.toFixed(1)}s`, `B-roll ${pct(broll.length, rows.length)}%`];
    if (broll.length) bits.push(`pip ${pct(broll.filter((s) => s.treatment.layout === "pip").length, broll.length)}% / full ${pct(broll.filter((s) => s.treatment.layout !== "pip").length, broll.length)}%`);
    if (withZoom.length) bits.push(`z115+ ${pct(withZoom.filter((s) => ["z115", "z120"].includes(s.treatment.zoom)).length, withZoom.length)}% of creator shots`);
    if (talk.length) bits.push(`creator only ${pct(talk.length, rows.length)}%`);
    lines.push(`${role}: ${bits.join("; ")}`);
  }
  return lines.length ? `LIBRARY TENDENCIES (from ${cards} sources, ${refs} segments)\n${lines.join("\n")}` : "";
}

import { z } from "zod";
import { getEffect, isEffectId } from "./effects/catalog.ts";
import { checkLayout, type FaceAnalysis, type FaceOverrides, type LayoutWarning, type SafeZones } from "./layout.ts";
import { cardSchema, role, styleSchema, versionedId, type Card, type Rule, type StylePack, type TasteRules } from "./library.ts";
import { id, publicPath, sha256 } from "./primitives.ts";
import { resolvePlan } from "./resolve.ts";
import { parseEditPlan, PlanError, type EditPlanInput } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// Project files that come before the edit-plan: project.json, assets.json,
// analysis/beats.json, storyboard/<round>/option-*.json and selection.json,
// and the compiler that turns a chosen option into edit-plan v1.
// See docs/storyboard-desk-design.md.

export const projectSchema = z.strictObject({
  id,
  title: z.string(),
  market: z.string().default("US"),
  language: z.string().default("en"),
  output: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() }),
  footage: id,
  transcript: z.strictObject({ words: publicPath, cues: publicPath }),
});
export type ProjectInfo = z.output<typeof projectSchema>;

export const assetsSchema = z.strictObject({
  version: z.literal(1),
  items: z.array(
    z.strictObject({
      id,
      kind: z.enum(["footage", "image", "logo", "proof", "video", "audio"]),
      status: z.enum(["available", "candidate", "missing"]),
      label: z.string().optional(),
      file: publicPath.optional(),
      originalName: z.string().optional(),
      sha256: sha256.optional(),
      source: z.string().optional(),
      approvedBy: z.enum(["user"]).optional(),
      neededBy: z.array(z.string()).default([]),
      shotRequest: z.record(z.string(), z.string()).optional(),
      candidates: z.array(z.strictObject({ file: publicPath, frame: z.number().int().nonnegative().optional(), ms: z.number().optional(), note: z.string().optional() })).default([]),
      note: z.string().optional(),
    }),
  ),
  claims: z.array(
    z.strictObject({
      id,
      text: z.string(),
      status: z.enum(["unverified", "verified", "rejected"]),
      evidence: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
});
export type Assets = z.output<typeof assetsSchema>;

export const beatsSchema = z.strictObject({
  version: z.literal(1),
  confirmedAt: z.string().nullable().default(null),
  beats: z.array(
    z.strictObject({
      id,
      role,
      words: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
      text: z.string(),
      textZh: z.string().optional(),
      claims: z.array(id).default([]),
    }),
  ),
});
export type Beats = z.output<typeof beatsSchema>;

const cardUse = z.strictObject({ card: versionedId, slots: z.record(z.string(), z.unknown()).default({}), claims: z.array(id).default([]) });
export const optionSchema = z.strictObject({
  id: z.string().regex(/^option-[a-z]$/),
  round: z.string().regex(/^r[1-9]\d*$/),
  title: z.string(),
  style: versionedId,
  summary: z.string(),
  rows: z.array(
    z.strictObject({
      beat: id,
      keep: z.boolean(),
      reason: z.string().optional(),
      onScreen: z.string().optional(),
      cards: z.array(cardUse).default([]),
    }),
  ),
  global: z.array(cardUse).default([]),
  keyframes: z.array(z.strictObject({ frame: z.number().int().nonnegative(), file: z.string(), label: z.string() })).default([]),
  createdBy: z.string().default("claude"),
  createdAt: z.string().optional(),
});
export type StoryboardOption = z.output<typeof optionSchema>;

export const selectionSchema = z.strictObject({
  round: z.string(),
  option: z.string().nullable().default(null),
  state: z.enum(["draft", "confirmed"]).default("draft"),
  style: versionedId.nullable().default(null),
  layoutOverrides: z.record(z.string(), z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).default({}),
  confirmedAt: z.string().nullable().default(null),
  updatedAt: z.string().optional(),
});
export type Selection = z.output<typeof selectionSchema>;

// Shown in previews where an option needs an asset that does not exist yet.
export const MISSING_PLACEHOLDER = "desk/placeholder-missing.png";

export type CompileInput = {
  project: ProjectInfo;
  assets: Assets;
  beats: Beats;
  option: StoryboardOption;
  cards: Record<string, Card>;
  styles: Record<string, StylePack>;
  selection: Selection | null;
  transcript: Transcript;
  tasteRules: TasteRules | null;
  layout?: { faces: FaceAnalysis | null; overrides: FaceOverrides | null; safeZones: SafeZones | null };
};

export type CompileNeed = { card: string; slot: string; asset: string; label: string; status: "available" | "candidate" | "missing" | "unknown" };
export type CompileClaim = { id: string; text: string; status: string; usedBy: string[] };
export type CompileResult = {
  plan: EditPlanInput | null;
  problems: string[];
  warnings: (LayoutWarning | { kind: "rule"; target: string; message: string })[];
  needs: CompileNeed[];
  claims: CompileClaim[];
  segments: { id: string; beats: string[] }[];
  gate: { canConfirm: boolean; reasons: string[] };
};

// Beats must start and end on caption-cue boundaries so a cut never splits a
// caption. Returns cue word ranges (by timing containment, like the resolver).
export const cueWordRanges = (transcript: Transcript) =>
  transcript.cues.map((cue) => {
    const inside = transcript.words.map((word, index) => ({ word, index })).filter(({ word }) => word.startMs >= cue.startMs && word.endMs <= cue.endMs);
    return { cue, first: inside[0]?.index ?? -1, last: inside[inside.length - 1]?.index ?? -1 };
  });

export const checkBeats = (beats: Beats, transcript: Transcript): string[] => {
  const problems: string[] = [];
  const ranges = cueWordRanges(transcript);
  const starts = new Set(ranges.map((range) => range.first));
  const ends = new Set(ranges.map((range) => range.last));
  let expected = 0;
  beats.beats.forEach((beat, index) => {
    const [first, last] = beat.words;
    if (first !== expected) problems.push(`beats[${index}] (${beat.id}): starts at word ${first}, expected ${expected} (beats must cover the transcript in order without gaps)`);
    if (last < first) problems.push(`beats[${index}] (${beat.id}): ends before it starts`);
    if (!starts.has(first)) problems.push(`beats[${index}] (${beat.id}): word ${first} is not the first word of a caption cue`);
    if (!ends.has(last)) problems.push(`beats[${index}] (${beat.id}): word ${last} is not the last word of a caption cue`);
    expected = last + 1;
  });
  if (expected !== transcript.words.length) problems.push(`beats end at word ${expected - 1}, the transcript has ${transcript.words.length} words`);
  return problems;
};

// --- Template filling.
const getPath = (value: unknown, path: string[]): unknown => path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);

const fill = (template: unknown, values: Record<string, unknown>, style: StylePack, where: string, problems: string[]): unknown => {
  if (typeof template === "string") {
    if (template.startsWith("@style.")) {
      const path = template.slice(7).replace(/\$(\w+)/g, (_, name: string) => String(values[name])).split(".");
      const found = getPath(style.parts, path);
      if (found === undefined) problems.push(`${where}: style ${style.id} has no value for ${template}`);
      return structuredClone(found);
    }
    if (/^\$\w+$/.test(template)) {
      const name = template.slice(1);
      if (!(name in values)) problems.push(`${where}: no value for ${template}`);
      return values[name];
    }
    return template;
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, values, style, where, problems));
  if (template && typeof template === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(template as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (key === "$merge") Object.assign(result, fill(value, values, style, where, problems) as object);
    }
    for (const [key, value] of entries) if (key !== "$merge") result[key] = fill(value, values, style, where, problems);
    return result;
  }
  return template;
};

export function compileOption(input: CompileInput): CompileResult {
  const { project, assets, beats, option, cards, transcript } = input;
  const problems: string[] = [];
  const warnings: CompileResult["warnings"] = [];
  const needs: CompileNeed[] = [];
  const claimUse = new Map<string, Set<string>>();
  const recordClaim = (claim: string, by: string) => claimUse.set(claim, (claimUse.get(claim) ?? new Set()).add(by));
  const done = (plan: EditPlanInput | null, segments: CompileResult["segments"] = []): CompileResult => {
    const claims = [...claimUse].map(([claimId, users]) => {
      const claim = assets.claims.find((item) => item.id === claimId);
      if (!claim) problems.push(`claim "${claimId}" is not listed in assets.json claims`);
      return { id: claimId, text: claim?.text ?? claimId, status: claim?.status ?? "unknown", usedBy: [...users] };
    });
    const reasons = [
      ...(problems.length ? [`${problems.length} 个编译错误`] : []),
      ...(beats.confirmedAt ? [] : ["段落角色还没有确认"]),
      ...needs.filter((need) => need.status !== "available").map((need) => `缺素材：${need.label}（${need.asset}）`),
      ...claims.filter((claim) => claim.status !== "verified").map((claim) => `产品事实未核实：${claim.text}`),
    ];
    return { plan, problems, warnings, needs, claims, segments, gate: { canConfirm: reasons.length === 0, reasons } };
  };

  const styleId = input.selection?.style ?? option.style;
  const style = input.styles[styleId];
  if (!style) {
    problems.push(`style ${styleId} is not in library/styles`);
    return done(null);
  }
  problems.push(...checkBeats(beats, transcript));
  const beatById = new Map(beats.beats.map((beat) => [beat.id, beat]));
  for (const row of option.rows) if (!beatById.has(row.beat)) problems.push(`rows: unknown beat "${row.beat}"`);
  for (const beat of beats.beats) if (!option.rows.some((row) => row.beat === beat.id)) problems.push(`rows: beat "${beat.id}" is missing; every beat needs a row (keep or not, with a reason)`);
  if (problems.length) return done(null);

  // --- Card checks shared by beat and global cards.
  const uses: { use: StoryboardOption["global"][number]; card: Card; beat: Beats["beats"][number] | null; where: string }[] = [];
  const countByCard = new Map<string, number>();
  const register = (use: StoryboardOption["global"][number], beatId: string | null, where: string) => {
    const card = cards[use.card];
    if (!card) return problems.push(`${where}: card ${use.card} is not in library/techniques`);
    if (card.status !== "ready") return problems.push(`${where}: card ${card.id}（${card.name}）is ${card.status}${card.blockedBy.length ? `, needs ${card.blockedBy.join(", ")}` : ""}`);
    const beat = beatId ? beatById.get(beatId)! : null;
    if (card.scope === "beat" && !beat) return problems.push(`${where}: ${card.id} must be used on a beat row`);
    if (card.scope === "global" && beat) return problems.push(`${where}: ${card.id} is a global card; put it in "global"`);
    if (beat && !card.when.roles.includes(beat.role)) problems.push(`${where}: ${card.id} is for ${card.when.roles.join("/")} beats, ${beat.id} is ${beat.role}`);
    countByCard.set(card.id, (countByCard.get(card.id) ?? 0) + 1);
    uses.push({ use, card, beat, where });
    for (const claim of use.claims) recordClaim(claim, `${card.id} on ${beat?.id ?? "video"}`);
  };
  option.rows.forEach((row, index) => {
    if (row.keep) row.cards.forEach((use, cardIndex) => register(use, row.beat, `rows[${index}] (${row.beat}).cards[${cardIndex}]`));
    else if (row.cards.length) problems.push(`rows[${index}] (${row.beat}): a dropped beat cannot carry cards`);
    else if (!row.reason) problems.push(`rows[${index}] (${row.beat}): give a reason for dropping the beat`);
  });
  option.global.forEach((use, index) => register(use, null, `global[${index}]`));

  // --- Order: cold-open beats first, then the rest in source order.
  const kept = option.rows.filter((row) => row.keep).map((row) => beatById.get(row.beat)!);
  const first = uses.filter(({ card }) => card.template.moveBeatFirst).map(({ beat }) => beat!);
  if (first.length > 1) problems.push(`only one beat can be moved to the start, got ${first.map((beat) => beat.id).join(", ")}`);
  const ordered = [...first, ...kept.filter((beat) => !first.includes(beat))];
  if (!ordered.length) problems.push("the option keeps no beat");
  for (const beat of kept) for (const claim of beat.claims) recordClaim(claim, `spoken in ${beat.id}`);

  // --- Segments: runs of beats that are adjacent in the source become one cut.
  const ranges = cueWordRanges(transcript);
  const cueOf = (word: number) => ranges.find((range) => word >= range.first && word <= range.last)!.cue;
  const segments: { id: string; beats: typeof ordered; startMs: number; endMs: number }[] = [];
  for (const beat of ordered) {
    const last = segments[segments.length - 1];
    if (last && last.beats[last.beats.length - 1].words[1] + 1 === beat.words[0]) {
      last.beats.push(beat);
      last.endMs = cueOf(beat.words[1]).endMs;
    } else segments.push({ id: "", beats: [beat], startMs: cueOf(beat.words[0]).startMs, endMs: cueOf(beat.words[1]).endMs });
  }
  for (const segment of segments) segment.id = `s-${segment.beats.map((beat) => beat.id).join("-")}`;
  const segmentOfBeat = (beatId: string) => segments.find((segment) => segment.beats.some((beat) => beat.id === beatId))!;
  const segmentOfWord = (word: number) => segments.find((segment) => segment.beats.some((beat) => word >= beat.words[0] && word <= beat.words[1]));

  // --- Cards -> overlays and punch-ins.
  const assetEntries: EditPlanInput["assets"] = {};
  const footage = assets.items.find((item) => item.id === project.footage);
  if (!footage?.file || footage.kind !== "footage") problems.push(`assets.json: footage "${project.footage}" with a file is required`);
  else assetEntries[footage.id] = { type: "video", path: footage.file, ...(footage.sha256 ? { sha256: footage.sha256 } : {}) };

  const overlays: Record<string, unknown>[] = [];
  const punchIns = new Map<string, Record<string, unknown>[]>();
  const usedIds = new Set<string>();
  for (const { use, card, beat, where } of uses) {
    if (card.when.position === "opening" && beat && ordered[0] !== beat) problems.push(`${where}: ${card.id} must open the video; ${beat.id} is not the first beat`);
    const values: Record<string, unknown> = {};
    for (const [name, slot] of Object.entries(card.slots)) {
      const value = use.slots[name] ?? slot.default;
      if (value === undefined) {
        if (slot.required) problems.push(`${where}: slot "${name}"（${slot.label}）is required`);
        continue;
      }
      if (slot.type === "word") {
        const word = Number(value);
        if (!Number.isInteger(word) || !transcript.words[word]) problems.push(`${where}: slot "${name}" word ${value} does not exist`);
        else if (beat && (word < beat.words[0] || word > beat.words[1])) problems.push(`${where}: slot "${name}" word ${word} ("${transcript.words[word].text}") is outside beat ${beat.id} (${beat.words[0]}–${beat.words[1]})`);
        else if (!segmentOfWord(word)) problems.push(`${where}: slot "${name}" word ${word} is in a dropped beat`);
        else values.expect = transcript.words[word].text.replace(/[^\p{L}\p{N}']/gu, "") || transcript.words[word].text;
      }
      if (slot.type === "choice" && slot.options && !slot.options.includes(String(value))) problems.push(`${where}: slot "${name}" must be one of ${slot.options.join(", ")}`);
      if (slot.type === "number" && (typeof value !== "number" || (slot.min !== undefined && value < slot.min) || (slot.max !== undefined && value > slot.max))) {
        problems.push(`${where}: slot "${name}" must be a number in ${slot.min}–${slot.max}`);
      }
      if (slot.type === "asset") {
        const need = card.needs.find((item) => item.slot === name);
        const item = assets.items.find((entry) => entry.id === value);
        needs.push({ card: card.id, slot: name, asset: String(value), label: need?.label ?? slot.label, status: item?.status ?? "unknown" });
        // Previewing before the asset is approved: a candidate shows its
        // first candidate still, a missing asset a placeholder. The gate keeps
        // such a plan from being confirmed.
        const file = item?.status === "available" ? item.file : item?.status === "candidate" ? item.candidates[0]?.file : undefined;
        const assetId = String(value);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(assetId)) problems.push(`${where}: slot "${name}" asset id "${assetId}" is not a valid id`);
        else assetEntries[assetId] = file ? { type: item?.kind === "video" ? "video" : "image", path: file, ...(item?.status === "available" && item.sha256 ? { sha256: item.sha256 } : {}) } : { type: "image", path: MISSING_PLACEHOLDER };
      }
      values[name] = value;
    }
    const rules: Rule[] = [...card.rules, ...(input.tasteRules?.rules.filter((rule) => rule.status === "approved" && rule.check &&(!rule.appliesTo.length || rule.appliesTo.includes(card.id))).map((rule) => rule.check!) ?? [])];
    for (const rule of rules) {
      if (!("check" in rule)) continue;
      if (rule.check === "maxPerVideo" && (countByCard.get(card.id) ?? 0) > rule.value) problems.push(`${where}: ${card.id} may be used at most ${rule.value}× per video`);
      if (rule.check === "maxChars" && typeof values[rule.slot] === "string" && (values[rule.slot] as string).length > rule.value) {
        problems.push(`${where}: "${rule.slot}" has ${(values[rule.slot] as string).length} characters, at most ${rule.value}`);
      }
      if (rule.check === "opening" && beat && ordered[0] !== beat) problems.push(`${where}: ${card.id} must be on the first beat`);
    }
    const base = `${card.id.split("@")[0]}-${beat?.id ?? "all"}`;
    let overlayId = base;
    for (let index = 2; usedIds.has(overlayId); index++) overlayId = `${base}-${index}`;
    usedIds.add(overlayId);
    Object.assign(values, { id: overlayId, segment: beat ? segmentOfBeat(beat.id).id : undefined });
    const filled = fill(card.template, values, style, where, problems) as Card["template"];
    overlays.push(...filled.overlays);
    for (const punch of filled.punchIns) {
      const segment = segmentOfWord(Number(values.word));
      if (segment) punchIns.set(segment.id, [...(punchIns.get(segment.id) ?? []), punch]);
    }
  }

  // --- Layout overrides from the storyboard desk (dragging an element).
  for (const [overlayId, rect] of Object.entries(input.selection?.layoutOverrides ?? {})) {
    const overlay = overlays.find((item) => item.id === overlayId);
    if (!overlay) {
      warnings.push({ kind: "rule", target: overlayId, message: `layout override for ${overlayId} no longer matches an element; ignored` });
      continue;
    }
    const effect = String(overlay.effect);
    if (!isEffectId(effect)) continue;
    const box = getEffect(effect).box;
    overlay.props = { ...(overlay.props as object), [box.x]: rect.x, [box.y]: rect.y, [box.width]: rect.width, [box.height]: rect.height };
  }

  if (problems.length) return done(null, segments.map((segment) => ({ id: segment.id, beats: segment.beats.map((beat) => beat.id) })));

  const plan: EditPlanInput = {
    schemaVersion: 1,
    id: project.id,
    meta: {
      title: project.title,
      storyboard: { round: option.round, option: option.id, style: style.id, title: option.title },
      compiledBy: "src/engine/storyboard.ts compileOption",
    },
    output: { width: project.output.width, height: project.output.height, fps: project.output.fps },
    theme: { background: style.theme.background, textColor: style.theme.textColor, fontFamily: style.theme.fontFamily, fonts: style.theme.fonts },
    assets: assetEntries,
    transcript: { asset: project.footage, words: project.transcript.words, cues: project.transcript.cues },
    segments: segments.map((segment) => ({
      id: segment.id,
      asset: project.footage,
      sourceStartMs: segment.startMs,
      sourceEndMs: segment.endMs,
      ...(punchIns.get(segment.id) ? { camera: { punchIns: punchIns.get(segment.id) as never } } : {}),
    })),
    layout: { footage: { ...style.layout.box, borderRadius: style.layout.borderRadius, fit: "cover", ...(style.layout.grade ? { grade: style.layout.grade } : {}) } },
    captions: { ...style.captions, wordGap: 12, maxLines: 2, balanceWeight: 0.2, emphasis: [] },
    overlays: overlays as EditPlanInput["overlays"],
    audio: { segmentAudio: true },
    qc: { maxTruePeakDb: -1 },
  };

  // A card's fixed duration may run past the end when its word is near the
  // end of the video: end such overlays with the video instead.
  try {
    const probe = structuredClone(plan);
    for (const overlay of probe.overlays ?? []) if (overlay.durationFrames !== undefined) {
      delete overlay.durationFrames;
      overlay.until = { fromEnd: 0 };
    }
    const probed = resolvePlan(parseEditPlan(probe), transcript);
    probed.overlays.forEach((resolvedOverlay, index) => {
      const overlay = plan.overlays![index];
      if (overlay.durationFrames !== undefined && resolvedOverlay.from + overlay.durationFrames > probed.durationInFrames) {
        delete overlay.durationFrames;
        overlay.until = { fromEnd: 0 };
      }
    });
  } catch {
    // Reported by the full validation below.
  }

  // Phase 1 validation and the layout checks, as for any edit-plan.
  try {
    const resolved = resolvePlan(parseEditPlan(plan), transcript);
    if (input.layout) {
      const layoutWarnings = checkLayout(resolved, { assetIds: Object.fromEntries(segments.map((segment) => [segment.id, project.footage])), ...input.layout });
      warnings.push(...layoutWarnings);
      for (const { card } of uses) {
        const limit = card.rules.find((rule): rule is Extract<Rule, { check: "noFaceOverlap" }> => "check" in rule && rule.check === "noFaceOverlap");
        if (!limit) continue;
        for (const warning of layoutWarnings) {
          if (warning.kind === "face" && warning.target.startsWith(card.id.split("@")[0]) && warning.coverage > limit.max) {
            warnings.push({ kind: "rule", target: warning.target, message: `${card.name}的规则：遮挡人脸不超过 ${limit.max * 100}%（${warning.message}）` });
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof PlanError) problems.push(...error.problems.map((problem) => `edit-plan: ${problem}`));
    else throw error;
  }
  return done(problems.length ? null : plan, segments.map((segment) => ({ id: segment.id, beats: segment.beats.map((beat) => beat.id) })));
}

export const parseCard = (input: unknown) => cardSchema.parse(input);
export const parseStyle = (input: unknown) => styleSchema.parse(input);

import { z } from "zod";
import { hexColor, id, publicPath } from "./primitives.ts";

// The technique library (library/): technique cards, style packs and the
// editor's approved taste rules. A storyboard option is a set of cards with
// their slots filled; src/engine/storyboard.ts compiles it into an edit-plan.
// See docs/storyboard-desk-design.md.

export const versionedId = z.string().regex(/^[a-z0-9][a-z0-9-]*@\d+$/, 'Write ids as "<name>@<version>", e.g. "hook-big-text@1"');

export const ROLES = ["hook", "intro", "pain", "benefit", "proof", "product", "dose", "offer", "cta", "filler"] as const;
export const role = z.enum(ROLES);

// Rules with "check" are enforced by the compiler; text-only rules guide Claude.
export const ruleSchema = z.union([
  z.strictObject({ check: z.literal("noFaceOverlap"), max: z.number().min(0).max(1).default(0.1), text: z.string().optional() }),
  z.strictObject({ check: z.literal("safeZone"), text: z.string().optional() }),
  z.strictObject({ check: z.literal("maxPerVideo"), value: z.number().int().positive(), text: z.string().optional() }),
  z.strictObject({ check: z.literal("maxChars"), slot: z.string(), value: z.number().int().positive(), text: z.string().optional() }),
  z.strictObject({ check: z.literal("claimVerified"), text: z.string().optional() }),
  z.strictObject({ check: z.literal("opening"), text: z.string().optional() }),
  z.strictObject({ text: z.string().min(1) }),
]);
export type Rule = z.output<typeof ruleSchema>;

const slotSchema = z.strictObject({
  type: z.enum(["word", "beat", "text", "asset", "choice", "number"]),
  label: z.string(),
  required: z.boolean().default(true),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.unknown().optional(),
});

const needSchema = z.strictObject({
  slot: z.string(),
  kind: z.enum(["image", "logo", "proof", "video", "audio"]),
  label: z.string(),
  accept: z.string(),
  fallback: z.enum(["candidate-from-footage", "shoot", "user-supplies"]),
  shotRequest: z.record(z.string(), z.string()).optional(),
});

export const cardSchema = z.strictObject({
  id: versionedId,
  name: z.string(),
  category: z.enum(["hook", "caption", "rhythm", "benefit", "proof", "cta", "transition", "audio"]),
  status: z.enum(["ready", "needs-effect", "needs-model", "draft"]),
  // What is missing for needs-effect / needs-model cards (effect ids, model names).
  blockedBy: z.array(z.string()).default([]),
  source: z.array(z.string()).min(1),
  description: z.string(),
  when: z.strictObject({
    roles: z.array(role).min(1),
    position: z.enum(["opening", "any", "closing"]).default("any"),
    minDurationMs: z.number().nonnegative().default(0),
    note: z.string().optional(),
  }),
  scope: z.enum(["beat", "global"]).default("beat"),
  slots: z.record(z.string(), slotSchema).default({}),
  needs: z.array(needSchema).default([]),
  // edit-plan fragments. "$slot" is replaced by a slot value, "@style.a.b" by
  // a style-pack value; special values are filled by the compiler:
  // "$segment" (segment id of the card's beat), "$id" (a stable overlay id),
  // "$expect" (the transcript word for the "word" slot).
  template: z
    .strictObject({
      overlays: z.array(z.record(z.string(), z.unknown())).default([]),
      punchIns: z.array(z.record(z.string(), z.unknown())).default([]),
      // Move the card's beat to the start of the video (cold open).
      moveBeatFirst: z.boolean().default(false),
    })
    .prefault({}),
  tunables: z.record(z.string(), z.strictObject({ label: z.string(), range: z.tuple([z.number(), z.number()]).optional(), options: z.array(z.string()).optional() })).default({}),
  rules: z.array(ruleSchema).default([]),
  examples: z.array(z.string()).default([]),
});
export type Card = z.output<typeof cardSchema>;

const captionStyle = z.strictObject({
  box: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  fontSize: z.number().positive(),
  lineHeight: z.number().positive(),
  fontWeight: z.number().int().default(800),
  color: hexColor,
  activeColor: hexColor,
  background: hexColor.optional(),
  textTransform: z.enum(["none", "uppercase"]).default("none"),
  singleLineMaxChars: z.number().int().positive().default(22),
});

export const styleSchema = z.strictObject({
  id: versionedId,
  name: z.string(),
  description: z.string(),
  theme: z.strictObject({
    background: hexColor,
    textColor: hexColor,
    fontFamily: z.string(),
    fonts: z.array(z.strictObject({ family: z.string(), src: publicPath, weight: z.number().int().default(400) })),
  }),
  layout: z.strictObject({
    box: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
    borderRadius: z.number().nonnegative().default(0),
    grade: z.strictObject({ brightness: z.number(), contrast: z.number(), saturate: z.number() }).optional(),
  }),
  captions: captionStyle,
  // Free-form values that card templates read as "@style.<key>.<prop>".
  parts: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type StylePack = z.output<typeof styleSchema>;

export const tasteRulesSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(
    z.strictObject({
      id: z.string().regex(/^t-\d{4}$/),
      text: z.string(),
      appliesTo: z.array(z.string()).default([]),
      check: ruleSchema.optional(),
      source: z.string(),
      // Claude proposes rules from the editor's comments; only approved ones apply.
      status: z.enum(["proposed", "approved"]),
      approvedAt: z.string().nullable(),
    }),
  ),
});
export type TasteRules = z.output<typeof tasteRulesSchema>;

export const libraryId = id;

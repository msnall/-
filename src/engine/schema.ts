import { z } from "zod";
import { effectIds, getEffect, isEffectId } from "./effects/catalog.ts";
import { box, frames, hexColor, id, positiveFrames, publicPath, px, sha256, size, type AssetType } from "./primitives.ts";

// edit-plan.json, schemaVersion 1.
//
// Two clocks exist in a plan:
// - Source time (milliseconds in an asset): segments.sourceStartMs/EndMs and
//   transcript words. Segments decide which source ranges are kept, in order.
// - Output time (frames of the finished video): computed from the segments.
// Anchors let overlays, punch-ins and audio either name an output frame
// directly or follow a transcript word / segment, which the resolver converts.

export const SCHEMA_VERSION = 1;

const asset = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("video"), path: publicPath, sha256: sha256.optional() }),
  z.strictObject({
    type: z.literal("imageSequence"),
    dir: publicPath,
    pattern: z.string().regex(/^[^/\\]*%0\d+d[^/\\]*$/, "Pattern must be a file name containing a zero-padded index such as frame-%04d.jpg"),
    frameCount: positiveFrames,
    fps: size,
  }),
  z.strictObject({ type: z.literal("image"), path: publicPath, sha256: sha256.optional() }),
  z.strictObject({ type: z.literal("audio"), path: publicPath, sha256: sha256.optional() }),
]);

const edge = z.enum(["start", "end"]).default("start");
export const anchorSchema = z.union(
  [
    z.strictObject({ frame: frames }),
    z.strictObject({ fromEnd: frames }),
    z.strictObject({
      word: z.number().int().nonnegative(),
      expect: z.string().min(1).optional(),
      edge,
      offsetMs: z.number().finite().default(0),
    }),
    z.strictObject({ segment: id, edge, offsetMs: z.number().finite().default(0) }),
  ],
  {
    error:
      'Anchor must be one of {"frame": n} (output frame), {"fromEnd": n} (frames before the end), {"word": index, "expect"?, "edge"?, "offsetMs"?} or {"segment": id, "edge"?, "offsetMs"?}',
  },
);

const camera = z.strictObject({
  zoom: z.number().min(1).max(4).default(1),
  originX: z.number().min(0).max(1).default(0.5),
  originY: z.number().min(0).max(1).default(0.5),
  punchIns: z
    .array(
      z.strictObject({
        at: anchorSchema,
        durationFrames: positiveFrames,
        zoom: z.number().min(1).max(4),
        rampFrames: frames.default(4),
      }),
    )
    .default([]),
});

const segment = z.strictObject({
  id,
  asset: id,
  sourceStartMs: z.number().finite().nonnegative(),
  sourceEndMs: z.number().finite().positive(),
  camera: camera.prefault({}),
});

const captions = z.strictObject({
  box,
  fontSize: size,
  lineHeight: size,
  fontWeight: z.number().int().min(100).max(900).default(700),
  color: hexColor,
  activeColor: hexColor,
  background: hexColor.optional(),
  wordGap: px.nonnegative().default(12),
  maxLines: z.number().int().min(1).max(2).default(2),
  singleLineMaxChars: z.number().int().positive().default(24),
  balanceWeight: z.number().nonnegative().default(0.2),
  textTransform: z.enum(["none", "uppercase"]).default("none"),
  emphasis: z
    .array(
      z.strictObject({
        word: z.number().int().nonnegative(),
        expect: z.string().min(1).optional(),
        color: hexColor.optional(),
        scale: z.number().min(1).max(2).default(1),
      }),
    )
    .default([]),
});

const overlay = z.strictObject({
  id,
  effect: z.string().regex(/^[a-z0-9-]+@\d+$/, 'Effect must be written as "<name>@<version>", e.g. "title-card@1"'),
  from: anchorSchema,
  until: anchorSchema.optional(),
  durationFrames: positiveFrames.optional(),
  layer: z.enum(["below-captions", "above-captions"]).default("below-captions"),
  props: z.record(z.string(), z.unknown()).default({}),
});

const audioTrack = z.strictObject({
  asset: id,
  from: anchorSchema.prefault({ frame: 0 }),
  volume: z.number().min(0).max(2).default(1),
});

export const editPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION, { error: `Only schemaVersion ${SCHEMA_VERSION} is supported by this engine` }),
    id,
    // Free-form notes (brief, reviewer, source of claims). Never read by the renderer.
    meta: z.record(z.string(), z.unknown()).optional(),
    output: z.strictObject({
      width: z.number().int().positive().multipleOf(2),
      height: z.number().int().positive().multipleOf(2),
      fps: z.number().int().min(1).max(120),
      encoding: z
        .strictObject({
          crf: z.number().int().min(0).max(51).default(18),
          x264Preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("veryfast"),
        })
        .prefault({}),
    }),
    theme: z.strictObject({
      background: hexColor,
      textColor: hexColor,
      fontFamily: z.string().min(1),
      fonts: z
        .array(
          z.strictObject({
            family: z.string().regex(/^[A-Za-z0-9 _-]+$/, "Font family names may only use letters, digits, spaces, _ and -"),
            src: publicPath,
            weight: z.number().int().min(100).max(900).default(400),
            style: z.enum(["normal", "italic"]).default("normal"),
          }),
        )
        .default([]),
    }),
    assets: z.record(id, asset),
    transcript: z.strictObject({ asset: id, words: publicPath, cues: publicPath }).optional(),
    segments: z.array(segment).min(1, "At least one segment is required"),
    layout: z.strictObject({
      footage: z.strictObject({
        ...box.shape,
        borderRadius: px.nonnegative().default(0),
        fit: z.enum(["cover", "contain", "fill"]).default("cover"),
        grade: z
          .strictObject({
            brightness: z.number().min(0).max(3).default(1),
            contrast: z.number().min(0).max(3).default(1),
            saturate: z.number().min(0).max(3).default(1),
          })
          .optional(),
      }),
    }),
    captions: captions.optional(),
    overlays: z.array(overlay).default([]),
    audio: z
      .strictObject({
        // Play the audio of each kept video segment (follows the cuts).
        segmentAudio: z.boolean().default(false),
        tracks: z.array(audioTrack).default([]),
        // Two-pass FFmpeg loudnorm on the finished mix, after Remotion renders.
        // The video stream is copied untouched. Turn off only when the audio
        // was already mastered (e.g. a pre-normalized mix track).
        loudness: z
          .strictObject({
            normalize: z.boolean().default(true),
            targetLufs: z.number().min(-40).max(-5).default(-16),
            truePeakDb: z.number().min(-9).max(0).default(-1.5),
            lra: z.number().min(1).max(20).default(11),
          })
          .prefault({}),
      })
      .prefault({}),
    qc: z
      .strictObject({
        // Defaults to audio.loudness.targetLufs when normalization is on.
        loudnessLufs: z.number().max(0).optional(),
        loudnessToleranceLu: z.number().positive().default(1.5),
        maxTruePeakDb: z.number().max(0).default(-1),
      })
      .prefault({}),
  })
  .superRefine((plan, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const assetOfType = (assetId: string, allowed: readonly AssetType[], path: (string | number)[]) => {
      const found = plan.assets[assetId];
      if (!found) issue(path, `Unknown asset "${assetId}". Declared assets: ${Object.keys(plan.assets).join(", ") || "(none)"}`);
      else if (!allowed.includes(found.type)) issue(path, `Asset "${assetId}" is a ${found.type}; expected ${allowed.join(" or ")}`);
    };
    const segmentIds = new Set<string>();
    const checkAnchor = (anchor: z.output<typeof anchorSchema>, path: (string | number)[]) => {
      if ("word" in anchor && !plan.transcript) issue(path, "Word anchors need a transcript section");
      if ("segment" in anchor && !segmentIds.has(anchor.segment)) issue(path, `Unknown segment "${anchor.segment}"`);
    };

    plan.segments.forEach((seg, index) => {
      if (segmentIds.has(seg.id)) issue(["segments", index, "id"], `Duplicate segment id "${seg.id}"`);
      segmentIds.add(seg.id);
      assetOfType(seg.asset, ["video", "imageSequence"], ["segments", index, "asset"]);
      if (seg.sourceEndMs <= seg.sourceStartMs) issue(["segments", index, "sourceEndMs"], "sourceEndMs must be greater than sourceStartMs");
      if (plan.audio.segmentAudio && plan.assets[seg.asset]?.type !== "video") {
        issue(["segments", index, "asset"], "audio.segmentAudio needs every segment to come from a video asset");
      }
    });
    plan.segments.forEach((seg, index) =>
      seg.camera.punchIns.forEach((punch, punchIndex) => checkAnchor(punch.at, ["segments", index, "camera", "punchIns", punchIndex, "at"])),
    );

    if (plan.transcript) assetOfType(plan.transcript.asset, ["video", "imageSequence"], ["transcript", "asset"]);
    if (plan.captions && !plan.transcript) issue(["captions"], "Captions need a transcript section");

    const overlayIds = new Set<string>();
    plan.overlays.forEach((item, index) => {
      const path = ["overlays", index];
      if (overlayIds.has(item.id)) issue([...path, "id"], `Duplicate overlay id "${item.id}"`);
      overlayIds.add(item.id);
      if ((item.until === undefined) === (item.durationFrames === undefined)) {
        issue(path, 'Give exactly one of "until" or "durationFrames"');
      }
      checkAnchor(item.from, [...path, "from"]);
      if (item.until) checkAnchor(item.until, [...path, "until"]);
      if (!isEffectId(item.effect)) {
        issue([...path, "effect"], `Effect "${item.effect}" is not registered. Registered effects: ${effectIds.join(", ")}`);
        return;
      }
      const definition = getEffect(item.effect);
      const parsed = definition.props.safeParse(item.props);
      if (!parsed.success) {
        for (const problem of parsed.error.issues) issue([...path, "props", ...problem.path.map((part) => (typeof part === "symbol" ? String(part) : part))], problem.message);
        return;
      }
      for (const [prop, allowed] of Object.entries(definition.assetProps)) {
        assetOfType(String(parsed.data[prop]), allowed, [...path, "props", prop]);
      }
    });

    plan.audio.tracks.forEach((track, index) => {
      assetOfType(track.asset, ["audio", "video"], ["audio", "tracks", index, "asset"]);
      checkAnchor(track.from, ["audio", "tracks", index, "from"]);
    });
  });

export type EditPlan = z.output<typeof editPlanSchema>;
export type EditPlanInput = z.input<typeof editPlanSchema>;
export type Asset = EditPlan["assets"][string];
export type Anchor = z.output<typeof anchorSchema>;

export class PlanError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`edit-plan is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "PlanError";
    this.problems = problems;
  }
}

const formatPath = (path: readonly PropertyKey[]) =>
  path.reduce<string>((text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`), "") || "(root)";

export const parseEditPlan = (input: unknown): EditPlan => {
  const result = editPlanSchema.safeParse(input);
  if (!result.success) throw new PlanError(result.error.issues.map((problem) => `${formatPath(problem.path)}: ${problem.message}`));
  return result.data;
};

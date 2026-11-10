import { z } from "zod";
import { assetRef, hexColor, px, size, frames, type AssetType } from "../primitives.ts";

// The effect registry. A plan may only reference effects listed here, as
// "<name>@<version>". Each entry owns the zod schema for its props; the React
// implementation lives in ./components.tsx and is type-checked against this
// list, so an effect cannot be registered without a component or vice versa.
//
// Changing the look of an approved effect means adding a new version
// (e.g. "title-card@2") rather than editing the old one, so earlier plans keep
// rendering the same way.

type EffectDefinition = {
  description: string;
  props: z.ZodType<Record<string, unknown>>;
  // Prop names that hold asset ids, with the asset types they accept.
  assetProps: Record<string, readonly AssetType[]>;
  // Smallest duration the effect can play in, given its parsed props.
  minDurationInFrames?: (props: Record<string, unknown>) => number;
  // Which props place the effect on the canvas. The review desk edits these
  // when an element is dragged or resized.
  box: { x: string; y: string; width: string; height: string };
  // Area the effect covers on the canvas (output px), from its parsed props.
  // Used for face and safe-zone checks; an estimate where the height depends
  // on text layout.
  bounds: (props: Record<string, unknown>) => { x: number; y: number; width: number; height: number };
};

type Placed = { x: number; y: number; width: number; height: number };
const placedBounds = (raw: Record<string, unknown>) => {
  const props = raw as Placed;
  return { x: props.x, y: props.y, width: props.width, height: props.height };
};
const placedBox = { x: "x", y: "y", width: "width", height: "height" };

const enterFade = z.strictObject({
  type: z.enum(["none", "fade", "fade-up"]).default("fade-up"),
  fadeFrames: frames.default(9),
  riseFrames: frames.default(10),
  risePx: px.default(14),
});
const exitFade = z.strictObject({
  type: z.enum(["none", "fade"]).default("fade"),
  fadeFrames: frames.default(8),
});

const titleCard = z.strictObject({
  text: z.string().min(1),
  x: px,
  y: px,
  width: size,
  minHeight: px.nonnegative().default(0),
  paddingX: px.nonnegative().default(32),
  paddingY: px.nonnegative().default(24),
  background: hexColor.optional(),
  color: hexColor.optional(),
  accentColor: hexColor.optional(),
  accentWidth: px.nonnegative().default(0),
  borderRadius: px.nonnegative().default(0),
  fontSize: size,
  lineHeight: size.default(1.2),
  letterSpacing: px.default(0),
  fontWeight: z.number().int().min(100).max(900).default(700),
  align: z.enum(["left", "center", "right"]).default("center"),
  textTransform: z.enum(["none", "uppercase"]).default("none"),
  enter: enterFade.prefault({}),
  exit: exitFade.prefault({}),
});

const imageCard = z.strictObject({
  asset: assetRef,
  x: px,
  y: px,
  width: size,
  height: size,
  fit: z.enum(["cover", "contain", "fill"]).default("contain"),
  background: hexColor.optional(),
  padding: px.nonnegative().default(0),
  borderRadius: px.nonnegative().default(0),
  shadow: z.boolean().default(false),
  enter: z.strictObject({ type: z.enum(["none", "fade", "pop"]).default("pop"), frames: frames.default(8) }).prefault({}),
  exit: z.strictObject({ type: z.enum(["none", "fade"]).default("fade"), frames: frames.default(6) }).prefault({}),
});

export const effectCatalog = {
  "title-card@1": {
    description: "Text card with optional background, left accent bar, fade/rise entrance and fade exit.",
    props: titleCard,
    assetProps: {},
    minDurationInFrames: (raw) => {
      const props = raw as z.output<typeof titleCard>;
      const enter = props.enter.type === "none" ? 0 : Math.max(props.enter.fadeFrames, props.enter.type === "fade-up" ? props.enter.riseFrames : 0);
      return enter + (props.exit.type === "none" ? 0 : props.exit.fadeFrames) + 1;
    },
    box: { x: "x", y: "y", width: "width", height: "minHeight" },
    // One line of text plus padding, or minHeight if larger.
    bounds: (raw) => {
      const props = raw as z.output<typeof titleCard>;
      const height = Math.max(props.minHeight, props.fontSize * props.lineHeight + props.paddingY * 2);
      return { x: props.x, y: props.y, width: props.width, height };
    },
  },
  "alpha-video@1": {
    description: "Pre-rendered transparent video (e.g. a HyperFrames WebM) placed on the canvas.",
    props: z.strictObject({ asset: assetRef, x: px, y: px, width: size, height: size }),
    assetProps: { asset: ["video"] },
    box: placedBox,
    bounds: placedBounds,
  },
  "image-card@1": {
    description: "Still image such as a real product photo, with pop/fade entrance.",
    props: imageCard,
    assetProps: { asset: ["image"] },
    minDurationInFrames: (raw) => {
      const props = raw as z.output<typeof imageCard>;
      return (props.enter.type === "none" ? 0 : props.enter.frames) + (props.exit.type === "none" ? 0 : props.exit.frames) + 1;
    },
    box: placedBox,
    bounds: placedBounds,
  },
  "rect@1": {
    description: "Solid rectangle, e.g. a divider line or colour block.",
    props: z.strictObject({
      x: px,
      y: px,
      width: size,
      height: size,
      color: hexColor,
      borderRadius: px.nonnegative().default(0),
      opacity: z.number().min(0).max(1).default(1),
    }),
    assetProps: {},
    box: placedBox,
    bounds: placedBounds,
  },
  "fade-through-black@1": {
    description: "A short black dip centered on an edit boundary.",
    props: z.strictObject({}),
    assetProps: {},
    minDurationInFrames: () => 8,
    box: placedBox,
    bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  },
} satisfies Record<string, EffectDefinition>;

export type EffectId = keyof typeof effectCatalog;
export type EffectProps<K extends EffectId> = z.output<(typeof effectCatalog)[K]["props"]>;
export const effectIds = Object.keys(effectCatalog) as EffectId[];

export const isEffectId = (value: string): value is EffectId => Object.prototype.hasOwnProperty.call(effectCatalog, value);

export const getEffect = (effect: EffectId): EffectDefinition => effectCatalog[effect];

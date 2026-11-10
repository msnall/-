import { Img, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { ResolvedPlan } from "../resolve.ts";
import type { EffectId, EffectProps } from "./catalog.ts";

export type EffectComponentProps<K extends EffectId> = {
  props: EffectProps<K>;
  durationInFrames: number;
  assets: ResolvedPlan["assets"];
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const assetPath = (assets: ResolvedPlan["assets"], id: string) => {
  const asset = assets[id];
  if (!asset || asset.type === "imageSequence") throw new Error(`Asset "${id}" cannot be drawn as a single file`);
  return staticFile(asset.path);
};

const TitleCard: React.FC<EffectComponentProps<"title-card@1">> = ({ props, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { enter, exit } = props;
  const enterOpacity = enter.type === "none" || enter.fadeFrames === 0 ? 1 : interpolate(frame, [0, enter.fadeFrames], [0, 1], clamp);
  const exitOpacity =
    exit.type === "none" || exit.fadeFrames === 0
      ? 1
      : interpolate(frame, [durationInFrames - exit.fadeFrames, durationInFrames - 1], [1, 0], clamp);
  const y = enter.type === "fade-up" && enter.riseFrames > 0 ? interpolate(frame, [0, enter.riseFrames], [enter.risePx, 0], { extrapolateRight: "clamp" }) : 0;
  return (
    <div
      data-effect="title-card"
      style={{
        position: "absolute", left: props.x, top: props.y, width: props.width, minHeight: props.minHeight,
        boxSizing: "border-box", display: "flex", alignItems: "center",
        justifyContent: props.align === "left" ? "flex-start" : props.align === "right" ? "flex-end" : "center",
        textAlign: props.align,
        padding: `${props.paddingY}px ${props.paddingX}px`,
        ...(props.background ? { backgroundColor: props.background } : {}),
        ...(props.color ? { color: props.color } : {}),
        ...(props.accentWidth > 0 ? { borderLeft: `${props.accentWidth}px solid ${props.accentColor ?? props.color ?? "currentColor"}` } : {}),
        ...(props.borderRadius ? { borderRadius: props.borderRadius } : {}),
        ...(props.textTransform === "uppercase" ? { textTransform: "uppercase" as const } : {}),
        fontSize: props.fontSize, lineHeight: props.lineHeight, letterSpacing: props.letterSpacing, fontWeight: props.fontWeight,
        opacity: enterOpacity * exitOpacity, transform: `translateY(${y}px)`,
      }}
    >
      {props.text}
    </div>
  );
};

const AlphaVideo: React.FC<EffectComponentProps<"alpha-video@1">> = ({ props, assets }) => (
  <OffthreadVideo
    src={assetPath(assets, props.asset)}
    transparent
    muted
    style={{ position: "absolute", left: props.x, top: props.y, width: props.width, height: props.height }}
  />
);

const ImageCard: React.FC<EffectComponentProps<"image-card@1">> = ({ props, durationInFrames, assets }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { enter, exit } = props;
  const enterProgress =
    enter.type === "none" || enter.frames === 0
      ? 1
      : enter.type === "pop"
        ? spring({ frame, fps, durationInFrames: enter.frames, config: { damping: 14, stiffness: 180 } })
        : interpolate(frame, [0, enter.frames], [0, 1], clamp);
  const exitOpacity = exit.type === "none" || exit.frames === 0 ? 1 : interpolate(frame, [durationInFrames - exit.frames, durationInFrames - 1], [1, 0], clamp);
  const scale = enter.type === "pop" ? interpolate(enterProgress, [0, 1], [0.85, 1]) : 1;
  return (
    <div
      data-effect="image-card"
      style={{
        position: "absolute", left: props.x, top: props.y, width: props.width, height: props.height,
        boxSizing: "border-box", padding: props.padding, borderRadius: props.borderRadius, overflow: "hidden",
        ...(props.background ? { backgroundColor: props.background } : {}),
        ...(props.shadow ? { boxShadow: "0 18px 48px rgba(0, 0, 0, 0.22)" } : {}),
        opacity: Math.min(1, enterProgress) * exitOpacity, transform: `scale(${scale})`,
      }}
    >
      <Img src={assetPath(assets, props.asset)} style={{ width: "100%", height: "100%", objectFit: props.fit, display: "block" }} />
    </div>
  );
};

const Rect: React.FC<EffectComponentProps<"rect@1">> = ({ props }) => (
  <div
    data-effect="rect"
    style={{
      position: "absolute", left: props.x, top: props.y, width: props.width, height: props.height, backgroundColor: props.color,
      ...(props.borderRadius ? { borderRadius: props.borderRadius } : {}),
      ...(props.opacity !== 1 ? { opacity: props.opacity } : {}),
    }}
  />
);

const FadeThroughBlack: React.FC<EffectComponentProps<"fade-through-black@1">> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const middle = (durationInFrames - 1) / 2;
  const opacity = Math.max(0, 1 - Math.abs(frame - middle) / middle);
  return <div style={{ position: "absolute", inset: 0, background: "#000", opacity, pointerEvents: "none" }} />;
};

// Every catalog entry must have a component (and nothing else may be listed).
export const effectComponents: { [K in EffectId]: React.FC<EffectComponentProps<K>> } = {
  "title-card@1": TitleCard,
  "alpha-video@1": AlphaVideo,
  "image-card@1": ImageCard,
  "rect@1": Rect,
  "fade-through-black@1": FadeThroughBlack,
};

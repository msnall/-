import { useEffect, useState } from "react";
import { AbsoluteFill, Audio, cancelRender, continueRender, delayRender, Sequence, staticFile, type CalculateMetadataFunction } from "remotion";
import { Captions } from "./Captions.tsx";
import { effectComponents, type EffectComponentProps } from "./effects/components.tsx";
import type { EffectId } from "./effects/catalog.ts";
import { Footage } from "./Footage.tsx";
import { loadEditPlan, type ResolvedPlan } from "./load.ts";

// Props: the raw edit-plan as written in projects/<id>/edit-plan.json.
// calculateMetadata validates and resolves it, then hands the component the
// resolved timeline; the component never interprets the raw plan.
export type EditPlanProps = { plan: unknown; resolved?: ResolvedPlan };

export const calculateEditPlanMetadata: CalculateMetadataFunction<EditPlanProps> = async ({ props, abortSignal }) => {
  if (props.plan === null || props.plan === undefined) return {
    width: 1080, height: 1920, fps: 30, durationInFrames: 90, props,
  };
  const { resolved } = await loadEditPlan(props.plan, async (publicPath) => {
    const response = await fetch(staticFile(publicPath), { signal: abortSignal });
    if (!response.ok) throw new Error(`Cannot load public/${publicPath} (HTTP ${response.status})`);
    return response.json();
  });
  return {
    width: resolved.width,
    height: resolved.height,
    fps: resolved.fps,
    durationInFrames: resolved.durationInFrames,
    props: { ...props, resolved },
  };
};

const fontFormat = (src: string) => {
  const extension = src.split(".").pop()?.toLowerCase();
  return extension === "woff2" ? "woff2" : extension === "woff" ? "woff" : extension === "otf" ? "opentype" : "truetype";
};

const Overlay: React.FC<{ overlay: ResolvedPlan["overlays"][number]; assets: ResolvedPlan["assets"] }> = ({ overlay, assets }) => {
  const Component = effectComponents[overlay.effect] as React.FC<EffectComponentProps<EffectId>>;
  return (
    <Sequence from={overlay.from} durationInFrames={overlay.durationInFrames} layout="none" name={overlay.id}>
      <Component props={overlay.props as EffectComponentProps<EffectId>["props"]} durationInFrames={overlay.durationInFrames} assets={assets} />
    </Sequence>
  );
};

export const EditPlanVideo: React.FC<EditPlanProps> = ({ resolved }) => {
  if (!resolved) throw new Error("EditPlanVideo needs a resolved plan; it is produced by calculateEditPlanMetadata");
  const { theme } = resolved;
  const [fontHandle] = useState(() => (theme.fonts.length ? delayRender("Loading edit-plan fonts") : null));
  const [fontsReady, setFontsReady] = useState(fontHandle === null);
  useEffect(() => {
    if (fontHandle === null) return;
    Promise.all(theme.fonts.map((font) => document.fonts.load(`${font.style === "italic" ? "italic " : ""}${font.weight} 58px "${font.family}"`)))
      .then(() => setFontsReady(true))
      .catch(cancelRender);
  }, [fontHandle, theme.fonts]);
  // Release the frame only after the text that measures itself (captions) has
  // been laid out with the real font.
  useEffect(() => {
    if (fontsReady && fontHandle !== null) continueRender(fontHandle);
  }, [fontsReady, fontHandle]);
  const fontFaces = theme.fonts
    .map(
      (font) =>
        `@font-face { font-family: "${font.family}"; src: url("${staticFile(font.src)}") format("${fontFormat(font.src)}"); font-weight: ${font.weight}; font-style: ${font.style}; font-display: block; }`,
    )
    .join("\n");
  const layer = (name: ResolvedPlan["overlays"][number]["layer"]) =>
    resolved.overlays.filter((overlay) => overlay.layer === name).map((overlay) => <Overlay key={overlay.id} overlay={overlay} assets={resolved.assets} />);
  return (
    <AbsoluteFill style={{ backgroundColor: theme.background, fontFamily: theme.fontFamily, color: theme.textColor }}>
      {fontFaces ? <style>{fontFaces}</style> : null}
      <Footage footage={resolved.footage} segmentAudio={resolved.audio.segmentAudio} />
      {resolved.audio.tracks.map((track, index) => (
        <Sequence key={index} from={track.from} layout="none" name={`audio ${index}`}>
          <Audio src={staticFile(track.src)} {...(track.volume !== 1 ? { volume: track.volume } : {})} />
        </Sequence>
      ))}
      {layer("below-captions")}
      {resolved.captions && fontsReady ? <Captions captions={resolved.captions} /> : null}
      {layer("above-captions")}
    </AbsoluteFill>
  );
};

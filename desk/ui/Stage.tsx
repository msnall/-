import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { EditPlanVideo } from "../../src/engine/EditPlanVideo.tsx";
import { getEffect, type EffectId } from "../../src/engine/effects/catalog.ts";
import { intersection, overlayBounds, type FaceZone, type Rect, type SafeZones } from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import type { RawPlan } from "./api.ts";

export type Selection = { kind: "overlay"; id: string } | { kind: "captions" } | { kind: "segment"; id: string } | null;
export type Toggles = { safeZones: boolean; faces: boolean; captionBox: boolean };

type Props = {
  playerRef: RefObject<PlayerRef | null>;
  preview: RawPlan;
  resolved: ResolvedPlan;
  frame: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  toggles: Toggles;
  faceZones: FaceZone[];
  safeZones: SafeZones | null;
  editableFace: boolean;
  onOverlayBox: (id: string, rect: Rect, commit: boolean) => void;
  onCaptionBox: (rect: Rect, commit: boolean) => void;
  onFaceBox: (rect: Rect, commit: boolean) => void;
  previewing: string | null;
};

const round = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(4, Math.round(rect.width)), height: Math.max(4, Math.round(rect.height)) });

type Handle = "move" | "nw" | "ne" | "sw" | "se";

// A box on the canvas that can be moved and resized. Works in canvas pixels;
// `scale` converts screen movement back to canvas pixels.
const EditBox: React.FC<{
  rect: Rect;
  scale: number;
  className: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  onChange?: (rect: Rect, commit: boolean) => void;
  shape?: "rect" | "ellipse";
}> = ({ rect, scale, className, label, selected, onSelect, onChange, shape = "rect" }) => {
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Rect; last: Rect } | null>(null);
  const [ghost, setGhost] = useState<Rect | null>(null);
  const begin = (handle: Handle) => (event: React.PointerEvent) => {
    event.stopPropagation();
    onSelect();
    if (!onChange) return;
    (event.target as Element).setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: rect, last: rect };
    setGhost(rect);
  };
  const move = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state || !onChange) return;
    const dx = (event.clientX - state.x) / scale;
    const dy = (event.clientY - state.y) / scale;
    const { start } = state;
    let next: Rect = { ...start };
    const { handle } = state;
    if (handle === "move") next = { ...start, x: start.x + dx, y: start.y + dy };
    else {
      if (handle === "nw" || handle === "sw") next = { ...next, x: start.x + dx, width: start.width - dx };
      if (handle === "ne" || handle === "se") next = { ...next, width: start.width + dx };
      if (handle === "nw" || handle === "ne") next = { ...next, y: start.y + dy, height: start.height - dy };
      if (handle === "sw" || handle === "se") next = { ...next, height: start.height + dy };
    }
    state.last = round(next);
    onChange(state.last, false);
  };
  const end = () => {
    const state = drag.current;
    drag.current = null;
    setGhost(null);
    if (state && onChange && JSON.stringify(state.last) !== JSON.stringify(state.start)) onChange(state.last, true);
  };
  const style = { left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderRadius: shape === "ellipse" ? "50% / 44%" : undefined };
  return (
    <>
      {ghost ? <div className="ghost" style={{ left: ghost.x, top: ghost.y, width: ghost.width, height: ghost.height }} /> : null}
      <div className={`edit-box ${className}${selected ? " selected" : ""}`} style={style} onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <span className="box-label" style={{ transform: `scale(${1 / scale})` }}>
          {label}
        </span>
        {selected && onChange
          ? (["nw", "ne", "sw", "se"] as const).map((handle) => (
              <span key={handle} className={`handle ${handle}`} style={{ transform: `scale(${1 / scale})` }} onPointerDown={begin(handle)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
            ))
          : null}
      </div>
    </>
  );
};

export const Stage: React.FC<Props> = (props) => {
  const { resolved, frame, selection, toggles, safeZones, faceZones } = props;
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 300, height: 500 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(size.width / resolved.width, size.height / resolved.height);
  const width = resolved.width * scale;
  const height = resolved.height * scale;
  const inputProps = useMemo(() => ({ plan: props.preview, resolved }), [props.preview, resolved]);

  const active = resolved.overlays.filter((overlay) => (frame >= overlay.from && frame < overlay.from + overlay.durationInFrames) || (selection?.kind === "overlay" && selection.id === overlay.id));
  const captionVisible = resolved.captions?.cues.some((cue) => frame >= cue.from && frame < cue.to) ?? false;

  // Live check of the selected element at this frame.
  const selectedRect: Rect | null =
    selection?.kind === "overlay"
      ? (() => {
          const overlay = resolved.overlays.find((item) => item.id === selection.id);
          return overlay ? overlayBounds(overlay) : null;
        })()
      : selection?.kind === "captions" && resolved.captions
        ? resolved.captions.box
        : null;
  let tag: { ok: boolean; text: string } | null = null;
  if (selectedRect) {
    const area = (rect: Rect | null) => (rect ? rect.width * rect.height : 0);
    const faceCover = Math.max(0, ...faceZones.map((face) => area(intersection(face, selectedRect)) / Math.max(1, area(face))));
    const zones = (safeZones?.zones ?? []).filter((zone) => area(intersection(zone, selectedRect)) / Math.max(1, area(selectedRect)) > 0.05);
    const outside = area(intersection(selectedRect, { x: 0, y: 0, width: resolved.width, height: resolved.height })) < area(selectedRect) - 0.5;
    const problems = [
      ...(faceCover > 0.1 ? [`遮挡人脸 ${(faceCover * 100).toFixed(0)}%`] : []),
      ...zones.map((zone) => `进入${zone.label}`),
      ...(outside ? ["超出画面"] : []),
    ];
    tag = problems.length ? { ok: false, text: `⚠ ${problems.join(" · ")}` } : { ok: true, text: `✓ 未遮挡人脸 · 未进入安全区${faceZones.length ? "" : "（此帧未检测到人脸）"}` };
  }

  return (
    <div className="stage" ref={host} onPointerDown={() => props.onSelect(null)}>
      <div className="stage-frame" style={{ width, height }}>
        <Player
          ref={props.playerRef}
          component={EditPlanVideo}
          inputProps={inputProps}
          durationInFrames={resolved.durationInFrames}
          fps={resolved.fps}
          compositionWidth={resolved.width}
          compositionHeight={resolved.height}
          style={{ width, height }}
          controls={false}
          clickToPlay={false}
          acknowledgeRemotionLicense
        />
        <div className="canvas-layer" style={{ width: resolved.width, height: resolved.height, transform: `scale(${scale})` }}>
          {toggles.safeZones
            ? safeZones?.zones.map((zone) => (
                <div key={zone.id} className="safe-zone" style={{ left: zone.x, top: zone.y, width: zone.width, height: zone.height }}>
                  <span className="zone-label" style={{ transform: `scale(${1 / scale})` }}>
                    {zone.label}
                  </span>
                </div>
              ))
            : null}
          {toggles.faces
            ? faceZones.map((face, index) => (
                <EditBox
                  key={`face-${index}`}
                  rect={face}
                  scale={scale}
                  shape="ellipse"
                  className={`face-zone ${face.source}`}
                  label={face.source === "manual" ? "人脸（手动）" : "人脸（自动）"}
                  selected={props.editableFace}
                  onSelect={() => {}}
                  onChange={props.editableFace ? props.onFaceBox : undefined}
                />
              ))
            : null}
          {toggles.captionBox && resolved.captions ? (
            <EditBox
              rect={resolved.captions.box}
              scale={scale}
              className={`caption-box${captionVisible ? "" : " idle"}`}
              label="字幕框"
              selected={selection?.kind === "captions"}
              onSelect={() => props.onSelect({ kind: "captions" })}
              onChange={props.onCaptionBox}
            />
          ) : null}
          {active.map((overlay) => {
            const box = getEffect(overlay.effect as EffectId).box;
            return (
              <EditBox
                key={overlay.id}
                rect={overlayBounds(overlay)}
                scale={scale}
                className={`overlay-box${frame >= overlay.from && frame < overlay.from + overlay.durationInFrames ? "" : " idle"}`}
                label={`${overlay.id} · ${overlay.effect}${box.height === "minHeight" ? "（高度为估计）" : ""}`}
                selected={selection?.kind === "overlay" && selection.id === overlay.id}
                onSelect={() => props.onSelect({ kind: "overlay", id: overlay.id })}
                onChange={(rect, commit) => props.onOverlayBox(overlay.id, rect, commit)}
              />
            );
          })}
          {tag && selectedRect ? (
            <div className={`check-tag ${tag.ok ? "ok" : "bad"}`} style={{ left: selectedRect.x, top: selectedRect.y + selectedRect.height + 12 / scale, transform: `scale(${1 / scale})` }}>
              {tag.text}
            </div>
          ) : null}
        </div>
        {props.previewing ? <div className="previewing-banner">正在预览 {props.previewing}（未采纳）</div> : null}
      </div>
    </div>
  );
};

import { interpolate } from "remotion";
import { getEffect } from "./effects/catalog.ts";
import type { ResolvedOverlay, ResolvedPlan, ResolvedSegment } from "./resolve.ts";

// Where things are on the canvas: camera zoom, overlay bounds, detected faces
// mapped through the footage layout, and the checks that warn when an overlay
// covers a face or a platform's UI. Shared by the review desk and the scripts.

export type Rect = { x: number; y: number; width: number; height: number };

// --- Faces, as written by scripts/detect-faces.mjs (projects/<id>/analysis/faces.json).
// Boxes are normalized (0–1) to the source picture, so they stay valid when
// the edit (cuts, layout, zoom) changes.
export type DetectedFace = Rect & { score: number };
export type FaceTrack = { width: number; height: number; sampleFps: number; samples: { ms: number; faces: DetectedFace[] }[] };
export type FaceAnalysis = { version: 1; model: { name: string; sha256: string; runtime: string }; createdAt: string; assets: Record<string, FaceTrack> };
// Manual corrections (projects/<id>/analysis/faces.overrides.json): a box
// replaces the detection for a whole segment; null means "no face here".
export type FaceOverrides = { version: 1; segments: Record<string, Rect | null> };

export type SafeZones = { platform: string; width: number; height: number; zones: (Rect & { id: string; label: string })[] };

export const zoomAt = (camera: ResolvedSegment["camera"], frame: number) => {
  let zoom = camera.zoom;
  for (const punch of camera.punchIns) {
    const local = frame - punch.from;
    if (local < 0 || local >= punch.durationInFrames) continue;
    const ramp = punch.rampFrames;
    const amount =
      ramp === 0
        ? 1
        : interpolate(local, [0, ramp, punch.durationInFrames - ramp, punch.durationInFrames], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
    zoom = camera.zoom + (punch.zoom - camera.zoom) * amount;
  }
  return zoom;
};

export const overlayBounds = (overlay: Pick<ResolvedOverlay, "effect" | "props">): Rect => getEffect(overlay.effect).bounds(overlay.props);

export const intersection = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};
const area = (rect: Rect | null) => (rect ? rect.width * rect.height : 0);
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

export const segmentAt = (resolved: ResolvedPlan, frame: number) =>
  resolved.footage.segments.find((segment) => frame >= segment.from && frame < segment.from + segment.durationInFrames);

// Faces near a source time, merged over a short window so a face zone does not
// flicker between samples. Normalized source coordinates.
// In each sample the best detection counts from MIN_SCORE (a turned or partly
// covered face scores low); further detections must be confident, because the
// short-range model sometimes scores a hand or packaging at 0.5–0.8.
const WINDOW_MS = 300;
const MIN_SCORE = 0.5;
const MIN_SECONDARY_SCORE = 0.85;
export const facesAtSourceMs = (track: FaceTrack, ms: number): Rect[] => {
  const zones: Rect[] = [];
  for (const sample of track.samples) {
    if (Math.abs(sample.ms - ms) > WINDOW_MS) continue;
    const best = Math.max(0, ...sample.faces.map((face) => face.score));
    for (const face of sample.faces) {
      if (face.score < (face.score === best ? MIN_SCORE : MIN_SECONDARY_SCORE)) continue;
      const index = zones.findIndex((zone) => area(intersection(zone, face)) > 0.2 * Math.min(area(zone), area(face)));
      if (index === -1) zones.push({ x: face.x, y: face.y, width: face.width, height: face.height });
      else zones[index] = union(zones[index], face);
    }
  }
  return zones;
};

// Normalized source rect -> output px, through the footage box, its fit and
// the segment's camera zoom at that frame. Clipped to the footage box.
export const sourceRectToOutput = (rect: Rect, picture: { width: number; height: number }, resolved: ResolvedPlan, segment: ResolvedSegment, frame: number): Rect | null => {
  const { footage } = resolved;
  const bw = footage.width;
  const bh = footage.height;
  let scaleX: number;
  let scaleY: number;
  if (footage.fit === "fill") {
    scaleX = bw / picture.width;
    scaleY = bh / picture.height;
  } else {
    const scale = footage.fit === "cover" ? Math.max(bw / picture.width, bh / picture.height) : Math.min(bw / picture.width, bh / picture.height);
    scaleX = scale;
    scaleY = scale;
  }
  const offsetX = (bw - picture.width * scaleX) / 2;
  const offsetY = (bh - picture.height * scaleY) / 2;
  const zoom = zoomAt(segment.camera, frame - segment.from);
  const originX = segment.camera.originX * bw;
  const originY = segment.camera.originY * bh;
  const mapX = (u: number) => originX + (offsetX + u * picture.width * scaleX - originX) * zoom;
  const mapY = (v: number) => originY + (offsetY + v * picture.height * scaleY - originY) * zoom;
  const mapped = { x: mapX(rect.x), y: mapY(rect.y), width: mapX(rect.x + rect.width) - mapX(rect.x), height: mapY(rect.y + rect.height) - mapY(rect.y) };
  const clipped = intersection(mapped, { x: 0, y: 0, width: bw, height: bh });
  return clipped ? { ...clipped, x: clipped.x + footage.x, y: clipped.y + footage.y } : null;
};

// Inverse of sourceRectToOutput (without clipping): an output-px rect drawn on
// the canvas -> normalized source rect, for manual face corrections.
export const outputRectToSource = (rect: Rect, picture: { width: number; height: number }, resolved: ResolvedPlan, segment: ResolvedSegment, frame: number): Rect => {
  const { footage } = resolved;
  const bw = footage.width;
  const bh = footage.height;
  const fill = footage.fit === "fill";
  const scale = footage.fit === "cover" ? Math.max(bw / picture.width, bh / picture.height) : Math.min(bw / picture.width, bh / picture.height);
  const scaleX = fill ? bw / picture.width : scale;
  const scaleY = fill ? bh / picture.height : scale;
  const offsetX = (bw - picture.width * scaleX) / 2;
  const offsetY = (bh - picture.height * scaleY) / 2;
  const zoom = zoomAt(segment.camera, frame - segment.from);
  const originX = segment.camera.originX * bw;
  const originY = segment.camera.originY * bh;
  const unmapX = (x: number) => (originX + (x - footage.x - originX) / zoom - offsetX) / (picture.width * scaleX);
  const unmapY = (y: number) => (originY + (y - footage.y - originY) / zoom - offsetY) / (picture.height * scaleY);
  const x = unmapX(rect.x);
  const y = unmapY(rect.y);
  return { x, y, width: unmapX(rect.x + rect.width) - x, height: unmapY(rect.y + rect.height) - y };
};

export const sourceMsAt =(resolved: ResolvedPlan, segment: ResolvedSegment, frame: number) => segment.sourceStartMs + ((frame - segment.from) * 1000) / resolved.fps;

export type FaceZone = Rect & { source: "detected" | "manual" };

// Face zones on the output canvas at an output frame.
export const faceZonesAt = (resolved: ResolvedPlan, assetIds: Record<string, string>, faces: FaceAnalysis | null, overrides: FaceOverrides | null, frame: number): FaceZone[] => {
  const segment = segmentAt(resolved, frame);
  if (!segment) return [];
  const track = faces?.assets[assetIds[segment.id]];
  const override = overrides?.segments[segment.id];
  if (override === null) return [];
  if (!track) return [];
  const picture = { width: track.width, height: track.height };
  const rects = override ? [override] : facesAtSourceMs(track, sourceMsAt(resolved, segment, frame));
  const source = override ? "manual" : "detected";
  return rects.flatMap((rect) => {
    const mapped = sourceRectToOutput(rect, picture, resolved, segment, frame);
    return mapped ? [{ ...mapped, source } as FaceZone] : [];
  });
};

export type LayoutWarning = {
  kind: "face" | "safe-zone" | "off-canvas";
  target: string;
  message: string;
  fromFrame: number;
  toFrame: number;
  coverage: number;
  zone?: string;
};

export const FACE_COVERAGE_LIMIT = 0.1;
export const SAFE_ZONE_COVERAGE_LIMIT = 0.05;

type Target = { id: string; label: string; bounds: Rect; from: number; to: number };

// Warnings, never errors: the editor decides. Checks every `step` frames.
export const checkLayout = (
  resolved: ResolvedPlan,
  context: { assetIds: Record<string, string>; faces: FaceAnalysis | null; overrides: FaceOverrides | null; safeZones: SafeZones | null },
  step = 3,
): LayoutWarning[] => {
  const warnings: LayoutWarning[] = [];
  const targets: Target[] = resolved.overlays.map((overlay) => ({
    id: overlay.id,
    label: `overlay ${overlay.id}`,
    bounds: overlayBounds(overlay),
    from: overlay.from,
    to: overlay.from + overlay.durationInFrames,
  }));
  if (resolved.captions) {
    for (const cue of resolved.captions.cues) {
      const previous = targets[targets.length - 1] as Target | undefined;
      if (previous?.id === "captions" && cue.from <= previous.to + 1) previous.to = Math.max(previous.to, cue.to);
      else targets.push({ id: "captions", label: "caption box", bounds: resolved.captions.box, from: cue.from, to: cue.to });
    }
  }
  const canvas = { x: 0, y: 0, width: resolved.width, height: resolved.height };
  const fmt = (frame: number) => `${frame} (${(frame / resolved.fps).toFixed(2)} s)`;
  const seenStatic = new Set<string>();

  for (const target of targets) {
    const ownArea = area(target.bounds);
    const staticKey = `${target.id}:${JSON.stringify(target.bounds)}`;
    if (!seenStatic.has(staticKey)) {
      seenStatic.add(staticKey);
      const inside = area(intersection(target.bounds, canvas));
      if (ownArea > 0 && inside < ownArea - 0.5) {
        warnings.push({ kind: "off-canvas", target: target.id, message: `${target.label} extends past the canvas edge`, fromFrame: target.from, toFrame: target.to, coverage: 1 - inside / ownArea });
      }
      for (const zone of context.safeZones?.zones ?? []) {
        const coverage = ownArea > 0 ? area(intersection(target.bounds, zone)) / ownArea : 0;
        if (coverage > SAFE_ZONE_COVERAGE_LIMIT) {
          warnings.push({
            kind: "safe-zone",
            target: target.id,
            zone: zone.id,
            coverage,
            fromFrame: target.from,
            toFrame: target.to,
            message: `${target.label}: ${(coverage * 100).toFixed(0)}% lies in the ${context.safeZones!.platform} ${zone.id} zone (${zone.label})`,
          });
        }
      }
    }
    if (!context.faces) continue;
    let run = null as { from: number; to: number; coverage: number } | null;
    const flush = () => {
      if (!run) return;
      warnings.push({
        kind: "face",
        target: target.id,
        coverage: run.coverage,
        fromFrame: run.from,
        toFrame: run.to,
        message: `${target.label} covers up to ${(run.coverage * 100).toFixed(0)}% of a face, frames ${fmt(run.from)}–${fmt(run.to)}`,
      });
      run = null;
    };
    for (let frame = target.from; frame < target.to; frame += step) {
      let coverage = 0;
      for (const face of faceZonesAt(resolved, context.assetIds, context.faces, context.overrides, frame)) {
        const faceArea = area(face);
        if (faceArea > 0) coverage = Math.max(coverage, area(intersection(face, target.bounds)) / faceArea);
      }
      if (coverage > FACE_COVERAGE_LIMIT) {
        if (run) {
          run.to = Math.min(frame + step, target.to);
          run.coverage = Math.max(run.coverage, coverage);
        } else run = { from: frame, to: Math.min(frame + step, target.to), coverage };
      } else flush();
    }
    flush();
  }
  return warnings;
};

// segment id -> asset id, for faceZonesAt / checkLayout.
export const segmentAssets = (plan: { segments: { id: string; asset: string }[] }) => Object.fromEntries(plan.segments.map((segment) => [segment.id, segment.asset]));

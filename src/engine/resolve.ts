import { getEffect, type EffectId } from "./effects/catalog.ts";
import { PlanError, type Anchor, type Asset, type EditPlan } from "./schema.ts";
import { normalizeWord, type Transcript } from "./transcript.ts";

// Turns a validated plan (+ transcript) into everything the renderer needs,
// with every time expressed in output frames. The renderer never sees source
// times, anchors or effect ids it has not been told how to draw.

export type ResolvedSource =
  | { type: "video"; src: string; trimBefore: number }
  | { type: "imageSequence"; dir: string; pattern: string; frameCount: number; startIndex: number; assetFps: number };

export type ResolvedPunchIn = { from: number; durationInFrames: number; zoom: number; rampFrames: number };

export type ResolvedSegment = {
  id: string;
  from: number;
  durationInFrames: number;
  sourceStartMs: number;
  sourceEndMs: number;
  source: ResolvedSource;
  camera: { zoom: number; originX: number; originY: number; punchIns: ResolvedPunchIn[] };
};

export type ResolvedCaptionWord = { text: string; startMs: number; endMs: number; wordIndex: number; color?: string; scale: number };
export type ResolvedCue = { from: number; to: number; startMs: number; lines: ResolvedCaptionWord[][] };

export type ResolvedOverlay = {
  id: string;
  effect: EffectId;
  from: number;
  durationInFrames: number;
  layer: "below-captions" | "above-captions";
  props: Record<string, unknown>;
};

export type ResolvedPlan = {
  engineVersion: 1;
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  theme: EditPlan["theme"];
  assets: EditPlan["assets"];
  footage: EditPlan["layout"]["footage"] & { segments: ResolvedSegment[] };
  captions: (Omit<NonNullable<EditPlan["captions"]>, "emphasis"> & { cues: ResolvedCue[] }) | null;
  overlays: ResolvedOverlay[];
  audio: { segmentAudio: boolean; tracks: { src: string; from: number; volume: number }[] };
  report: { droppedCues: number; captionWords: number };
};

export type AssetFacts = { durationMs?: Record<string, number> };

export const assetFile = (asset: Asset): string => (asset.type === "imageSequence" ? `${asset.dir}/${asset.pattern}` : asset.path);

export const imageSequenceFile = (dir: string, pattern: string, index: number) =>
  `${dir}/${pattern.replace(/%0(\d+)d/, (_, width: string) => String(index).padStart(Number(width), "0"))}`;

// The same two-line balancing used by the Bloom10 r1 captions.
export const splitCaptionLines = (text: string, maxLines: number, singleLineMaxChars: number, balanceWeight: number): string[][] => {
  const pieces = text.split(" ");
  if (maxLines === 1 || text.length <= singleLineMaxChars || pieces.length < 2) return [pieces];
  let split = 1;
  let best = Infinity;
  for (let index = 1; index < pieces.length; index++) {
    const left = pieces.slice(0, index).join(" ").length;
    const right = pieces.slice(index).join(" ").length;
    const score = Math.max(left, right) + Math.abs(left - right) * balanceWeight;
    if (score < best) {
      best = score;
      split = index;
    }
  }
  return [pieces.slice(0, split), pieces.slice(split)];
};

export const resolvePlan = (plan: EditPlan, transcript: Transcript | null, facts: AssetFacts = {}): ResolvedPlan => {
  const problems: string[] = [];
  const fps = plan.output.fps;
  const msToFrames = (ms: number) => Math.round((ms * fps) / 1000);

  // --- Output timeline: kept source ranges, back to back.
  let cursor = 0;
  const timeline = plan.segments.map((seg, index) => {
    const asset = plan.assets[seg.asset];
    const durationInFrames = msToFrames(seg.sourceEndMs - seg.sourceStartMs);
    if (durationInFrames < 1) problems.push(`segments[${index}] (${seg.id}): shorter than one frame`);
    const availableMs =
      asset.type === "imageSequence" ? (asset.frameCount * 1000) / asset.fps : facts.durationMs?.[seg.asset];
    if (availableMs !== undefined && seg.sourceEndMs > availableMs + 1000 / fps) {
      problems.push(`segments[${index}] (${seg.id}): sourceEndMs ${seg.sourceEndMs} is past the end of asset "${seg.asset}" (${Math.round(availableMs)} ms)`);
    }
    const source: ResolvedSource =
      asset.type === "imageSequence"
        ? { type: "imageSequence", dir: asset.dir, pattern: asset.pattern, frameCount: asset.frameCount, startIndex: Math.round((seg.sourceStartMs * asset.fps) / 1000), assetFps: asset.fps }
        : { type: "video", src: assetFile(asset), trimBefore: msToFrames(seg.sourceStartMs) };
    const entry = { seg, from: cursor, durationInFrames, source };
    cursor += durationInFrames;
    return entry;
  });
  const durationInFrames = cursor;

  // Source ms of the transcript asset -> output position.
  const locate = (assetId: string, ms: number) =>
    timeline.find(({ seg }) => seg.asset === assetId && ms >= seg.sourceStartMs && ms <= seg.sourceEndMs);
  const sourceMsToOutputMs = (entry: (typeof timeline)[number], ms: number) => (entry.from * 1000) / fps + (ms - entry.seg.sourceStartMs);

  const describeWord = (index: number) => {
    const word = transcript?.words[index];
    return word ? `word ${index} "${word.text}" (${(word.startMs / 1000).toFixed(2)}s in source)` : `word ${index}`;
  };
  const checkWord = (index: number, expect: string | undefined, where: string) => {
    const word = transcript?.words[index];
    if (!word) {
      problems.push(`${where}: word ${index} does not exist (transcript has ${transcript?.words.length ?? 0} words, indexed from 0)`);
      return null;
    }
    if (expect !== undefined && normalizeWord(word.text) !== normalizeWord(expect)) {
      problems.push(`${where}: expected word ${index} to be "${expect}" but the transcript has "${word.text}". The transcript changed; update the index.`);
      return null;
    }
    return word;
  };

  const resolveAnchor = (anchor: Anchor, where: string): number | null => {
    if ("frame" in anchor) return anchor.frame;
    if ("fromEnd" in anchor) return durationInFrames - anchor.fromEnd;
    if ("segment" in anchor) {
      const entry = timeline.find(({ seg }) => seg.id === anchor.segment)!;
      const base = anchor.edge === "start" ? entry.from : entry.from + entry.durationInFrames;
      return base + msToFrames(anchor.offsetMs);
    }
    const word = checkWord(anchor.word, anchor.expect, where);
    if (!word || !plan.transcript) return null;
    const ms = anchor.edge === "start" ? word.startMs : word.endMs;
    const entry = locate(plan.transcript.asset, ms);
    if (!entry) {
      problems.push(`${where}: ${describeWord(anchor.word)} falls in a part of the source that no segment keeps`);
      return null;
    }
    return Math.round((sourceMsToOutputMs(entry, ms) * fps) / 1000) + msToFrames(anchor.offsetMs);
  };

  const inRange = (from: number | null, to: number | null, where: string) => {
    if (from === null || to === null) return false;
    if (from < 0 || to > durationInFrames || to <= from) {
      problems.push(`${where}: resolves to frames ${from}–${to}, outside the video (0–${durationInFrames}) or empty`);
      return false;
    }
    return true;
  };

  // --- Footage segments with their camera moves.
  const segments: ResolvedSegment[] = timeline.map(({ seg, from, durationInFrames: length, source }, index) => {
    const punchIns: ResolvedPunchIn[] = [];
    seg.camera.punchIns.forEach((punch, punchIndex) => {
      const where = `segments[${index}].camera.punchIns[${punchIndex}]`;
      const start = resolveAnchor(punch.at, where);
      if (start === null) return;
      if (start < from || start + punch.durationFrames > from + length) {
        problems.push(`${where}: frames ${start}–${start + punch.durationFrames} leave segment ${seg.id} (${from}–${from + length})`);
        return;
      }
      if (punch.rampFrames * 2 > punch.durationFrames) problems.push(`${where}: rampFrames ×2 must fit inside durationFrames`);
      punchIns.push({ from: start - from, durationInFrames: punch.durationFrames, zoom: punch.zoom, rampFrames: punch.rampFrames });
    });
    const { zoom, originX, originY } = seg.camera;
    return { id: seg.id, from, durationInFrames: length, sourceStartMs: seg.sourceStartMs, sourceEndMs: seg.sourceEndMs, source, camera: { zoom, originX, originY, punchIns } };
  });

  // --- Captions: transcript cues mapped onto the output timeline.
  let captions: ResolvedPlan["captions"] = null;
  let droppedCues = 0;
  let captionWords = 0;
  if (plan.captions && transcript && plan.transcript) {
    const { emphasis, ...style } = plan.captions;
    const emphasisByWord = new Map<number, { color?: string; scale: number }>();
    emphasis.forEach((item, index) => {
      if (checkWord(item.word, item.expect, `captions.emphasis[${index}]`)) emphasisByWord.set(item.word, { color: item.color, scale: item.scale });
    });
    const cues: ResolvedCue[] = [];
    const indexed = transcript.words.map((word, wordIndex) => ({ ...word, wordIndex }));
    transcript.cues.forEach((cue, cueIndex) => {
      const where = `${plan.transcript!.cues} cue ${cueIndex} ("${cue.text}")`;
      const overlapping = timeline.filter(({ seg }) => seg.asset === plan.transcript!.asset && seg.sourceStartMs < cue.endMs && seg.sourceEndMs > cue.startMs);
      if (!overlapping.length) {
        // The whole cue lies in removed source: it is cut along with its audio.
        droppedCues++;
        return;
      }
      const startEntry = overlapping.find(({ seg }) => seg.sourceStartMs <= cue.startMs && seg.sourceEndMs >= cue.endMs);
      if (!startEntry) {
        problems.push(`${where}: crosses a cut. Split the cue in the transcript or move the segment boundary.`);
        return;
      }
      const timings = indexed.filter((word) => word.startMs >= cue.startMs && word.endMs <= cue.endMs);
      const lines = splitCaptionLines(style.textTransform === "uppercase" ? cue.text.toUpperCase() : cue.text, style.maxLines, style.singleLineMaxChars, style.balanceWeight);
      const displayCount = lines.reduce((sum, line) => sum + line.length, 0);
      if (timings.length !== displayCount) {
        problems.push(`${where}: has ${displayCount} displayed words but ${timings.length} timed words fall inside it`);
        return;
      }
      let offset = 0;
      const resolvedLines = lines.map((line) =>
        line.map((text) => {
          const timing = timings[offset++];
          const emphasisStyle = emphasisByWord.get(timing.wordIndex);
          return {
            text,
            startMs: sourceMsToOutputMs(startEntry, timing.startMs),
            endMs: sourceMsToOutputMs(startEntry, timing.endMs),
            wordIndex: timing.wordIndex,
            ...(emphasisStyle?.color ? { color: emphasisStyle.color } : {}),
            scale: emphasisStyle?.scale ?? 1,
          };
        }),
      );
      captionWords += displayCount;
      const startMs = sourceMsToOutputMs(startEntry, cue.startMs);
      cues.push({ from: Math.round((startMs * fps) / 1000), to: Math.round((sourceMsToOutputMs(startEntry, cue.endMs) * fps) / 1000), startMs, lines: resolvedLines });
    });
    emphasisByWord.forEach((_, wordIndex) => {
      if (!cues.some((cue) => cue.lines.some((line) => line.some((word) => word.wordIndex === wordIndex)))) {
        problems.push(`captions.emphasis: ${describeWord(wordIndex)} is not shown in any caption`);
      }
    });
    captions = { ...style, cues };
  }

  // --- Overlays.
  const overlays: ResolvedOverlay[] = [];
  plan.overlays.forEach((item, index) => {
    const where = `overlays[${index}] (${item.id})`;
    const definition = getEffect(item.effect as EffectId);
    const props = definition.props.parse(item.props);
    const from = resolveAnchor(item.from, `${where}.from`);
    const to = item.until ? resolveAnchor(item.until, `${where}.until`) : from === null ? null : from + item.durationFrames!;
    if (!inRange(from, to, where)) return;
    const length = to! - from!;
    const minimum = definition.minDurationInFrames?.(props) ?? 1;
    if (length < minimum) problems.push(`${where}: lasts ${length} frames but ${item.effect} needs at least ${minimum} for its entrance and exit`);
    overlays.push({ id: item.id, effect: item.effect as EffectId, from: from!, durationInFrames: length, layer: item.layer, props });
  });

  // --- Audio tracks.
  const tracks: ResolvedPlan["audio"]["tracks"] = [];
  plan.audio.tracks.forEach((track, index) => {
    const from = resolveAnchor(track.from, `audio.tracks[${index}].from`);
    if (from === null) return;
    if (from < 0 || from >= durationInFrames) problems.push(`audio.tracks[${index}]: starts at frame ${from}, outside the video`);
    else tracks.push({ src: assetFile(plan.assets[track.asset]), from, volume: track.volume });
  });

  if (problems.length) throw new PlanError(problems);
  return {
    engineVersion: 1,
    id: plan.id,
    width: plan.output.width,
    height: plan.output.height,
    fps,
    durationInFrames,
    theme: plan.theme,
    assets: plan.assets,
    footage: { ...plan.layout.footage, segments },
    captions,
    overlays,
    audio: { segmentAudio: plan.audio.segmentAudio, tracks },
    report: { droppedCues, captionWords },
  };
};

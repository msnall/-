// Automated QC of a rendered edit-plan.
//
//   node scripts/verify-render.mjs <edit-plan.json> <rendered.mp4>
//
// Checks the encoded specs against the plan, loudness/true peak against
// plan.qc, scans the footage area for blank or frozen frames, and writes review
// images (every caption cue, every overlay entrance) to <rendered>.qc/.
// Passing this is required but not sufficient: watch and listen before
// delivering.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkPlan } from "./edit-plan.mjs";
import { PlanError } from "../src/engine/load.ts";
import { loudness, probe, relative, root, run } from "./lib/media.mjs";

const [planArgument, videoArgument] = process.argv.slice(2);
if (!planArgument || !videoArgument) {
  console.error("Usage: node scripts/verify-render.mjs <edit-plan.json> <rendered.mp4>");
  process.exit(2);
}
let checked;
try {
  checked = await checkPlan(planArgument, { log: () => {} });
} catch (error) {
  console.error(error instanceof PlanError ? `FAILED ${planArgument}\n${error.message}` : error);
  process.exit(1);
}
const { plan, resolved } = checked;
const movie = path.resolve(root, videoArgument);
const outDir = movie.replace(/\.mp4$/i, ".qc");
await mkdir(outDir, { recursive: true });
const failures = [];

const info = await probe(movie, ["-count_frames"]);
const video = info.streams.find((stream) => stream.codec_type === "video");
const audio = info.streams.find((stream) => stream.codec_type === "audio");
const frameCount = Number(video?.nb_read_frames);
const duration = Number(info.format.duration);
const expectedSeconds = resolved.durationInFrames / resolved.fps;
if (!video) failures.push("no video stream");
else {
  if (video.width !== resolved.width || video.height !== resolved.height) failures.push(`size ${video.width}x${video.height}, plan ${resolved.width}x${resolved.height}`);
  if (video.r_frame_rate !== `${resolved.fps}/1`) failures.push(`frame rate ${video.r_frame_rate}, plan ${resolved.fps}/1`);
  if (frameCount !== resolved.durationInFrames) failures.push(`${frameCount} frames, plan ${resolved.durationInFrames}`);
}
// AAC priming/padding can lengthen the container by a few tens of milliseconds.
if (Math.abs(duration - expectedSeconds) > 1 / resolved.fps + 0.05) failures.push(`container duration ${duration}s, plan ${expectedSeconds.toFixed(3)}s`);
const expectsAudio = resolved.audio.tracks.length > 0 || resolved.audio.segmentAudio;
if (expectsAudio && !audio) failures.push("plan has audio but the render has no audio stream");

let finalAudio = null;
if (audio) {
  finalAudio = await loudness(movie);
  const { loudnessToleranceLu, maxTruePeakDb } = plan.qc;
  const loudnessLufs = plan.qc.loudnessLufs ?? (plan.audio.loudness.normalize ? plan.audio.loudness.targetLufs : undefined);
  if (loudnessLufs !== undefined && Math.abs(finalAudio.integratedLufs - loudnessLufs) > loudnessToleranceLu) {
    failures.push(`integrated loudness ${finalAudio.integratedLufs} LUFS, target ${loudnessLufs} ±${loudnessToleranceLu}`);
  }
  if (finalAudio.truePeakDb > maxTruePeakDb) failures.push(`true peak ${finalAudio.truePeakDb} dBTP above ${maxTruePeakDb}`);
}

// Caption timing as drawn: cues in order, not overlapping, inside the video,
// start/end frames agreeing with their millisecond times (±1 frame), and every
// highlighted word window inside its cue.
const captionTiming = { cues: 0, problems: [] };
if (resolved.captions) {
  const frameMs = 1000 / resolved.fps;
  let previousEnd = 0;
  resolved.captions.cues.forEach((cue, index) => {
    const words = cue.lines.flat();
    const endMs = Math.max(...words.map((word) => word.endMs));
    const where = `cue ${index} (frames ${cue.from}–${cue.to})`;
    if (cue.from < previousEnd) captionTiming.problems.push(`${where} starts before the previous cue ends (${previousEnd})`);
    if (cue.from >= cue.to || cue.to > resolved.durationInFrames) captionTiming.problems.push(`${where} is empty or past the end`);
    if (Math.abs(cue.from - cue.startMs / frameMs) > 1) captionTiming.problems.push(`${where} start frame disagrees with ${cue.startMs} ms`);
    for (const word of words) {
      if (word.startMs < cue.startMs - 1 || word.endMs > cue.to * frameMs + frameMs) captionTiming.problems.push(`${where} word "${word.text}" (${word.startMs}–${word.endMs} ms) is outside the cue`);
      if (word.endMs < word.startMs) captionTiming.problems.push(`${where} word "${word.text}" ends before it starts`);
    }
    if (endMs > cue.to * frameMs + frameMs) captionTiming.problems.push(`${where} last word ends after the cue`);
    previousEnd = cue.to;
    captionTiming.cues++;
  });
  failures.push(...captionTiming.problems);
}

// Blank/frozen scan over the middle of the footage box (away from text).
const { footage } = resolved;
const clampTo = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
const scan = {
  x: clampTo(footage.x + footage.width * 0.18, resolved.width - 2),
  y: clampTo(footage.y + footage.height * 0.25, resolved.height - 2),
};
scan.width = clampTo(footage.width * 0.64, resolved.width - scan.x) & ~1;
scan.height = clampTo(footage.height * 0.5, resolved.height - scan.y) & ~1;
const grayFile = path.join(outDir, "scan.gray");
await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", movie, "-an", "-vf", `crop=${scan.width}:${scan.height}:${scan.x}:${scan.y},scale=36:64,format=gray`,
  "-fps_mode", "passthrough", "-f", "rawvideo", grayFile]);
const pixels = await readFile(grayFile);
await rm(grayFile);
const stride = 36 * 64;
const flatFrames = [];
let identicalRun = 1;
let longestIdenticalRun = 1;
for (let frame = 0; frame < pixels.length / stride; frame++) {
  let sum = 0;
  let squared = 0;
  let delta = 0;
  for (let index = 0; index < stride; index++) {
    const value = pixels[frame * stride + index];
    sum += value;
    squared += value * value;
    if (frame > 0) delta += Math.abs(value - pixels[(frame - 1) * stride + index]);
  }
  const mean = sum / stride;
  const deviation = Math.sqrt(Math.max(0, squared / stride - mean * mean));
  if (deviation < 3) flatFrames.push({ frame, mean: Number(mean.toFixed(1)), deviation: Number(deviation.toFixed(2)) });
  if (frame > 0) {
    identicalRun = delta / stride < 0.005 ? identicalRun + 1 : 1;
    longestIdenticalRun = Math.max(longestIdenticalRun, identicalRun);
  }
}
if (pixels.length !== stride * resolved.durationInFrames) failures.push(`frame scan read ${pixels.length / stride} frames`);
if (flatFrames.length) failures.push(`${flatFrames.length} blank-looking footage frames, first at ${flatFrames[0].frame}`);
if (longestIdenticalRun > 10) failures.push(`footage frozen for ${longestIdenticalRun} frames`);

// Review sheets.
const sheet = async (frames, filter, name) => {
  if (!frames.length) return null;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", movie,
    "-vf", `select='${frames.map((frame) => `eq(n,${frame})`).join("+")}',${filter}`, "-frames:v", "1", path.join(outDir, name)]);
  return name;
};
const images = [];
if (resolved.captions?.cues.length) {
  const { box } = resolved.captions;
  const margin = 30;
  const crop = {
    x: clampTo(box.x - margin, resolved.width - 2),
    y: clampTo(box.y - margin, resolved.height - 2),
  };
  crop.width = clampTo(box.width + margin * 2, resolved.width - crop.x) & ~1;
  crop.height = clampTo(box.height + margin * 2, resolved.height - crop.y) & ~1;
  const frames = resolved.captions.cues.map((cue) => Math.floor((cue.from + cue.to - 1) / 2));
  images.push(await sheet(frames, `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=iw/2:-2,tile=3x${Math.ceil(frames.length / 3)}`, "caption-cues.jpg"));
}
const beats = [...new Set([0, ...resolved.overlays.filter((overlay) => overlay.durationInFrames < resolved.durationInFrames).map((overlay) => overlay.from + Math.min(15, Math.floor(overlay.durationInFrames / 2))), resolved.durationInFrames - 1])]
  .sort((a, b) => a - b)
  .slice(0, 10);
images.push(await sheet(beats, `scale=216:-2,tile=${beats.length}x1`, "overlay-beats.jpg"));

const report = {
  plan: relative(checked.planPath),
  video: relative(movie),
  automatedChecksPassed: failures.length === 0,
  failures,
  width: video?.width, height: video?.height, fps: video?.r_frame_rate, frames: frameCount, durationSeconds: duration,
  codec: video?.codec_name, pixFmt: video?.pix_fmt, audioCodec: audio?.codec_name ?? null,
  finalAudio,
  captionCues: resolved.captions?.cues.length ?? 0,
  captionTiming,
  loudnessTarget: plan.qc.loudnessLufs ?? (plan.audio.loudness.normalize ? plan.audio.loudness.targetLufs : null),
  frameScan: { region: scan, flatFrames, longestIdenticalRun, method: "36x64 grayscale scan of the central footage area; not an exhaustive glitch detector" },
  reviewImages: images.filter(Boolean),
  beatsFrames: beats,
  // Overlays/captions over a detected face or a TikTok UI zone. Warnings only:
  // they do not fail QC, the editor decides.
  layoutWarnings: checked.warnings,
};
await writeFile(path.join(outDir, "validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
for (const warning of checked.warnings) console.log(`WARN ${warning.kind}: ${warning.message}`);
console.log(`${failures.length ? "FAILED" : "PASSED"}: ${relative(path.join(outDir, "validation.json"))}${checked.warnings.length ? ` (${checked.warnings.length} layout warning(s))` : ""}`);
process.exit(failures.length ? 1 : 0);

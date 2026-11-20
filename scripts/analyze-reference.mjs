// Local analysis of a finished reference video, the first half of 「剪辑技巧」学习 (no model involved).
//
//   node scripts/analyze-reference.mjs <refId> <videoFile> [--title=<name>] [--threshold=0.15]
//
// Writes library/references/<refId>/analysis.json (+ frames/): facts, cut times and shot lengths from scene
// detection, the spoken words with times (local whisper), loudness, and one frame per second (the model
// reads captions, cutaways and framing from these). The video itself is only read, never copied or edited.
// A reference is for analysis only: its pictures never go into a finished video.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loudness, probe, publicDir, root, run, sha256File } from "./lib/media.mjs";
import { writeJson } from "./lib/storage.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const [refId, videoFile] = args.filter((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
if (!refId || !videoFile || !/^[a-z0-9][a-z0-9-]*$/.test(refId)) { console.error("Usage: node scripts/analyze-reference.mjs <refId (lowercase/digits/hyphens)> <videoFile> [--title=…] [--threshold=0.15]"); process.exit(1); }
const input = path.resolve(videoFile);
const dir = path.join(root, "library", "references", refId);
const framesDir = path.join(dir, "frames");
await mkdir(framesDir, { recursive: true });
const threshold = Number(opt("threshold", "0.15"));

const info = await probe(input);
const v = info.streams.find((s) => s.codec_type === "video");
const hasAudio = info.streams.some((s) => s.codec_type === "audio");
const durationMs = Math.round(Number(info.format.duration) * 1000);

// 1. cuts (scene detection) ----------------------------------------------------------------------------
const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]).catch((e) => e);
// Fades and flashes fire several detections in a row: keep the first of any group closer than 400 ms.
const cuts = [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000)).filter((t) => t > 300 && t < durationMs - 300).reduce((all, t) => (all.length && t - all.at(-1) < 400 ? all : [...all, t]), []);
const bounds = [0, ...cuts, durationMs];
const shots = bounds.slice(0, -1).map((start, i) => ({ index: i + 1, startMs: start, endMs: bounds[i + 1], durationMs: bounds[i + 1] - start }));

// 2. one frame per second, small (readable captions need ≥ 270 px wide) ------------------------------------
const frames = [];
for (let t = 0; t * 1000 < durationMs; t++) {
  const file = path.join(framesDir, `t${String(t).padStart(3, "0")}.jpg`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t + 0.3), "-i", input, "-frames:v", "1", "-vf", "scale=270:-2", "-q:v", "4", file]);
  frames.push({ t, file: path.relative(dir, file).split(path.sep).join("/") });
}

// 3. spoken words (local whisper through scripts/transcribe.mjs on the extracted audio) -----------------------------
let words = [];
let loud = null;
if (hasAudio) {
  const scratch = path.join(root, "out", "scratch");
  await mkdir(scratch, { recursive: true });
  const wav = path.join(scratch, `ref-${refId}.wav`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", wav]);
  try {
    await exec(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/transcribe.mjs", wav, "--language", "en", "--model", "bin/whisper.cpp/models/ggml-small.en.bin", "--force"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 900000 });
    const base = path.join(publicDir, "transcripts", `ref-${refId}`);
    words = JSON.parse(await readFile(`${base}.json`, "utf8"));
    for (const ext of ["json", "cues.json", "txt", "srt", "review.json", "meta.json"]) await rm(`${base}.${ext}`, { force: true });
  } catch (error) { console.error(`transcription skipped: ${String(error.stderr ?? error.message).slice(0, 200)}`); }
  loud = await loudness(input).catch(() => null);
  await rm(wav, { force: true });
}

const durations = shots.map((s) => s.durationMs);
const analysis = {
  version: 1, id: refId, title: opt("title", path.parse(input).name), analyzedAt: new Date().toISOString(),
  source: { file: input, sha256: await sha256File(input), bytes: (await stat(input)).size },
  facts: { width: v.width, height: v.height, fps: v.r_frame_rate, durationMs, hasAudio, loudness: loud },
  cuts: { threshold, count: cuts.length, timesMs: cuts },
  shots,
  pacing: { shotCount: shots.length, avgShotMs: Math.round(durations.reduce((s, d) => s + d, 0) / shots.length), minShotMs: Math.min(...durations), maxShotMs: Math.max(...durations), cutsPerSecond: Number(((cuts.length / durationMs) * 1000).toFixed(2)) },
  transcript: { words, text: words.map((w) => w.text).join(" "), wordsPerSecond: words.length ? Number(((words.length / durationMs) * 1000).toFixed(2)) : 0 },
  frames,
};
await writeJson(path.join(dir, "analysis.json"), analysis);
console.log(`${refId}: ${(durationMs / 1000).toFixed(1)} s, ${shots.length} shots (avg ${analysis.pacing.avgShotMs} ms), ${words.length} words, ${frames.length} frames -> library/references/${refId}/analysis.json`);
console.log(`cuts at: ${cuts.map((c) => (c / 1000).toFixed(1)).join(", ") || "none"}`);
if (words.length) console.log(`said: ${analysis.transcript.text}`);

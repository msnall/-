import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const publicDir = path.join(root, "public");

export async function run(binary, args, options = {}) {
  return exec(binary, args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 900000, ...options });
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function probe(file, extra = []) {
  const { stdout } = await run("ffprobe", ["-v", "error", ...extra, "-show_format", "-show_streams", "-of", "json", file]);
  return JSON.parse(stdout);
}

// Integrated loudness / true peak via loudnorm's measurement pass.
export async function loudness(file) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"]);
  const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!blocks) throw new Error(`No loudness measurement for ${file}`);
  const result = JSON.parse(blocks[blocks.length - 1]);
  return { integratedLufs: Number(result.input_i), truePeakDb: Number(result.input_tp), lra: Number(result.input_lra) };
}

// Two-pass EBU R128 normalization of a rendered MP4. The video stream is
// copied bit-for-bit; only the audio is re-encoded (AAC-LC 48 kHz, matching
// Remotion's own output), then padded/trimmed to durationSeconds because
// loudnorm's resampling chain can append ~0.1 s at the end. Returns the
// measurements of both passes.
export async function normalizeLoudness(input, output, { targetLufs, truePeakDb, lra }, durationSeconds) {
  const target = `I=${targetLufs}:TP=${truePeakDb}:LRA=${lra}`;
  const measure = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-vn", "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
  const parse = (stderr) => {
    const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
    if (!blocks) throw new Error(`No loudnorm measurement for ${input}`);
    return JSON.parse(blocks[blocks.length - 1]);
  };
  const first = parse(measure.stderr);
  if (!Number.isFinite(Number(first.input_i))) throw new Error(`Cannot normalize ${input}: the audio is silent (integrated loudness ${first.input_i})`);
  const second = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
    "-af", `loudnorm=${target}:measured_I=${first.input_i}:measured_TP=${first.input_tp}:measured_LRA=${first.input_lra}:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=true:print_format=json,aresample=48000,apad,atrim=duration=${durationSeconds}`,
    "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output,
  ]);
  return { target: { targetLufs, truePeakDb, lra }, firstPass: first, secondPass: parse(second.stderr) };
}

export const relative = (file) => path.relative(root, file).split(path.sep).join("/");

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "out/bloom10-first-cut");
const movie = path.join(output, "Bloom10-first-cut-r1.mp4");
async function command(binary, args) {
  return run(binary, args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 600000 });
}
const probe = JSON.parse((await command("ffprobe", ["-v", "error", "-count_frames", "-show_format", "-show_streams", "-of", "json", movie])).stdout);
const video = probe.streams.find((stream) => stream.codec_type === "video");
const audio = probe.streams.find((stream) => stream.codec_type === "audio");
if (!video || !audio || video.width !== 1080 || video.height !== 1920 || video.r_frame_rate !== "30/1" ||
    Number(video.nb_read_frames) !== 909 || Math.abs(Number(probe.format.duration) - 30.3) > 0.04) throw new Error("Unexpected final media specifications");
const levels = await command("ffmpeg", ["-hide_banner", "-i", movie, "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "NUL"]);
await writeFile(path.join(output, "final-audio-verification.log"), levels.stderr);
const measurements = JSON.parse(levels.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1) ?? "null");
if (!measurements || Math.abs(Number(measurements.input_i) + 16) > 1.5 || Number(measurements.input_tp) > -1) throw new Error("Final encoded audio missed its loudness or peak target");

const cues = JSON.parse(await readFile(path.join(root, "public/transcripts/Bloom10-达人素材.edited.cues.json"), "utf8"));
const selected = cues.map((cue) => Math.floor((cue.startFrame + cue.endFrame - 1) / 2));
await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", movie,
  "-vf", `select='${selected.map((frame) => `eq(n,${frame})`).join("+")}',crop=840:170:70:1530,scale=420:85,tile=3x6`,
  "-frames:v", "1", path.join(output, "all-caption-cues.jpg")]);
await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", movie,
  "-vf", "select='eq(n,0)+eq(n,275)+eq(n,420)+eq(n,550)+eq(n,680)+eq(n,875)',scale=216:-1,tile=6x1",
  "-frames:v", "1", path.join(output, "six-beat-contact.jpg")]);
const smallFrames = path.join(output, "source-region.gray");
await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", movie, "-an", "-vf", "crop=650:900:150:400,scale=36:64,format=gray",
  "-fps_mode", "passthrough", "-f", "rawvideo", smallFrames]);
const pixels = await readFile(smallFrames);
const stride = 36 * 64;
if (pixels.length !== stride * 909) throw new Error("Frame scan count mismatch");
const flatFrames = [];
let identicalRun = 1;
let longestIdenticalRun = 1;
for (let frame = 0; frame < 909; frame++) {
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
  const deviation = Math.sqrt(squared / stride - mean * mean);
  if (deviation < 3) flatFrames.push({ frame, mean, deviation });
  if (frame > 0) {
    identicalRun = delta / stride < 0.005 ? identicalRun + 1 : 1;
    longestIdenticalRun = Math.max(longestIdenticalRun, identicalRun);
  }
}
if (flatFrames.length || longestIdenticalRun > 10) throw new Error(`Potential blank/frozen footage: ${JSON.stringify({ flatFrames, longestIdenticalRun })}`);
const source = path.join(root, "public/recordings/Bloom10/Bloom10-达人素材.mp4");
const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex");
if (sourceSha256 !== "31bf76ef1375c072f53117d2379660d40973ed323d61037d34afc3786a8274c3") throw new Error("Source changed");
const report = {
  sourceSha256, automatedChecksPassed: true, width: video.width, height: video.height, fps: video.r_frame_rate,
  frames: Number(video.nb_read_frames), durationSeconds: Number(probe.format.duration),
  codec: video.codec_name, audioCodec: audio.codec_name, finalAudio: measurements,
  captionCues: cues.length, frameScan: { scanned: 909, flatFrames, longestIdenticalRun, method: "36x64 grayscale scan of central footage, excluding title and captions; not an exhaustive visual-glitch detector" },
  reviewImages: ["all-caption-cues.jpg", "six-beat-contact.jpg"],
  limitations: ["Word timing remains ASR estimated; listening review is still required", "Quantity card withheld pending label verification", "User acceptance of pacing, music and final visual style is pending"],
};
await writeFile(path.join(output, "validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

// Compare a candidate render against a reference render.
//
//   node scripts/compare-renders.mjs <reference.mp4> <candidate.mp4> [--out=<dir>]
//
// Reports stream specs, per-frame SSIM/PSNR over every frame, whether the
// encoded video and the decoded audio are bit-identical, loudness, and writes
// side-by-side/difference images for the least similar frames. Read-only for
// both inputs; results go to <candidate>.compare/ by default.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loudness, probe, relative, root, run } from "./lib/media.mjs";

const args = process.argv.slice(2);
const [referenceArgument, candidateArgument] = args.filter((arg) => !arg.startsWith("--"));
if (!referenceArgument || !candidateArgument) {
  console.error("Usage: node scripts/compare-renders.mjs <reference.mp4> <candidate.mp4> [--out=<dir>]");
  process.exit(2);
}
const reference = path.resolve(root, referenceArgument);
const candidate = path.resolve(root, candidateArgument);
const outArgument = args.find((arg) => arg.startsWith("--out="))?.slice(6);
const outDir = outArgument ? path.resolve(root, outArgument) : candidate.replace(/\.mp4$/i, ".compare");
await mkdir(outDir, { recursive: true });

const summarize = async (file) => {
  const info = await probe(file, ["-count_frames"]);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.find((stream) => stream.codec_type === "audio");
  return {
    file: relative(file),
    durationSeconds: Number(info.format.duration),
    video: video && { codec: video.codec_name, profile: video.profile, pixFmt: video.pix_fmt, width: video.width, height: video.height, fps: video.r_frame_rate, frames: Number(video.nb_read_frames) },
    audio: audio && { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, durationSeconds: Number(audio.duration) },
  };
};
const md5 = async (file, map, codecArgs) => {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", map, ...codecArgs, "-f", "md5", "-"]);
  return stdout.trim().replace(/^MD5=/, "");
};

console.log("Probing streams...");
const [ref, cand] = await Promise.all([summarize(reference), summarize(candidate)]);

console.log("Computing per-frame SSIM and PSNR...");
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-i", reference, "-i", candidate,
  "-lavfi", "[0:v]split[a1][a2];[1:v]split[b1][b2];[a1][b1]ssim=stats_file=ssim.log;[a2][b2]psnr=stats_file=psnr.log",
  "-f", "null", "-",
], { cwd: outDir });
const ssim = (await readFile(path.join(outDir, "ssim.log"), "utf8")).trim().split(/\r?\n/).map((line) => {
  const fields = Object.fromEntries(line.split(" ").map((part) => part.split(":")));
  return { frame: Number(fields.n) - 1, all: Number(fields.All), y: Number(fields.Y) };
});
const psnr = (await readFile(path.join(outDir, "psnr.log"), "utf8")).trim().split(/\r?\n/).map((line) => {
  const fields = Object.fromEntries(line.split(" ").map((part) => part.split(":")));
  return { frame: Number(fields.n) - 1, psnr: fields.psnr_avg === "inf" ? Infinity : Number(fields.psnr_avg), mse: Number(fields.mse_avg) };
});
const identicalFrames = psnr.filter((item) => item.mse === 0).length;
const worst = [...ssim].sort((a, b) => a.all - b.all).slice(0, 5);
const finitePsnr = psnr.filter((item) => Number.isFinite(item.psnr)).map((item) => item.psnr);

console.log("Hashing encoded video and decoded audio...");
const [refVideoMd5, candVideoMd5, refAudioMd5, candAudioMd5] = await Promise.all([
  md5(reference, "0:v:0", ["-c", "copy"]),
  md5(candidate, "0:v:0", ["-c", "copy"]),
  ref.audio ? md5(reference, "0:a:0", ["-c:a", "pcm_s16le"]) : null,
  cand.audio ? md5(candidate, "0:a:0", ["-c:a", "pcm_s16le"]) : null,
]);
const [refLoudness, candLoudness] = await Promise.all([ref.audio ? loudness(reference) : null, cand.audio ? loudness(candidate) : null]);

const images = [];
for (const item of worst.filter((entry) => entry.all < 1).slice(0, 3)) {
  const name = `frame-${String(item.frame).padStart(4, "0")}-ref-cand-diff.jpg`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", reference, "-i", candidate,
    "-filter_complex",
    `[0:v]select='eq(n,${item.frame})',setpts=PTS-STARTPTS,split[a1][a2];[1:v]select='eq(n,${item.frame})',setpts=PTS-STARTPTS,split[b1][b2];` +
      "[a2][b2]blend=all_mode=difference,eq=contrast=8[d];[a1][b1][d]hstack=inputs=3,scale=1620:-2[out]",
    "-map", "[out]", "-frames:v", "1", path.join(outDir, name),
  ]);
  images.push(name);
}

const sameSpec = JSON.stringify({ ...ref.video, frames: ref.video?.frames }) === JSON.stringify({ ...cand.video, frames: cand.video?.frames }) &&
  JSON.stringify(ref.audio && { ...ref.audio, durationSeconds: undefined }) === JSON.stringify(cand.audio && { ...cand.audio, durationSeconds: undefined });
const report = {
  reference: ref,
  candidate: cand,
  sameStreamSpecs: sameSpec,
  video: {
    framesCompared: ssim.length,
    encodedStreamIdentical: refVideoMd5 === candVideoMd5,
    pixelIdenticalFrames: identicalFrames,
    ssimMin: Math.min(...ssim.map((item) => item.all)),
    ssimMean: ssim.reduce((sum, item) => sum + item.all, 0) / ssim.length,
    psnrMinDb: finitePsnr.length ? Math.min(...finitePsnr) : Infinity,
    leastSimilarFrames: worst,
    images,
  },
  audio: {
    decodedPcmIdentical: refAudioMd5 !== null && refAudioMd5 === candAudioMd5,
    referenceLoudness: refLoudness,
    candidateLoudness: candLoudness,
  },
};
const json = JSON.stringify(report, (key, value) => (value === Infinity ? "inf" : value), 2);
await writeFile(path.join(outDir, "compare.json"), json + "\n");
console.log(json);
console.log(`Wrote ${relative(path.join(outDir, "compare.json"))}`);

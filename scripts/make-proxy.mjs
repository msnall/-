// 540p H.264 preview proxies for every video or image sequence a project's
// segments use.
//
//   node scripts/make-proxy.mjs bloom10-demo [--force]
//
// The review desk only ever loads proxies; originals are read (never written)
// and only the final render uses them. Proxies go to
// public/projects/<id>/proxy/<assetId>.mp4 and are recorded, with the source
// size/mtime they were made from, in projects/<id>/analysis/proxies.json.
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { imageSequenceFile } from "../src/engine/load.ts";
import { probe, publicDir, relative, run } from "./lib/media.mjs";
import { projectFile, projectIdFrom, readJson, writeJson } from "./lib/storage.mjs";
import { footageAssets } from "./lib/storyboard-files.mjs";

const SHORT_SIDE = 540;
const validProxy = async (file, expectedDurationMs = null, requireAudio = false) => {
  try {
    if ((await stat(file)).size === 0) return null;
    const info = await probe(file);
    const video = info.streams.find((stream) => stream.codec_type === "video");
    const durationMs = Number(info.format.duration) * 1000;
    if (video?.codec_name !== "h264" || !video.width || !video.height || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    if (requireAudio && !info.streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac")) return null;
    if (expectedDurationMs && Math.abs(durationMs - expectedDurationMs) > Math.max(1500, expectedDurationMs * 0.05)) return null;
    return { info, video, durationMs };
  } catch { return null; }
};

export async function makeProxies(projectId, { force = false, log = console.log } = {}) {
  const footage = await footageAssets(projectId);
  const recordFile = projectFile(projectId, "analysis/proxies.json");
  const record = await readJson(recordFile, { version: 1, assets: {} });
  const { stdout: ffmpegVersion } = await run("ffmpeg", ["-hide_banner", "-version"]);
  const outDir = path.join(publicDir, "projects", projectId, "proxy");
  await mkdir(outDir, { recursive: true });

  // Image sequences get a proxy too, so the browser streams one small video
  // instead of hundreds of full-size JPEGs.
  for (const [id, asset] of Object.entries(footage)) {
    const isSequence = asset.type === "imageSequence";
    const source = path.join(publicDir, isSequence ? imageSequenceFile(asset.dir, asset.pattern, 0) : asset.path);
    const input = isSequence ? ["-framerate", String(asset.fps), "-start_number", "0", "-i", path.join(publicDir, asset.dir, asset.pattern)] : ["-i", source];
    const info = await stat(source);
    const sourceMedia = isSequence ? null : await probe(source);
    const sourceHasAudio = sourceMedia?.streams.some((stream) => stream.codec_type === "audio") ?? false;
    const output = path.join(outDir, `${id}.mp4`);
    const previous = record.assets[id];
    if (!force && previous?.sourceSize === info.size && previous?.sourceMtimeMs === info.mtimeMs && await validProxy(output, previous.durationMs, sourceHasAudio)) {
      log(`proxy ${id}: up to date (${relative(output)})`);
      continue;
    }
    const temporary = `${output}.tmp.mp4`;
    const encode = (decode) => [
      "-hide_banner", "-nostats", "-y", ...decode, ...input,
      "-vf", `scale='if(gt(iw,ih),-2,${SHORT_SIDE})':'if(gt(iw,ih),${SHORT_SIDE},-2)',format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15",
      ...(isSequence ? ["-an"] : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]), "-movflags", "+faststart", temporary,
    ];
    log(`proxy ${id}: encoding ${isSequence ? `${relative(path.join(publicDir, asset.dir))}/${asset.pattern}` : relative(source)} -> ${relative(output)}`);
    let decoder = "cuda";
    try {
      if (isSequence) throw new Error("JPEG sequences decode on the CPU");
      await run("ffmpeg", encode(["-hwaccel", "cuda"]));
    } catch {
      decoder = "cpu";
      await run("ffmpeg", encode([]));
    }
    const verified = await validProxy(temporary, sourceMedia ? Number(sourceMedia.format.duration) * 1000 : null, sourceHasAudio);
    if (!verified) throw new Error(`proxy ${id}: FFmpeg 输出无效或时长与原片不符，请检查源文件并重试`);
    await rm(output, { force: true });
    await rename(temporary, output);
    const { info: probed, video } = verified;
    record.assets[id] = {
      file: path.relative(publicDir, output).split(path.sep).join("/"),
      source: isSequence ? `${asset.dir}/${asset.pattern}` : asset.path,
      ...(isSequence ? { fps: asset.fps, frameCount: asset.frameCount } : {}),
      sourceSize: info.size,
      sourceMtimeMs: info.mtimeMs,
      width: video.width,
      height: video.height,
      durationMs: Number(probed.format.duration) * 1000,
      decoder,
      ffmpeg: ffmpegVersion.split("\n")[0].trim(),
      createdAt: new Date().toISOString(),
    };
    log(`proxy ${id}: ${video.width}x${video.height}, ${(Number(probed.format.duration)).toFixed(2)} s (decode: ${decoder})`);
  }
  await writeJson(recordFile, record);
  return record;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [argument, ...flags] = process.argv.slice(2);
  if (!argument) {
    console.error("Usage: node scripts/make-proxy.mjs <project-id> [--force]");
    process.exit(2);
  }
  try {
    await makeProxies(projectIdFrom(argument), { force: flags.includes("--force") });
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}

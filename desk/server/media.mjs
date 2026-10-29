// Media for the page, addressed by asset id: /media/<project>/<asset>[/<frame file>].
// Segment videos are served only as their 540p proxy; originals never reach
// the browser. Also: segment thumbnails and a per-frame audio peak track.
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { publicDir, root, run } from "../../scripts/lib/media.mjs";
import { NotFound, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { imageSequenceFile, parseEditPlan } from "../../src/engine/load.ts";
import { HttpError } from "./errors.mjs";

const types = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".otf": "font/otf", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".wasm": "application/wasm",
};

export async function sendFile(request, response, file, { cache = "no-cache" } = {}) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "Not found");
  const headers = { "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": cache };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    let start = range[1] === "" ? info.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) {
      response.writeHead(416, { "content-range": `bytes */${info.size}` });
      return response.end();
    }
    response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
    if (request.method === "HEAD") return response.end();
    return createReadStream(file, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...headers, "content-length": info.size });
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
}

const loadPlan = async (project) => parseEditPlan(await readJson(projectFile(project, "edit-plan.json")));
const proxyFor = async (project, assetId) => (await readJson(projectFile(project, "analysis/proxies.json"), { assets: {} })).assets[assetId]?.file ?? null;

// File on disk for /media/<project>/<asset>[/<frame>].
export async function mediaFile(project, assetId, frame) {
  const plan = await loadPlan(project);
  const asset = plan.assets[assetId];
  if (!asset) throw new HttpError(404, `Project ${project} has no asset "${assetId}"`);
  if (asset.type === "imageSequence" && !frame) {
    const proxy = await proxyFor(project, assetId);
    if (!proxy) throw new HttpError(404, `No preview proxy for ${assetId} yet. Run the "proxy" job.`);
    return path.join(publicDir, proxy);
  }
  if (asset.type === "imageSequence") {
    const pattern = new RegExp(`^${asset.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%0(\d+)d/, (_, width) => `\\d{${width}}`)}$`);
    if (!frame || !pattern.test(frame)) throw new HttpError(404, `"${frame}" is not a frame of ${assetId}`);
    return path.join(publicDir, asset.dir, frame);
  }
  if (frame) throw new HttpError(404, "Not found");
  const isSegmentVideo = asset.type === "video" && plan.segments.some((segment) => segment.asset === assetId);
  if (isSegmentVideo) {
    const proxy = await proxyFor(project, assetId);
    if (!proxy) throw new HttpError(404, `No preview proxy for ${assetId} yet. Run the "proxy" job.`);
    return path.join(publicDir, proxy);
  }
  return path.join(publicDir, asset.path);
}

// Fonts and transcript JSON the composition fetches by public path.
const PUBLIC_EXTENSIONS = new Set([".json", ".woff2", ".woff", ".ttf", ".otf"]);
export function publicFile(urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep) || relative.startsWith("recordings/") || !PUBLIC_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  return file;
}

const cacheDir = (project, kind) => path.join(root, "out/desk-cache", project, kind);

// One small JPEG from the middle of a segment.
export async function segmentThumb(project, segmentId) {
  const plan = await loadPlan(project);
  const segment = plan.segments.find((item) => item.id === segmentId);
  if (!segment) throw new NotFound(`No segment "${segmentId}"`);
  const asset = plan.assets[segment.asset];
  const ms = Math.round((segment.sourceStartMs + segment.sourceEndMs) / 2);
  const output = path.join(cacheDir(project, "thumbs"), `${segment.asset}-${ms}.jpg`);
  if ((await stat(output).catch(() => null)) !== null) return output;
  await mkdir(path.dirname(output), { recursive: true });
  if (asset.type === "imageSequence") {
    const input = path.join(publicDir, imageSequenceFile(asset.dir, asset.pattern, Math.min(asset.frameCount - 1, Math.round((ms * asset.fps) / 1000))));
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", "scale=160:-2", "-q:v", "4", output]);
  } else {
    const input = path.join(publicDir, (await proxyFor(project, segment.asset)) ?? asset.path);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(ms / 1000), "-i", input, "-frames:v", "1", "-vf", "scale=160:-2", "-q:v", "4", output]);
  }
  return output;
}

// Peak level per output frame (0–1), following the cuts: segment audio from
// each kept range plus every audio track at its offset. Cached per revision.
const SAMPLE_RATE = 6000;
const decode = async (input, startMs, durationMs) => {
  const temporary = path.join(root, "out/desk-cache", `pcm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.f32`);
  await mkdir(path.dirname(temporary), { recursive: true });
  try {
    const seek = startMs !== null ? ["-ss", String(startMs / 1000), "-t", String(durationMs / 1000)] : [];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...seek, "-i", input, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", temporary]);
    const buffer = await readFile(temporary);
    return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  } finally {
    await rm(temporary, { force: true });
  }
};

export async function waveform(project, resolved) {
  const output = path.join(cacheDir(project, "waveform"), `${hash(JSON.stringify([resolved.fps, resolved.footage.segments, resolved.audio]))}.json`);
  const existing = await readJson(output, null);
  if (existing) return existing;
  const plan = await loadPlan(project);
  const perFrame = SAMPLE_RATE / resolved.fps;
  const peaks = new Array(resolved.durationInFrames).fill(0);
  const place = (samples, fromFrame, volume) => {
    for (let frame = 0; frame * perFrame < samples.length; frame++) {
      const target = fromFrame + frame;
      if (target >= peaks.length) break;
      let peak = 0;
      const end = Math.min(samples.length, (frame + 1) * perFrame);
      for (let index = frame * perFrame; index < end; index++) peak = Math.max(peak, Math.abs(samples[index]));
      peaks[target] = Math.max(peaks[target], Math.min(1, peak * volume));
    }
  };
  if (resolved.audio.segmentAudio) {
    for (const segment of resolved.footage.segments) {
      const assetId = plan.segments.find((item) => item.id === segment.id).asset;
      const input = path.join(publicDir, (await proxyFor(project, assetId)) ?? plan.assets[assetId].path);
      place(await decode(input, segment.sourceStartMs, segment.sourceEndMs - segment.sourceStartMs), segment.from, 1);
    }
  }
  for (const track of resolved.audio.tracks) place(await decode(path.join(publicDir, track.src), null, null), track.from, track.volume);
  const result = { fps: resolved.fps, peaks: peaks.map((value) => Number(value.toFixed(3))) };
  await writeJson(output, result);
  return result;
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  return value.toString(16);
}

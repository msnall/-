import { stat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { probe, run, sha256File } from "../../scripts/lib/media.mjs";

const cache = new Map();
export const KEY_VERSION = 1;
export async function detectPresenterKey(file) {
  const info = await stat(file);
  const key = `${file}:${info.size}:${info.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const task = (async () => {
    const media = await probe(file);
    const stream = media.streams.find((item) => item.codec_type === "video");
    if (!stream) throw new Error("达人文件没有视频画面");
    if (/yuva|rgba|argb|bgra|gbrap/.test(stream.pix_fmt ?? "") || stream.tags?.alpha_mode === "1") return { mode: "alpha", color: null };
    const duration = Number(media.format.duration);
    let border = 0, green = 0, black = 0;
    const channels = [[], [], []];
    for (const time of [Math.min(.8, duration / 4), duration / 2, Math.max(0, duration - .8)]) {
      const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=96:96", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
        if (x >= 16 && x < 80 && y >= 16 && y < 80) continue;
        const i = (y * 96 + x) * 3;
        const r = stdout[i], g = stdout[i + 1], b = stdout[i + 2];
        border++;
        if (g > 65 && g > r * 1.45 && g > b * 1.45) { green++; channels[0].push(r); channels[1].push(g); channels[2].push(b); }
        if (r < 24 && g < 24 && b < 24) black++;
      }
    }
    if (green / border > .32) {
      const color = "0x" + channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toString(16).padStart(2, "0")).join("");
      return { mode: "green", color };
    }
    return { mode: black / border > .45 ? "black" : "none", color: null };
  })();
  cache.set(key, task);
  try { return await task; } catch (error) { cache.delete(key); throw error; }
}

export const presenterFilter = (key, width) => `fps=30,scale=${width}:-2,` + (key.mode === "green"
  ? `format=yuva420p,chromakey=${key.color}:0.16:0.07,format=rgba,despill=type=green:mix=0.35`
  : key.mode === "black" ? "format=rgba,colorkey=0x000000:0.025:0.08" : "format=rgba");

export async function makePresenterLayer(file, folder, durationMs) {
  const key = await detectPresenterKey(file);
  const hash = createHash("sha256").update(JSON.stringify([KEY_VERSION, await sha256File(file), durationMs, key])).digest("hex").slice(0, 16);
  const output = path.join(folder, `presenter-${hash}.webm`);
  await mkdir(folder, { recursive: true });
  if (!(await stat(output).catch(() => null))?.size) {
    const temporary = path.join(folder, `${randomUUID()}.partial.webm`);
    try {
      await run("ffmpeg", ["-v", "error", "-stream_loop", "-1", "-i", file, "-t", String(durationMs / 1000 + .1), "-vf", presenterFilter(key, 400), "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "4", "-b:v", "0", "-crf", "30", "-y", temporary]);
      await rename(temporary, output);
    } finally { await rm(temporary, { force: true }); }
  }
  return { file: output, key, hash };
}

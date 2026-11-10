// A separate, source-preserving workspace for fixed-voiceover B-roll variants.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probe, root, run, sha256File } from "../../scripts/lib/media.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import { writeJson } from "../../scripts/lib/storage.mjs";
import { detectPresenterKey, presenterFilter, makePresenterLayer, KEY_VERSION } from "./presenter-key.mjs";

const mixContext = new AsyncLocalStorage();
const legacyWork = path.join(root, "out", "mix-workspace");
const legacy = { sourceDir: path.join(root, "sucai"), workDir: legacyWork, variantDir: path.join(legacyWork, "variants"), clipDir: path.join(legacyWork, "clips"), previewDir: path.join(legacyWork, "previews"), thumbDir: path.join(legacyWork, "thumbs") };
const locations = () => mixContext.getStore() ?? legacy;
export const withMixContext = (config, action) => mixContext.run(config, action);
const transcriptFor = async (voice) => {
  const prefix = path.join(root, "public", "transcripts", path.parse(voice).name);
  try {
    const meta = JSON.parse(await readFile(`${prefix}.meta.json`, "utf8"));
    if (meta.sourceSha256 !== await sha256File(voice)) return null;
    const srt = await readFile(`${prefix}.srt`, "utf8");
    return { srt, hash: digest(srt) };
  } catch { return null; }
};
const slots = [
  { id: "hook", label: "开头画面", group: "wrong", share: 0.12 },
  { id: "problem", label: "错误示范", group: "wrong", share: 0.13 },
  { id: "solution", label: "解决方式", group: "detail", share: 0.12 },
  { id: "demo-a", label: "操作展示 1", group: "detail", share: 0.13 },
  { id: "demo-b", label: "操作展示 2", group: "detail", share: 0.13 },
  { id: "detail-a", label: "细节展示 1", group: "detail", share: 0.13 },
  { id: "detail-b", label: "细节展示 2", group: "detail", share: 0.12 },
  { id: "ending", label: "收尾画面", group: "detail", share: 0.12 },
];
const jobs = new Map();
const jobFiles = new Map();
const jobWrites = new Map();
const persistJob = (job) => {
  const file = jobFiles.get(job.id);
  if (!file) return Promise.resolve();
  const snapshot = structuredClone(job);
  const next = (jobWrites.get(job.id) ?? Promise.resolve()).catch(() => {}).then(() => writeJson(file, snapshot));
  jobWrites.set(job.id, next);
  return next;
};
const variantLocks = new Map();
const editVariant = (id, action) => {
  const key = path.join(locations().variantDir, id);
  const next = (variantLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  variantLocks.set(key, next);
  next.finally(() => { if (variantLocks.get(key) === next) variantLocks.delete(key); }).catch(() => {});
  return next;
};
let queue = Promise.resolve();

const files = async (dir) => (await readdir(dir, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && /\.(mp4|mov|webm|mp3|wav)$/i.test(entry.name))
  .sort((a, b) => Number(/\(\d+\)/.test(a.name)) - Number(/\(\d+\)/.test(b.name)) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
  .map((entry) => path.join(dir, entry.name));
const mediaInfo = async (file) => {
  const info = await probe(file);
  return { durationMs: Math.round(Number(info.format.duration) * 1000), width: info.streams.find((stream) => stream.codec_type === "video")?.width ?? null, height: info.streams.find((stream) => stream.codec_type === "video")?.height ?? null };
};
export const actorDirectory = async (source = locations().sourceDir) => locations().actorFolder ?? ((await files(path.join(source, "达人"))).length ? "达人" : "抠像后达人");

export async function mixLibrary() {
  const [voice] = locations().voiceName ? [path.join(locations().sourceDir, "口播", locations().voiceName)] : await files(path.join(locations().sourceDir, "口播"));
  const [actor] = locations().actorName ? [path.join(locations().sourceDir, await actorDirectory(), locations().actorName)] : await files(path.join(locations().sourceDir, await actorDirectory()));
  if (!voice) throw new HttpError(404, "sucai/口播 中没有音频文件");
  if (!actor) throw new HttpError(404, "达人文件夹中没有视频文件");
  const assets = await Promise.all((await assetFiles()).map(async (asset) => ({ ...asset, name: path.basename(asset.file), ...await mediaInfo(asset.file) })));
  if (!assets.length) throw new HttpError(422, "素材文件夹中没有视频素材");
  const voiceInfo = await mediaInfo(voice);
  const actorInfo = await mediaInfo(actor);
  const actorKey = await detectPresenterKey(actor);
  return { voiceOptions: (await files(path.join(locations().sourceDir, "口播"))).map((file) => path.basename(file)), actorOptions: (await files(path.join(locations().sourceDir, await actorDirectory()))).map((file) => path.basename(file)), voice: { name: path.basename(voice), durationMs: voiceInfo.durationMs, captionsReady: !!(await transcriptFor(voice)) }, actor: { name: path.basename(actor), durationMs: actorInfo.durationMs, transparent: actorKey.mode === "alpha", keyMode: actorKey.mode }, assets: assets.map(({ file, ...rest }) => rest), slots: slots.map(({ id, label, group, share }) => ({ id, label, group, durationMs: Math.round(voiceInfo.durationMs * share) })) };
}

const assetFiles = async () => {
  const entries = await Promise.all([["wrong", "错误示范"], ["detail", "细节展示"]].map(async ([group, folder]) => (await files(path.join(locations().sourceDir, "素材", folder))).map((file, index) => ({ id: `${group}-${index + 1}`, group, file }))));
  return [...entries.flat(), ...(await files(path.join(locations().sourceDir, "素材"))).map((file, index) => ({ id: `material-${index + 1}`, group: "general", file }))];
};
const choose = (options, used, offset) => options[(offset + options.length) % options.length] ?? options.find((id) => !used.has(id));

export async function createMixVariants(count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 6) throw badRequest("一次可生成 1–6 个版本");
  const library = await mixLibrary();
  const created = [];
  for (let version = 0; version < count; version++) {
    const used = new Set();
    const selections = slots.map((slot, index) => {
      const options = library.assets.filter((asset) => (asset.group === slot.group || asset.group === "general")).map((asset) => asset.id);
      const available = options.filter((id) => !used.has(id));
      const id = choose(available.length ? available : options, used, version * 3 + index * 2);
      used.add(id);
      return { slot: slot.id, asset: id };
    });
    const variant = { id: `mix-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`, name: `混剪版本 ${version + 1}`, createdAt: new Date().toISOString(), selections, revision: 0 };
    await mkdir(locations().variantDir, { recursive: true });
    await writeFile(path.join(locations().variantDir, `${variant.id}.json`), JSON.stringify(variant, null, 2));
    created.push(variant);
  }
  return created;
}

const variantFile = (id) => {
  if (!/^mix-[a-z0-9-]+$/.test(id)) throw badRequest("无效版本 ID");
  return path.join(locations().variantDir, `${id}.json`);
};
export async function readMixVariant(id) {
  const raw = await readFile(variantFile(id), "utf8").catch(() => null);
  if (!raw) throw new HttpError(404, "混剪版本不存在");
  return JSON.parse(raw);
}
export async function listMixVariants() {
  const names = (await readdir(locations().variantDir).catch(() => [])).filter((name) => /^mix-[a-z0-9-]+\.json$/.test(name));
  const items = await Promise.all(names.map((name) => readMixVariant(name.slice(0, -5))));
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function saveMixVariantUnlocked(id, input) {
  const variant = await readMixVariant(id);
  const assets = await assetFiles();
  if (!Array.isArray(input.selections) || input.selections.length !== slots.length) throw badRequest("镜头槽位不完整");
  for (let i = 0; i < slots.length; i++) {
    const choice = input.selections[i];
    if (choice?.slot !== slots[i].id || !assets.some((asset) => asset.id === choice.asset && (asset.group === slots[i].group || asset.group === "general"))) throw badRequest(`镜头槽位 ${slots[i].label} 的素材无效`);
  }
  if (input.revision !== variant.revision) throw new HttpError(409, "版本已由其他操作更新，请刷新后重试");
  const lockedSlots = input.lockedSlots ?? variant.lockedSlots ?? [];
  if (!Array.isArray(lockedSlots) || lockedSlots.some((id) => !slots.some((slot) => slot.id === id))) throw badRequest("无效的锁定镜头");
  const changed = input.invalidate || JSON.stringify(input.selections) !== JSON.stringify(variant.selections);
  const updated = { ...variant, name: String(input.name ?? variant.name).trim().slice(0, 80) || variant.name, selections: input.selections, lockedSlots, revision: variant.revision + 1, preview: changed ? null : variant.preview, approvedRevision: changed ? null : variant.approvedRevision === variant.revision ? variant.revision + 1 : null };
  await writeJson(variantFile(id), updated);
  return updated;
}
export const saveMixVariant = (id, input) => editVariant(id, () => saveMixVariantUnlocked(id, input));
export async function cloneMixVariant(id) {
  const previous = await readMixVariant(id);
  const next = { ...previous, id: `mix-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`, name: `${previous.name} · 下一条`, revision: 0, createdAt: new Date().toISOString(), approvedRevision: null, approvedAt: null, exports: [] };
  await writeJson(variantFile(next.id), next);
  return next;
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const exists = async (file) => (await stat(file).catch(() => null))?.size > 0;
const updateJob = (job, phase, message) => { Object.assign(job, { phase, message }); persistJob(job).catch(() => {}); };
const slotDurations = (durationMs) => {
  const result = slots.map((slot) => Math.round(durationMs * slot.share / 1000 * 30) / 30);
  result[result.length - 1] = Math.round(durationMs / 1000 * 30) / 30 - result.slice(0, -1).reduce((sum, n) => sum + n, 0);
  return result;
};

async function renderMix(variant, job) {
  const width = job.quality === "hd" ? 1080 : 540;
  const height = width * 16 / 9;
  const library = await mixLibrary();
  const assets = await assetFiles();
  const [voice] = locations().voiceName ? [path.join(locations().sourceDir, "口播", locations().voiceName)] : await files(path.join(locations().sourceDir, "口播"));
  const [actor] = locations().actorName ? [path.join(locations().sourceDir, await actorDirectory(), locations().actorName)] : await files(path.join(locations().sourceDir, await actorDirectory()));
  const captions = await transcriptFor(voice);
  const actorKey = await detectPresenterKey(actor);
  const durations = slotDurations(library.voice.durationMs);
  const signature = digest({ renderer: 7, keyVersion: KEY_VERSION, actorKey, width, selections: variant.selections, durations, captions: captions?.hash, voice: [(await stat(voice)).size, (await stat(voice)).mtimeMs], actor: [(await stat(actor)).size, (await stat(actor)).mtimeMs], assets: await Promise.all(variant.selections.map(async (choice) => { const file = assets.find((item) => item.id === choice.asset).file; const info = await stat(file); return [file, info.size, info.mtimeMs]; })) });
  const output = path.join(locations().previewDir, `${variant.id}-${signature}.mp4`);
  if (await exists(output)) { updateJob(job, "completed", "预览已就绪"); return output; }
  await Promise.all([mkdir(locations().clipDir, { recursive: true }), mkdir(locations().previewDir, { recursive: true })]);
  const clips = [];
  for (let i = 0; i < slots.length; i++) {
    const choice = variant.selections[i];
    const asset = assets.find((item) => item.id === choice.asset);
    const duration = durations[i];
    const key = digest({ file: asset.file, duration, size: (await stat(asset.file)).size, modified: (await stat(asset.file)).mtimeMs, width });
    const clip = path.join(locations().clipDir, `${key}.mp4`);
    updateJob(job, "clips", `准备镜头 ${i + 1}/${slots.length}：${path.basename(asset.file)}`);
    if (!(await exists(clip))) {
      const temp = path.join(locations().clipDir, `${key}-${randomUUID()}.tmp.mp4`);
      const sourceDuration = (await mediaInfo(asset.file)).durationMs / 1000;
      const start = Math.max(0, Math.min(0.5, sourceDuration - duration));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-ss", String(start), "-i", asset.file, "-t", String(duration), "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,format=yuv420p`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-y", temp]);
      await rename(temp, clip);
    }
    clips.push(clip);
  }
  const list = path.join(locations().workDir, `concat-${randomUUID()}.txt`);
  await writeFile(list, clips.map((file) => `file '${file.replaceAll("\\", "/")}'`).join("\n"));
  const tempOutput = path.join(locations().previewDir, `${variant.id}-${signature}-${randomUUID()}.tmp.mp4`);
  const captionFile = captions ? path.join(locations().workDir, `captions-${captions.hash}.srt`) : null;
  if (captionFile) await writeFile(captionFile, captions.srt);
  const subtitleFilter = captionFile ? ",subtitles=" + path.relative(root, captionFile).split(path.sep).join("/") + ":force_style='FontName=Arial,FontSize=9,Outline=1,Shadow=0,Alignment=2,MarginV=100'" : "";
  updateJob(job, "compositing", "合成达人、实拍画面和固定口播");
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-stream_loop", "-1", "-i", actor, "-i", voice,
      "-filter_complex", `[1:v]${presenterFilter(actorKey, Math.round(width * 200 / 540))}[person];[0:v][person]overlay=W-w-8:H-h+8:shortest=1,format=yuv420p${subtitleFilter}[v]`,
      "-map", "[v]", "-map", "2:a:0", "-t", String(library.voice.durationMs / 1000), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", tempOutput]);
    await rename(tempOutput, output);
  } finally { await import("node:fs/promises").then(({ rm }) => Promise.all([rm(list, { force: true }), rm(tempOutput, { force: true })])); }
  updateJob(job, "completed", "预览已就绪");
  return output;
}

export async function startMixRender(id, quality = "preview") {
  await listMixJobs();
  if (!["preview", "hd"].includes(quality)) throw badRequest("无效输出规格");
  const variant = await readMixVariant(id);
  if (quality === "hd" && variant.approvedRevision !== variant.revision) throw badRequest("请先在审阅精修中确认当前版本");
  const current = [...jobs.values()].find((job) => job.variantId === id && job.quality === quality && ["queued", "running"].includes(job.state));
  if (current) return current;
  const job = { id: randomUUID(), variantId: id, quality, projectId: locations().projectId ?? null, state: "queued", phase: "queued", message: "等待生成", createdAt: new Date().toISOString(), preview: null, error: null };
  jobs.set(job.id, job);
  jobFiles.set(job.id, path.join(locations().variantDir, "..", "jobs", `${job.id}.json`));
  await persistJob(job);
  queue = queue.catch(() => {}).then(async () => {
    job.state = "running";
    try {
      const output = await renderMix(variant, job);
      job.preview = path.basename(output);
      job.state = "completed";
      await editVariant(id, async () => {
      const latest = await readMixVariant(id);
      if (quality === "hd") {
        const info = await probe(output);
        if (Math.abs(Number(info.format.duration) - (await mixLibrary()).voice.durationMs / 1000) > 0.15 || !info.streams.some((stream) => stream.codec_type === "audio") || !info.streams.some((stream) => stream.codec_type === "video" && stream.width === 1080 && stream.height === 1920)) throw new Error("导出时长、分辨率或音轨检查失败");
        await writeJson(variantFile(id), { ...latest, exports: [...(latest.exports ?? []), { file: job.preview, revision: variant.revision, createdAt: new Date().toISOString(), width: 1080, height: 1920, duration: Number(info.format.duration) }] });
      } else if (latest.revision === variant.revision) await writeJson(variantFile(id), { ...latest, preview: job.preview });
      });
      if (quality === "hd") job.message = "高清导出完成 · 时长、分辨率与音轨检查通过";
    }
    catch (error) { job.state = "failed"; job.phase = "failed"; job.error = error.message; job.message = "生成失败，可重试"; }
    await persistJob(job);
  });
  return job;
}
export async function prepareMixLayers(id) {
  const encode = async (target, args) => {
    const temporary = path.join(path.dirname(target), `${randomUUID()}.partial${path.extname(target)}`);
    try { await run("ffmpeg", [...args, "-y", temporary]); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  };
  const variant = await readMixVariant(id);
  const library = await mixLibrary();
  const assets = await assetFiles();
  const sourceDir = locations().sourceDir;
  const [voice] = locations().voiceName ? [path.join(sourceDir, "口播", locations().voiceName)] : await files(path.join(sourceDir, "口播"));
  const [actor] = locations().actorName ? [path.join(sourceDir, await actorDirectory(), locations().actorName)] : await files(path.join(sourceDir, await actorDirectory()));
  const key = digest([KEY_VERSION, variant.selections, await sha256File(voice), await sha256File(actor), await Promise.all(assets.map(async (asset) => [asset.file, (await stat(asset.file)).mtimeMs]))]);
  const folder = path.join(root, "public", "projects", locations().projectId, "mix-layers", key);
  await mkdir(folder, { recursive: true });
  const base = path.join(folder, "footage.mp4");

  const durations = slotDurations(library.voice.durationMs);
  if (!(await exists(base))) {
    const clips = [];
    for (let i = 0; i < variant.selections.length; i++) {
      const file = assets.find((asset) => asset.id === variant.selections[i].asset)?.file;
      if (!file) throw badRequest("组合中的素材不存在");
      const clip = path.join(folder, `clip-${i}.mp4`);
      if (!(await exists(clip))) await encode(clip, ["-v", "error", "-stream_loop", "-1", "-ss", "0.5", "-i", file, "-t", String(durations[i]), "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]);
      clips.push(clip);
    }
    const list = path.join(folder, "concat.txt");
    await writeFile(list, clips.map((file) => `file '${file.split(path.sep).join("/")}'`).join("\n"));
    await encode(base, ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", voice, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(library.voice.durationMs / 1000), "-movflags", "+faststart"]);
  }
  const presenter = await makePresenterLayer(actor, folder, library.voice.durationMs);
  const person = presenter.file;
  const relative = (file) => path.relative(path.join(root, "public"), file).split(path.sep).join("/");
  return { variant, key, source: { id: `mixbase-${key}`, file: relative(base) }, actor: { id: `presenter-${key}`, file: relative(person) }, durationMs: library.voice.durationMs };
}

export const listMixJobs = async () => {
  const folder = path.join(locations().variantDir, "..", "jobs");
  for (const name of await readdir(folder).catch(() => [])) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const saved = JSON.parse(await readFile(path.join(folder, name), "utf8"));
    if (jobs.has(saved.id)) continue;
    jobFiles.set(saved.id, path.join(folder, name));
    if (["queued", "running"].includes(saved.state)) {
      Object.assign(saved, { state: "failed", phase: "failed", message: "服务已重启，请重新生成", error: "上次任务被服务重启中断，已有素材与文件保留。" });
      await persistJob(saved);
    }
    jobs.set(saved.id, saved);
  }
  return [...jobs.values()].filter((job) => job.projectId === (locations().projectId ?? null));
};
export const mixJob = (id) => { const job = jobs.get(id); if (!job || job.projectId !== (locations().projectId ?? null)) throw new HttpError(404, "任务不存在"); return job; };
export const mixPreviewFile = (name) => {
  if (!/^mix-[a-z0-9-]+-[a-f0-9]{16}\.mp4$/.test(name)) throw badRequest("无效预览文件名");
  return path.join(locations().previewDir, name);
};
export async function mixThumbFile(id) {
  const asset = (await assetFiles()).find((item) => item.id === id);
  if (!asset) throw new HttpError(404, "素材不存在");
  await mkdir(locations().thumbDir, { recursive: true });
  const output = path.join(locations().thumbDir, `${id}-${digest([(await stat(asset.file)).mtimeMs, (await stat(asset.file)).size])}.jpg`);
  if (!(await exists(output))) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", asset.file, "-frames:v", "1", "-vf", "scale=180:-2", "-y", output]);
  return output;
}

export const approveMixVariant = (id, approve = true) => editVariant(id, async () => {
  const variant = await readMixVariant(id);
  if (!variant.preview) throw badRequest("请先生成并检查当前版本预览");
  const updated = { ...variant, approvedRevision: approve ? variant.revision : null, approvedAt: approve ? new Date().toISOString() : null };
  await writeJson(variantFile(id), updated);
  return updated;
});

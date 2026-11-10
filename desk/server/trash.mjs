// Reversible removal of one video's project data and its dedicated media/output.
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { exists, projectDir, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { conflict, unprocessable } from "./errors.mjs";
import { listJobs } from "./jobs.mjs";
import { inMixProject } from "./mix-projects.mjs";
import { listMixJobs } from "./mix.mjs";

const trashDir = path.join(root, "out", "desk-trash");
const transcriptsDir = path.join(root, "public", "transcripts");
const ownPaths = (id) => ({
  project: projectDir(id),
  media: path.join(root, "public", "projects", id),
  render: path.join(root, "out", "desk", id),
  cache: path.join(root, "out", "desk-cache", id),
});

export async function archiveVideo(id) {
  const source = ownPaths(id);
  if (!await exists(source.project)) throw unprocessable("该视频不存在或已删除");
  const jobs = await listJobs(id, 100000);
  if (jobs.some((job) => job.state === "queued" || job.state === "running")) throw conflict("视频有正在运行的任务，请完成后再删除");
  const project = await readJson(path.join(source.project, "project.json"), null);
  if (project?.mode === "mix" && (await inMixProject(id, () => listMixJobs())).some((job) => job.state === "queued" || job.state === "running")) throw conflict("混剪有正在运行的任务，请完成后再删除");
  const transcriptFiles = project?.transcript?.words === `transcripts/${id}-source.json`
    ? (await readdir(transcriptsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))).filter((name) => name.startsWith(`${id}-source.`))
    : [];
  const archiveId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${id}`;
  const destination = path.join(trashDir, archiveId);
  if (await exists(destination)) throw conflict("回收记录代号冲突，请稍后重试");
  await mkdir(destination, { recursive: true });
  const moved = [];
  const retainedPaths = [];
  try {
    if (transcriptFiles.length) await mkdir(path.join(destination, "transcripts"), { recursive: true });
    for (const name of transcriptFiles) {
      const from = path.join(transcriptsDir, name);
      const to = path.join(destination, "transcripts", name);
      await rename(from, to);
      moved.push({ from, to });
    }
    for (const key of ["media", "render", "cache", "project"]) {
      if (!await exists(source[key])) continue;
      const to = path.join(destination, key);
      try {
        await rename(source[key], to);
        moved.push({ from: source[key], to });
      } catch (error) {
        // Windows keeps a proxy directory locked while a browser is playing it.
        // Archiving the project still removes the video from the workbench; the
        // dedicated media stays in place until the user restores the project.
        if (key === "project" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        retainedPaths.push(key);
      }
    }
    const legacyNames = { bloom10: "第一版口播视频", "bloom10-demo": "剪辑效果演示", "bloom10-v2": "卡片式剪辑方案" };
    const record = { archiveId, id, title: legacyNames[id] ?? project?.title ?? id, productName: project?.productName ?? (id.startsWith("bloom10") ? "Bloom10 软糖" : "未分类产品"), archivedAt: new Date().toISOString(), retainedPaths };
    await writeJson(path.join(destination, "manifest.json"), record);
    return record;
  } catch (error) {
    for (const item of moved.reverse()) await rename(item.to, item.from).catch(() => {});
    throw error;
  }
}

export async function listArchivedVideos() {
  const entries = await readdir(trashDir, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readJson(path.join(trashDir, entry.name, "manifest.json"), null)));
  return records.filter((record) => record && !record.restoredAt).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export async function restoreVideo(archiveId) {
  if (!/^\d{17}-[a-z0-9][a-z0-9-]*$/.test(archiveId)) throw unprocessable("无效的回收记录");
  const destination = path.join(trashDir, archiveId);
  const record = await readJson(path.join(destination, "manifest.json"), null);
  if (!record || record.archiveId !== archiveId || record.restoredAt) throw unprocessable("回收记录不存在");
  const target = ownPaths(record.id);
  const archivedTranscripts = await readdir(path.join(destination, "transcripts")).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const key of Object.keys(target)) {
    if (await exists(path.join(destination, key)) && await exists(target[key])) throw conflict(`无法恢复：${key} 位置已有同名数据`);
  }
  for (const name of archivedTranscripts) if (await exists(path.join(transcriptsDir, name))) throw conflict(`无法恢复：转录文件 ${name} 已存在`);
  const moved = [];
  try {
    for (const key of ["media", "render", "cache", "project"]) {
      const source = path.join(destination, key);
      if (!await exists(source)) continue;
      await mkdir(path.dirname(target[key]), { recursive: true });
      await rename(source, target[key]);
      moved.push({ from: source, to: target[key] });
    }
    if (archivedTranscripts.length) await mkdir(transcriptsDir, { recursive: true });
    for (const name of archivedTranscripts) {
      const from = path.join(destination, "transcripts", name);
      const to = path.join(transcriptsDir, name);
      await rename(from, to);
      moved.push({ from, to });
    }
    await writeJson(path.join(destination, "manifest.json"), { ...record, restoredAt: new Date().toISOString() });
    return record;
  } catch (error) {
    for (const item of moved.reverse()) await rename(item.to, item.from).catch(() => {});
    throw error;
  }
}

export async function permanentlyDeleteVideo(archiveId) {
  if (!/^\d{17}-[a-z0-9][a-z0-9-]*$/.test(archiveId)) throw unprocessable("无效的回收记录");
  const destination = path.resolve(trashDir, archiveId);
  if (path.dirname(destination) !== trashDir) throw unprocessable("无效的回收记录路径");
  const record = await readJson(path.join(destination, "manifest.json"), null);
  if (!record || record.archiveId !== archiveId || record.restoredAt) throw unprocessable("回收记录不存在或已恢复");
  if (record.retainedPaths?.length) throw conflict("部分素材仍被其他程序占用并留在原位置。请先关闭占用程序，恢复该项目后再重新移入回收区。");
  const [canonicalTrash, canonicalDestination, info] = await Promise.all([realpath(trashDir), realpath(destination), lstat(destination)]);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(canonicalDestination).toLowerCase() !== canonicalTrash.toLowerCase())
    throw unprocessable("回收记录路径验证失败");
  await rm(canonicalDestination, { recursive: true, force: false });
  return { archiveId, deleted: true };
}

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { root, run, sha256File } from "../../scripts/lib/media.mjs";
import { listJson, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { HttpError, unprocessable } from "./errors.mjs";
import { parseEditPlan } from "../../src/engine/schema.ts";

const outputDir = (id) => path.join(root, "out", "desk", path.basename(projectFile(id)));
const exportFile = (id, exportId) => {
  if (!/^e-[\dT]+-\d{3}$/.test(exportId)) throw new HttpError(404, "Unknown export");
  return projectFile(id, "exports", `${exportId}.json`);
};

export function validateFilename(value) {
  if (typeof value !== "string" || !value || value.length > 120 || !/\.mp4$/i.test(value) ||
      /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]\.mp4$/i.test(value) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) || path.basename(value) !== value)
    throw unprocessable("文件名须为合法的 MP4 文件名（最多 120 字符，不能包含路径或系统保留字符）。");
  return value;
}

export async function exportSettings(id) {
  const plan = await readJson(projectFile(id, "edit-plan.json"), null);
  if (!plan) return { approved: false, reason: "请先确认分镜方案。" };
  const parsed = parseEditPlan(plan);
  const storyboard = plan.meta?.storyboard;
  let approved = true;
  let reason = null;
  if (storyboard?.round) {
    const selection = await readJson(projectFile(id, "storyboard", storyboard.round, "selection.json"), null);
    approved = selection?.state === "confirmed" && selection.option === storyboard.option;
    if (!approved) reason = "当前分镜尚未确认，或已与已确认的方案不一致。请返回分镜页确认。";
  }
  const title = (await readJson(projectFile(id, "project.json"), {})).title ?? plan.meta?.title ?? id;
  const filename = `${String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, "_").slice(0, 65) || id}_Final_${storyboard?.round ?? `r${plan.revision ?? 0}`}.mp4`;
  return {
    approved, reason, projectName: title, storyboardRound: storyboard?.round ?? null,
    revision: plan.revision ?? 0, planHash: await sha256File(projectFile(id, "edit-plan.json")),
    filename, width: plan.output.width, height: plan.output.height, fps: plan.output.fps,
    aspectRatio: `${plan.output.width / gcd(plan.output.width, plan.output.height)}:${plan.output.height / gcd(plan.output.width, plan.output.height)}`, format: "MP4", codec: "H.264",
    audio: parsed.audio.loudness.normalize ? `自动响度处理 · ${parsed.audio.loudness.targetLufs} LUFS` : "按方案保留原始音频设置",
    outputDirectory: outputDir(id),
  };
}

const gcd = (a, b) => b ? gcd(b, a % b) : a;

export async function listExports(id) {
  const names = (await listJson(projectFile(id, "exports"))).filter((name) => /^e-[\dT]+-\d{3}\.json$/.test(name)).reverse();
  return Promise.all(names.map((name) => readJson(projectFile(id, "exports", name))));
}

export async function finalizeExport(job) {
  const movie = path.resolve(root, job.output);
  const directory = outputDir(job.project);
  if (path.dirname(movie).toLowerCase() !== directory.toLowerCase()) throw new Error("导出文件不在项目输出目录");
  const info = await stat(movie);
  if (!info.isFile() || !info.size) throw new Error("导出文件不存在或为空");
  const qc = await readJson(movie.replace(/\.mp4$/i, ".qc/validation.json"), null);
  if (!qc?.automatedChecksPassed || !qc.width || !qc.height || !qc.fps || !Number.isFinite(qc.durationSeconds) || qc.durationSeconds <= 0 || !qc.codec)
    throw new Error("自动质检或视频元数据未通过，未生成成功导出记录");
  const thumbnail = movie.replace(/\.mp4$/i, ".thumbnail.jpg");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i", movie, "-frames:v", "1", "-vf", "scale=360:-2", thumbnail]);
  const record = {
    id: job.exportId, projectId: job.project, storyboardRevision: job.storyboardRound,
    editPlanRevision: job.editPlanRevision, editPlanSha256: job.inputs.editPlanSha256,
    filename: path.basename(movie), absolutePath: movie, relativePath: path.relative(root, movie).replaceAll("\\", "/"),
    renderedAt: new Date().toISOString(), qcStatus: "passed", status: "completed",
    video: { durationSeconds: qc.durationSeconds, width: qc.width, height: qc.height, fps: qc.fps, codec: qc.codec, audioCodec: qc.audioCodec },
    fileSize: info.size, thumbnail: path.relative(root, thumbnail).replaceAll("\\", "/"),
  };
  await writeJson(exportFile(job.project, job.exportId), record);
  return record;
}

export async function resolveExport(id, exportId, kind = "video") {
  const record = await readJson(exportFile(id, exportId));
  if (record.status !== "completed" || record.qcStatus !== "passed" || record.projectId !== id) throw new HttpError(404, "Export unavailable");
  const directory = await realpath(outputDir(id));
  const expected = path.join(directory, record.filename);
  const candidate = kind === "thumbnail" ? path.join(directory, path.basename(record.thumbnail ?? "")) : expected;
  const actual = await realpath(candidate);
  if (path.dirname(actual).toLowerCase() !== directory.toLowerCase() ||
      (kind === "video" && actual.toLowerCase() !== expected.toLowerCase()) ||
      (kind === "thumbnail" && path.basename(actual) !== path.basename(record.thumbnail ?? "")))
    throw new HttpError(403, "Export path is invalid");
  const info = await stat(actual);
  if (!info.isFile() || !info.size) throw new HttpError(404, "Export file unavailable");
  return { record, file: actual };
}

export async function revealExport(id, exportId) {
  if (process.platform !== "win32") throw new HttpError(501, "打开文件夹仅支持 Windows；可复制文件路径。");
  const { file } = await resolveExport(id, exportId);
  await new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [`/select,${file}`], { windowsHide: false, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", resolve);
    child.unref();
  });
  return { ok: true, path: file };
}

import { cp, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { publicDir, root, run } from "../../scripts/lib/media.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import * as mix from "./mix.mjs";

export async function inspectMixFolder(input) {
  if (!path.isAbsolute(String(input.folder ?? ""))) throw badRequest("请填写素材文件夹的绝对路径");
  const sourceDir = path.resolve(input.folder);
  const actorFolder = await mix.actorDirectory(sourceDir);
  for (const [key, folder] of [["voiceName", "口播"], ["actorName", actorFolder]]) {
    if (input[key] && (path.basename(input[key]) !== input[key] || !(await stat(path.join(sourceDir, folder, input[key])).catch(() => null))?.isFile())) throw badRequest("选中的口播或达人文件不存在");
  }
  return mix.withMixContext({ sourceDir, voiceName: input.voiceName, actorName: input.actorName }, () => mix.mixLibrary());
}

export async function inMixProject(id, action) {
  const project = await readJson(projectFile(id, "project.json"));
  if (project.mode !== "mix") throw badRequest("此项目没有选择达人侧边混剪风格");
  const workDir = path.join(root, "out", "desk", id, "mix");
  return mix.withMixContext({ projectId: id, voiceName: project.voiceName, actorName: project.actorName, sourceDir: path.join(publicDir, "projects", id, "mix-source"), workDir, variantDir: projectFile(id, "mix", "variants"), clipDir: path.join(workDir, "clips"), previewDir: path.join(workDir, "previews"), thumbDir: path.join(workDir, "thumbs") }, action);
}

export async function createMixProject(input) {
  const title = String(input.title ?? "").trim();
  const productName = String(input.productName ?? "").trim();
  if (!title || !productName || title.length > 100 || productName.length > 100) throw badRequest("请填写项目和产品名称（不超过 100 字）");
  const source = path.resolve(String(input.folder ?? path.join(root, "sucai")));
  if (!path.isAbsolute(String(input.folder ?? source))) throw badRequest("请使用素材文件夹的绝对路径");
  const library = await inspectMixFolder({ ...input, folder: source });
  const id = `mix-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const destination = path.join(publicDir, "projects", id, "mix-source");
  await mkdir(destination, { recursive: true });
  // Copy only the declared media folders; source footage stays untouched.
  for (const folder of ["口播", "素材"]) await cp(path.join(source, folder), path.join(destination, folder), { recursive: true, errorOnExist: true, force: false });
  await cp(path.join(source, await mix.actorDirectory(source)), path.join(destination, "达人"), { recursive: true, errorOnExist: true, force: false });
  const oldPrefix = path.parse(library.voice.name).name;
  const voiceName = `${id}-source${path.extname(library.voice.name)}`;
  await rename(path.join(destination, "口播", library.voice.name), path.join(destination, "口播", voiceName));
  // The manifest pins the chosen voice and actor when folders contain alternatives.
  await writeJson(projectFile(id, "project.json"), { id, title, productName, mode: "mix", style: "presenter-mix@1", sourceFolder: source, voiceName, actorName: library.actor.name, transcript: { words: `transcripts/${id}-source.json`, cues: `transcripts/${id}-source.cues.json` }, media: { originalName: library.voice.name, bytes: (await stat(path.join(destination, "口播", voiceName))).size, durationMs: library.voice.durationMs, width: 1080, height: 1920 } });
  await writeJson(projectFile(id, "status.json"), { project: id, stage: "setup", stages: { setup: { state: "in-progress" }, "asset-prep": { state: "pending" }, storyboard: { state: "pending" }, "timeline-review": { state: "pending" }, "render-qc": { state: "pending" } }, updatedAt: new Date().toISOString() });
  try {
    if (library.voice.captionsReady) {
      for (const suffix of ["json", "cues.json", "srt", "txt", "meta.json", "review.json"]) await cp(path.join(publicDir, "transcripts", `${oldPrefix}.${suffix}`), path.join(publicDir, "transcripts", `${id}-source.${suffix}`));
    } else await run(process.execPath, ["scripts/transcribe.mjs", path.join(destination, "口播", voiceName), "--language", "auto"]);
    await setMixStage(id, "asset-prep");
  } catch (error) {
    await writeJson(projectFile(id, "mix", "preparation-error.json"), { error: error.message });
    // Imported media remains usable even when subtitles need a retry.
    await setMixStage(id, "asset-prep");
  }
  return { id };
}

export async function setMixStage(id, stage) {
  if (!["setup", "asset-prep", "storyboard", "timeline-review", "render-qc"].includes(stage)) throw badRequest("无效阶段");
  const status = await readJson(projectFile(id, "status.json"));
  status.stage = stage;
  status.stages[stage] = { state: "waiting-user" };
  if (stage === "asset-prep") status.stages.setup = { state: "done" };
  status.updatedAt = new Date().toISOString();
  await writeJson(projectFile(id, "status.json"), status);
  return status;
}

export async function mixProjectAction(id, method, resource, body = {}) {
  return inMixProject(id, async () => {
    if (resource === "library" && method === "GET") return mix.mixLibrary();
    if (resource === "variants" && method === "GET") return mix.listMixVariants();
    if (resource === "variants" && method === "POST") return mix.createMixVariants(body.count ?? 3);
    if (resource === "jobs" && method === "GET") return mix.listMixJobs();
    if (resource === "stage" && method === "POST") return setMixStage(id, body.stage);
    if (resource === "editor" && method === "POST") return (await import("./mix-editor.mjs")).openMixInEditor(id, body.variant);
    if (resource === "presenter-refresh" && method === "POST") return (await import("./presenter-refresh.mjs")).refreshPresenter(id);
    if (resource === "next" && method === "POST") {
      const current = await readJson(projectFile(id, "mix/current.json"));
      return mix.cloneMixVariant(current.variant);
    }
    if (resource === "sources" && method === "PUT") {
      if ((await mix.listMixJobs()).some((job) => ["queued", "running"].includes(job.state))) throw badRequest("请等生成任务完成后再更换达人文件");
      const library = await mix.mixLibrary();
      if (!library.actorOptions.includes(body.actorName)) throw badRequest("达人文件不在项目素材中");
      const project = await readJson(projectFile(id, "project.json"));
      await writeJson(projectFile(id, "project.json"), { ...project, actorName: body.actorName });
      for (const variant of await mix.listMixVariants()) await mix.saveMixVariant(variant.id, { ...variant, invalidate: true });
      return { ok: true };
    }
    const parts = resource.split("/");
    if (parts[0] === "variants" && parts.length === 2 && method === "PUT") return mix.saveMixVariant(parts[1], body);
    if (parts[0] === "variants" && parts[2] === "render" && method === "POST") return mix.startMixRender(parts[1], body.quality ?? "preview");
    if (parts[0] === "variants" && parts[2] === "approve" && method === "POST") return mix.approveMixVariant(parts[1]);
    if (parts[0] === "variants" && parts[2] === "unapprove" && method === "POST") return mix.approveMixVariant(parts[1], false);
    throw new HttpError(404, "混剪接口不存在");
  });
}

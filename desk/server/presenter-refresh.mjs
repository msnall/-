import path from "node:path";
import { cp, readdir, stat } from "node:fs/promises";
import { publicDir, sha256File } from "../../scripts/lib/media.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { installCompiledPlan, withLock, updateStatus } from "./projects.mjs";
import { inMixProject, inspectMixFolder } from "./mix-projects.mjs";
import { actorDirectory, listMixVariants, saveMixVariant, listMixJobs } from "./mix.mjs";
import { makePresenterLayer } from "./presenter-key.mjs";
import { badRequest } from "./errors.mjs";

export const refreshPresenter = (id) => withLock(id, async () => {
  const project = await readJson(projectFile(id, "project.json"));
  if (project.mode !== "mix") throw badRequest("仅混剪项目支持此操作");
  if ((await inMixProject(id, () => listMixJobs())).some((job) => ["running", "queued"].includes(job.state))) throw badRequest("请等待当前混剪生成任务完成");
  const library = await inspectMixFolder({ folder: project.sourceFolder });
  const preferred = project.actorSourceName ?? project.actorName;
  const selected = library.actorOptions.includes(preferred) ? preferred : library.actorOptions.find((name) => path.parse(name).name === path.parse(preferred).name) ?? library.actor.name;
  const original = path.join(project.sourceFolder, await actorDirectory(project.sourceFolder), selected);
  const hash = await sha256File(original);
  const folder = await inMixProject(id, () => actorDirectory());
  const name = `${path.parse(selected).name}-${hash.slice(0, 10)}${path.extname(selected)}`;
  const source = path.join(publicDir, "projects", id, "mix-source", folder, name);
  if (!(await stat(source).catch(() => null))) await cp(original, source, { force: false, errorOnExist: true });
  const layer = await makePresenterLayer(source, path.join(publicDir, "projects", id, "presenter-layers"), project.media.durationMs);
  const actor = { id: `presenter-${layer.hash}`, file: path.relative(publicDir, layer.file).split(path.sep).join("/") };
  const current = await readJson(projectFile(id, "mix/current.json"), null);
  const plan = await readJson(projectFile(id, "edit-plan.json"), null);
  const assets = await readJson(projectFile(id, "assets.json"), { version: 1, items: [], claims: [] });
  if (!assets.items.some((item) => item.id === actor.id)) assets.items.push({ id: actor.id, kind: "video", status: "available", label: "自动抠像达人", file: actor.file, source: "达人原片自动抠像", neededBy: [], candidates: [] });
  await writeJson(projectFile(id, "assets.json"), assets);
  if (current?.actor.id === actor.id && project.actorName === name) return { mode: layer.key.mode, changed: false };
  await writeJson(projectFile(id, "project.json"), { ...project, actorName: name, actorSourceName: selected });
  let selectedRevision = current?.revision;
  await inMixProject(id, async () => {
    for (const variant of await listMixVariants()) {
      const next = await saveMixVariant(variant.id, { ...variant, invalidate: true });
      if (variant.id === current?.variant) selectedRevision = next.revision;
    }
  });
  if (current) {
    const rounds = (await readdir(projectFile(id, "storyboard"))).filter((value) => /^r\d+$/.test(value));
    const round = `r${Math.max(...rounds.map((value) => Number(value.slice(1)))) + 1}`;
    const priorRound = plan?.meta?.storyboard?.round ?? current.round;
    const selection = await readJson(projectFile(id, "storyboard", priorRound, "selection.json"));
    const optionId = selection.option ?? "option-a";
    const option = await readJson(projectFile(id, "storyboard", priorRound, `${optionId}.json`));
    const snapshot = { ...current, round, revision: selectedRevision, actor };
    const nextSelection = { ...selection, round, confirmedAt: plan ? new Date().toISOString() : null, state: plan ? "confirmed" : "draft", draftOption: selection.draftOption ? { ...selection.draftOption, round } : null };
    if (plan) {
      const presenter = plan.overlays.find((item) => item.id === "mix-presenter");
      const nextPlan = structuredClone(plan);
      nextPlan.assets[actor.id] = { type: "video", path: actor.file };
      const nextPresenter = nextPlan.overlays.find((item) => item.id === "mix-presenter");
      if (nextPresenter) nextPresenter.props.asset = actor.id;
      nextPlan.meta.storyboard.round = round;
      nextPlan.meta.mix = { ...nextPlan.meta.mix, round, revision: selectedRevision };
      snapshot.inherited = { style: plan.meta.storyboard.style, captions: plan.captions, theme: plan.theme, layout: plan.layout, presenter: presenter?.props };
      nextSelection.videoSettings = { captions: plan.captions ? { enabled: true, fontSize: plan.captions.fontSize, color: plan.captions.color, activeColor: plan.captions.activeColor, background: plan.captions.background ?? null, box: plan.captions.box } : { enabled: false }, presenter: presenter ? { enabled: true, box: { x: presenter.props.x, y: presenter.props.y, width: presenter.props.width, height: presenter.props.height } } : { enabled: false } };
      await installCompiledPlan(id, nextPlan, `自动抠像更新：${layer.key.mode}，保留时间轴与视觉设置`);
    }
    await writeJson(projectFile(id, "storyboard", round, `${optionId}.json`), { ...option, round });
    await writeJson(projectFile(id, "storyboard", round, "selection.json"), nextSelection);
    await writeJson(projectFile(id, "storyboard", round, "mix.json"), snapshot);
    await writeJson(projectFile(id, "mix/current.json"), snapshot);
    await updateStatus(id, (status) => { status.stages.storyboard = { ...status.stages.storyboard, round }; });
  }
  return { mode: layer.key.mode, changed: true, actor: actor.id };
});

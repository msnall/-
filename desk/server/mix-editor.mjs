import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { publicDir, run } from "../../scripts/lib/media.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { withLock } from "./projects.mjs";
import { inMixProject } from "./mix-projects.mjs";
import { prepareMixLayers, readMixVariant } from "./mix.mjs";
import { conflict } from "./errors.mjs";

// Prepare editable layers for the existing storyboard compiler. Confirmation
// still happens through its normal endpoint; no edit-plan is installed here.
export const openMixInEditor = (id, variantId) => withLock(id, () => inMixProject(id, async () => {
  const variant = await readMixVariant(variantId);
  const current = await readJson(projectFile(id, "mix/current.json"), null);
  if (current?.variant === variantId && current.revision === variant.revision) return current;
  const layers = await prepareMixLayers(variantId);
  if ((await readMixVariant(variantId)).revision !== variant.revision) throw conflict("组合已更新，请重新进入效果编辑");
  const project = await readJson(projectFile(id, "project.json"));
  const status = await readJson(projectFile(id, "status.json"));
  const { readdir } = await import("node:fs/promises");
  const rounds = (await readdir(projectFile(id, "storyboard")).catch(() => [])).filter((name) => /^r\d+$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const last = rounds.at(-1);
  const round = `r${last ? Number(last.slice(1)) + 1 : 1}`;
  const previousSelection = last ? await readJson(projectFile(id, "storyboard", last, "selection.json"), null) : null;
  const previous = previousSelection?.draftOption ?? (last ? await readJson(projectFile(id, "storyboard", last, `${previousSelection?.option ?? "option-a"}.json`), null) : null);
  const words = await readJson(path.join(publicDir, project.transcript.words));
  const cues = await readJson(path.join(publicDir, project.transcript.cues));
  const beats = cues.map((cue, index) => {
    const within = words.map((word, i) => ({ ...word, i })).filter((word) => word.startMs >= cue.startMs && word.endMs <= cue.endMs);
    if (!within.length) throw new Error("字幕没有对应词，请先完成口播转录");
    return { id: `b${index + 1}`, role: index === 0 ? "hook" : index === cues.length - 1 ? "cta" : "benefit", words: [within[0].i, within.at(-1).i], text: cue.text, claims: [] };
  });
  const assets = await readJson(projectFile(id, "assets.json"), { version: 1, items: [], claims: [] });
  for (const [asset, kind, label] of [[layers.source, "footage", "混剪实拍画面"], [layers.actor, "video", "达人图层"]]) {
    if (!assets.items.some((item) => item.id === asset.id)) assets.items.push({ id: asset.id, kind, label, status: "available", file: asset.file, source: "项目混剪组合", neededBy: [], candidates: [] });
  }
  const proxyDir = path.join(publicDir, "projects", id, "proxy");
  await mkdir(proxyDir, { recursive: true });
  const proxy = `projects/${id}/proxy/${layers.source.id}.mp4`;
  if (!(await stat(path.join(publicDir, proxy)).catch(() => null))?.size) await run("ffmpeg", ["-v", "error", "-i", path.join(publicDir, layers.source.file), "-vf", "scale=540:960", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", "-y", path.join(publicDir, proxy)]);
  const info = await stat(path.join(publicDir, layers.source.file));
  const proxies = await readJson(projectFile(id, "analysis/proxies.json"), { version: 1, assets: {} });
  proxies.assets[layers.source.id] = { file: proxy, width: 540, height: 960, durationMs: layers.durationMs, sourceSize: info.size, sourceMtimeMs: info.mtimeMs, createdAt: new Date().toISOString() };
  await writeJson(projectFile(id, "analysis/proxies.json"), proxies);
  await writeJson(projectFile(id, "assets.json"), assets);
  await writeJson(projectFile(id, "analysis/beats.json"), { version: 1, confirmedAt: new Date().toISOString(), beats });
  await writeJson(projectFile(id, "project.json"), { ...project, output: { width: 1080, height: 1920, fps: 30 }, footage: layers.source.id });
  const option = { id: "option-a", round, title: `${variant.name} · 效果方案`, style: previous?.style ?? "clean-pink@1", summary: "镜头组合已在内容与素材完成；在此选择字幕、转场和视觉效果。", rows: beats.map((beat) => ({ beat: beat.id, keep: true, onScreen: "混剪实拍与独立达人图层", cards: previous?.rows.find((row) => row.beat === beat.id)?.cards ?? [] })), global: previous?.global ?? [], keyframes: [], createdBy: "workbench" };
  await writeJson(projectFile(id, "storyboard", round, "option-a.json"), option);
  const priorPlan = await readJson(projectFile(id, "edit-plan.json"), null);
  const presenterProps = priorPlan?.overlays?.find((overlay) => overlay.id === "mix-presenter")?.props;
  const videoSettings = priorPlan ? {
    captions: priorPlan.captions ? { enabled: true, fontSize: priorPlan.captions.fontSize, color: priorPlan.captions.color, activeColor: priorPlan.captions.activeColor, background: priorPlan.captions.background ?? null, box: priorPlan.captions.box } : { enabled: false },
    presenter: presenterProps ? { enabled: true, box: { x: presenterProps.x, y: presenterProps.y, width: presenterProps.width, height: presenterProps.height } } : { enabled: false },
  } : previousSelection?.videoSettings;
  await writeJson(projectFile(id, "storyboard", round, "selection.json"), { round, option: "option-a", state: "draft", style: previousSelection?.style ?? null, layoutOverrides: previousSelection?.layoutOverrides ?? {}, draftOption: null, transitions: previousSelection?.transitions ?? {}, videoSettings, confirmedAt: null });
  const snapshot = { round, variant: variantId, revision: variant.revision, source: layers.source, actor: layers.actor, inherited: priorPlan ? { style: priorPlan.meta?.storyboard?.style, captions: priorPlan.captions, theme: priorPlan.theme, layout: priorPlan.layout, presenter: priorPlan.overlays?.find((overlay) => overlay.id === "mix-presenter")?.props } : null };
  await writeJson(projectFile(id, "storyboard", round, "mix.json"), snapshot);
  await writeJson(projectFile(id, "mix/current.json"), snapshot);
  await writeJson(projectFile(id, "status.json"), { ...status, stage: "storyboard", stages: { ...status.stages, "asset-prep": { state: "done" }, storyboard: { state: "waiting-user", round } }, updatedAt: new Date().toISOString() });
  return snapshot;
}));

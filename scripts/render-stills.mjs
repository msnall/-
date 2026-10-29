// Still frames of a project's edit-plan, for Claude to look at, for
// proposals' before/after comparisons and for storyboard option keyframes.
//
//   node scripts/render-stills.mjs bloom10-demo --frames=312,540
//       -> out/desk-cache/<id>/stills/r<revision>-f<frame>.jpg
//   node scripts/render-stills.mjs bloom10-demo --proposal=p-0007 --frames=312 [--after-frames=303]
//       -> projects/<id>/proposals/previews/p-0007-before-f0312.jpg / -after-f0303.jpg
//          and fills the proposal's preview.before / preview.after
//   node scripts/render-stills.mjs bloom10-v2 --round=r1 --option=option-a [--frames=…]
//       -> projects/<id>/storyboard/r1/option-a-k<frame>.jpg (frames picked
//          automatically unless given) and fills the option's keyframes
//
// --scale=0.5 (default) keeps the images small. Bundles once per run.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEditPlan } from "../src/engine/load.ts";
import { compileProjectOption } from "./lib/storyboard-files.mjs";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { applyPatch } from "./lib/json-patch.mjs";
import { relative, root } from "./lib/media.mjs";
import { projectFile, projectIdFrom, readJson, writeJson } from "./lib/storage.mjs";

const chrome = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const frameList = (text) => {
  const frames = String(text ?? "").split(",").filter(Boolean).map(Number);
  if (!frames.length || frames.some((frame) => !Number.isInteger(frame) || frame < 0)) throw new Error(`--frames must be a comma-separated list of frame numbers, got "${text}"`);
  return frames;
};

// Keyframes for a storyboard option: the opening, each overlay's entrance,
// just after each cut, and the end; at most 6.
async function keyframesFor(plan) {
  const { resolved } = await loadEditPlan(plan, async (publicPath) => JSON.parse(await readFile(path.join(root, "public", publicPath), "utf8")));
  const last = resolved.durationInFrames - 1;
  const picks = [{ frame: Math.min(12, last), label: "开场" }];
  for (const overlay of resolved.overlays) picks.push({ frame: Math.min(overlay.from + 12, last), label: overlay.id });
  for (const segment of resolved.footage.segments.slice(1)) picks.push({ frame: Math.min(segment.from + 8, last), label: `剪辑点 ${segment.id}` });
  const unique = [...new Map(picks.map((pick) => [pick.frame, pick])).values()].sort((a, b) => a.frame - b.frame);
  const middle = unique.slice(1, 5);
  return [unique[0], ...middle, { frame: Math.max(0, last - 15), label: "结尾" }];
}

export async function renderStills(projectId, { frames, afterFrames, proposalId, round, optionId, scale = 0.5, log = console.log }) {
  const jobs = [];
  let proposal = null;
  let option = null;
  let plan = null;
  if (optionId) {
    const result = await compileProjectOption(projectId, round, optionId);
    if (!result.plan) throw new Error(`${optionId} does not compile:\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}`);
    plan = result.plan;
    option = { file: projectFile(projectId, "storyboard", round, `${optionId}.json`) };
    option.data = await readJson(option.file);
    const picks = frames?.length ? frames.map((frame) => ({ frame, label: `第 ${frame} 帧` })) : await keyframesFor(plan);
    for (const pick of picks) {
      const output = projectFile(projectId, "storyboard", round, `${optionId}-k${String(pick.frame).padStart(4, "0")}.jpg`);
      jobs.push({ plan, frame: pick.frame, output, label: pick.label });
    }
  }
  if (!plan) plan = await readJson(projectFile(projectId, "edit-plan.json"));
  const revision = plan.revision ?? 0;
  if (optionId) {
    // jobs already set
  } else if (proposalId) {
    proposal = await readJson(projectFile(projectId, "proposals", `${proposalId}.json`));
    const patched = applyPatch(plan, proposal.changes);
    const dir = projectFile(projectId, "proposals/previews");
    const name = (side, frame) => path.join(dir, `${proposalId}-${side}-f${String(frame).padStart(4, "0")}.jpg`);
    for (const frame of frames) jobs.push({ plan, frame, output: name("before", frame), side: "before" });
    for (const frame of afterFrames ?? frames) jobs.push({ plan: patched, frame, output: name("after", frame), side: "after" });
  } else {
    for (const frame of frames) jobs.push({ plan, frame, output: path.join(root, "out/desk-cache", projectId, "stills", `r${revision}-f${String(frame).padStart(4, "0")}.jpg`) });
  }

  log("stills: bundling…");
  const serveUrl = await bundle({ entryPoint: path.join(root, "src/index.ts"), publicDir: path.join(root, "public") });
  const written = { before: [], after: [], all: [] };
  for (const job of jobs) {
    const inputProps = { plan: job.plan };
    const composition = await selectComposition({ serveUrl, id: "EditPlan", inputProps, browserExecutable: chrome });
    if (job.frame >= composition.durationInFrames) throw new Error(`frame ${job.frame} is past the end (${composition.durationInFrames} frames)`);
    await renderStill({ serveUrl, composition, inputProps, frame: job.frame, output: job.output, imageFormat: "jpeg", jpegQuality: 85, scale, browserExecutable: chrome, overwrite: true });
    const file = relative(job.output);
    written.all.push(file);
    if (job.side) written[job.side].push(path.relative(projectFile(projectId), job.output).split(path.sep).join("/"));
    log(`stills: ${file}`);
  }
  if (proposal) {
    proposal.preview = { ...(proposal.preview ?? {}), before: written.before, after: written.after };
    await writeJson(projectFile(projectId, "proposals", `${proposalId}.json`), proposal);
    log(`stills: preview recorded in proposals/${proposalId}.json`);
  }
  if (option) {
    const keep = new Set(jobs.map((job) => job.output));
    for (const old of option.data.keyframes ?? []) {
      const file = projectFile(projectId, old.file);
      if (!keep.has(file)) await rm(file, { force: true });
    }
    option.data.keyframes = jobs.map((job) => ({ frame: job.frame, file: path.relative(projectFile(projectId), job.output).split(path.sep).join("/"), label: job.label }));
    await writeJson(option.file, option.data);
    log(`stills: keyframes recorded in storyboard/${round}/${optionId}.json`);
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [argument, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.map((arg) => arg.replace(/^--/, "").split("=")));
  try {
    if (!argument) throw new Error("Usage: node scripts/render-stills.mjs <project-id> (--frames=a,b [--proposal=p-NNNN] [--after-frames=c,d] | --round=r1 --option=option-a [--frames=a,b]) [--scale=0.5]");
    await renderStills(projectIdFrom(argument), {
      frames: flags.option && !flags.frames ? undefined : frameList(flags.frames),
      round: flags.round ?? "r1",
      optionId: flags.option,
      afterFrames: flags["after-frames"] ? frameList(flags["after-frames"]) : undefined,
      proposalId: flags.proposal,
      scale: flags.scale ? Number(flags.scale) : 0.5,
    });
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}

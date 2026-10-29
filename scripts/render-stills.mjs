// Still frames of a project's edit-plan, for Claude to look at and for
// proposals' before/after comparisons.
//
//   node scripts/render-stills.mjs bloom10-demo --frames=312,540
//       -> out/desk-cache/<id>/stills/r<revision>-f<frame>.jpg
//   node scripts/render-stills.mjs bloom10-demo --proposal=p-0007 --frames=312 [--after-frames=303]
//       -> projects/<id>/proposals/previews/p-0007-before-f0312.jpg / -after-f0303.jpg
//          and fills the proposal's preview.before / preview.after
//
// --scale=0.5 (default) keeps the images small. Bundles once per run.
import path from "node:path";
import { pathToFileURL } from "node:url";
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

export async function renderStills(projectId, { frames, afterFrames, proposalId, scale = 0.5, log = console.log }) {
  const plan = await readJson(projectFile(projectId, "edit-plan.json"));
  const revision = plan.revision ?? 0;
  const jobs = [];
  let proposal = null;
  if (proposalId) {
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
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [argument, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.map((arg) => arg.replace(/^--/, "").split("=")));
  try {
    if (!argument) throw new Error("Usage: node scripts/render-stills.mjs <project-id> --frames=a,b [--proposal=p-NNNN] [--after-frames=c,d] [--scale=0.5]");
    await renderStills(projectIdFrom(argument), {
      frames: frameList(flags.frames),
      afterFrames: flags["after-frames"] ? frameList(flags["after-frames"]) : undefined,
      proposalId: flags.proposal,
      scale: flags.scale ? Number(flags.scale) : 0.5,
    });
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}

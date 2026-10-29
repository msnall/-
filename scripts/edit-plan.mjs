// Validate an edit-plan and resolve its timeline.
//
//   node scripts/edit-plan.mjs projects/bloom10/edit-plan.json
//
// Checks the schema, registered effects, every referenced file under public/
// (existence, SHA-256 when given, every frame of an image sequence, video
// durations) and that every word anchor still matches the transcript. Writes
// out/edit-plans/<id>/edit-plan.resolved.json (for inspection) and
// render-props.json (what render-plan.mjs passes to Remotion).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkLayout } from "../src/engine/layout.ts";
import { assetFile, imageSequenceFile, loadEditPlan, parseEditPlan, PlanError } from "../src/engine/load.ts";
import { loadLayoutContext } from "./lib/layout-context.mjs";
import { probe, publicDir, relative, root, sha256File } from "./lib/media.mjs";

const isFile = async (file) => (await stat(file).catch(() => null))?.isFile() ?? false;

// Full validation of a raw plan object against the files it references.
// `hashFile` / `probeFile` can be replaced by cached versions (the review desk
// server validates on every save).
export async function validatePlan(raw, { hashFile = sha256File, probeFile = probe } = {}) {
  const plan = parseEditPlan(raw);

  const problems = [];
  const facts = { durationMs: {} };
  for (const [id, asset] of Object.entries(plan.assets)) {
    if (asset.type === "imageSequence") {
      const missing = [];
      for (let index = 0; index < asset.frameCount; index++) {
        const frame = imageSequenceFile(asset.dir, asset.pattern, index);
        if (!(await isFile(path.join(publicDir, frame)))) missing.push(frame);
      }
      if (missing.length) {
        problems.push(`assets.${id}: ${missing.length} of ${asset.frameCount} frames missing under public/, e.g. ${missing.slice(0, 3).join(", ")}. Run the project's prepare step first.`);
      }
      continue;
    }
    const file = path.join(publicDir, asset.path);
    if (!(await isFile(file))) {
      problems.push(`assets.${id}: public/${asset.path} does not exist`);
      continue;
    }
    if (asset.sha256) {
      const actual = await hashFile(file);
      if (actual !== asset.sha256) problems.push(`assets.${id}: public/${asset.path} SHA-256 is ${actual}, plan expects ${asset.sha256}. The file was replaced; re-review before using it.`);
    }
    if (asset.type === "video") {
      const info = await probeFile(file);
      facts.durationMs[id] = Number(info.format.duration) * 1000;
    }
  }
  for (const [index, font] of plan.theme.fonts.entries()) {
    if (!(await isFile(path.join(publicDir, font.src)))) problems.push(`theme.fonts[${index}]: public/${font.src} does not exist`);
  }
  if (plan.transcript) {
    for (const key of ["words", "cues"]) {
      if (!(await isFile(path.join(publicDir, plan.transcript[key])))) problems.push(`transcript.${key}: public/${plan.transcript[key]} does not exist`);
    }
  }
  if (problems.length) throw new PlanError(problems);

  const { resolved } = await loadEditPlan(raw, async (publicPath) => JSON.parse(await readFile(path.join(publicDir, publicPath), "utf8")), facts);

  const used = new Set([
    ...plan.segments.map((segment) => segment.asset),
    ...plan.audio.tracks.map((track) => track.asset),
    ...resolved.overlays.flatMap((overlay) => (typeof overlay.props.asset === "string" ? [overlay.props.asset] : [])),
  ]);
  const unused = Object.keys(plan.assets).filter((id) => !used.has(id) && id !== plan.transcript?.asset);
  return { plan, resolved, unused };
}

export async function checkPlan(planArgument, { log = console.log } = {}) {
  const planPath = path.resolve(root, planArgument);
  let raw;
  try {
    raw = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    throw new PlanError([`${relative(planPath)}: ${error.code === "ENOENT" ? "file not found" : error.message}`]);
  }
  const { plan, resolved, unused } = await validatePlan(raw);
  const layoutContext = await loadLayoutContext(path.dirname(planPath), plan);
  const warnings = checkLayout(resolved, layoutContext);

  const outDir = path.join(root, "out/edit-plans", plan.id);
  await mkdir(outDir, { recursive: true });
  const propsPath = path.join(outDir, "render-props.json");
  await writeFile(path.join(outDir, "edit-plan.resolved.json"), JSON.stringify(resolved, null, 2) + "\n");
  await writeFile(propsPath, JSON.stringify({ plan: raw }) + "\n");

  log(`OK ${relative(planPath)} (${plan.id})`);
  log(`  output     ${resolved.width}x${resolved.height} @ ${resolved.fps}fps, ${resolved.durationInFrames} frames (${(resolved.durationInFrames / resolved.fps).toFixed(3)} s)`);
  for (const segment of resolved.footage.segments) {
    log(`  segment    ${segment.id}: source ${segment.sourceStartMs}–${segment.sourceEndMs} ms -> frames ${segment.from}–${segment.from + segment.durationInFrames}${segment.camera.zoom !== 1 ? ` zoom ${segment.camera.zoom}` : ""}${segment.camera.punchIns.length ? `, ${segment.camera.punchIns.length} punch-in(s)` : ""}`);
  }
  if (resolved.captions) log(`  captions   ${resolved.captions.cues.length} cues, ${resolved.report.captionWords} words${resolved.report.droppedCues ? `, ${resolved.report.droppedCues} cue(s) fall in cut source and are not shown` : ""}`);
  for (const overlay of resolved.overlays) log(`  overlay    ${overlay.id}: ${overlay.effect} frames ${overlay.from}–${overlay.from + overlay.durationInFrames} (${overlay.layer})`);
  for (const track of resolved.audio.tracks) log(`  audio      ${track.src} from frame ${track.from}${track.volume !== 1 ? ` volume ${track.volume}` : ""}`);
  if (resolved.audio.segmentAudio) log("  audio      segment audio from each kept video segment");
  if (resolved.audio.tracks.length || resolved.audio.segmentAudio) {
    const { loudness } = plan.audio;
    log(`  loudness   ${loudness.normalize ? `normalize after render to ${loudness.targetLufs} LUFS, true peak ${loudness.truePeakDb} dBTP` : "no post-render normalization (plan turns it off)"}`);
  }
  if (unused.length) log(`  note       declared but unused assets (still verified): ${unused.join(", ")}`);
  log(`  faces      ${layoutContext.faces ? `analysis from ${layoutContext.faces.createdAt}${layoutContext.overrides ? ", with manual corrections" : ""}` : "no analysis yet (run: npm run desk:faces -- " + plan.id + ")"}`);
  for (const warning of warnings) log(`  WARN       ${warning.kind}: ${warning.message}`);
  log(`  wrote      ${relative(path.join(outDir, "edit-plan.resolved.json"))}`);
  return { planPath, plan, resolved, warnings, propsPath, assetFiles: Object.values(plan.assets).map(assetFile) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const planArgument = process.argv[2];
  if (!planArgument) {
    console.error("Usage: node scripts/edit-plan.mjs <projects/<id>/edit-plan.json>");
    process.exit(2);
  }
  try {
    await checkPlan(planArgument);
  } catch (error) {
    console.error(error instanceof PlanError ? `FAILED ${planArgument}\n${error.message}` : error);
    process.exit(1);
  }
}

// Validate an edit-plan, then render it with Remotion.
//
//   node scripts/render-plan.mjs projects/bloom10/edit-plan.json out/bloom10/bloom10.mp4
//     [--overwrite] [--concurrency=2] [--frames=0-89] [--browser-executable=<chrome.exe>]
//
// Refuses to render an invalid plan, to write inside public/ (source media),
// or to replace an existing file unless --overwrite is given. When
// audio.loudness.normalize is on (the default), the Remotion output is written
// to <output>.pre-loudnorm.mp4, normalized into <output> (video stream copied),
// the measurements saved to <output>.loudnorm.json, and the intermediate removed.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkPlan } from "./edit-plan.mjs";
import { PlanError } from "../src/engine/load.ts";
import { normalizeLoudness, publicDir, relative, root } from "./lib/media.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((arg) => {
  const [key, ...value] = arg.slice(2).split("=");
  return [key, value.length ? value.join("=") : true];
}));
const [planArgument, outputArgument] = args.filter((arg) => !arg.startsWith("--"));
const known = new Set(["overwrite", "concurrency", "frames", "browser-executable"]);
const unknown = Object.keys(flags).filter((key) => !known.has(key));
if (!planArgument || !outputArgument || unknown.length) {
  console.error(`${unknown.length ? `Unknown option(s): ${unknown.join(", ")}\n` : ""}Usage: node scripts/render-plan.mjs <edit-plan.json> <output.mp4> [--overwrite] [--concurrency=N] [--frames=a-b] [--browser-executable=path]`);
  process.exit(2);
}

const output = path.resolve(root, outputArgument);
const fail = (message) => {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
};
if (path.extname(output).toLowerCase() !== ".mp4") fail("output must be an .mp4 file");
if (!path.relative(publicDir, output).startsWith("..")) fail("output may not be written inside public/, which holds source media");
if (existsSync(output) && !flags.overwrite) fail(`${relative(output)} already exists. Choose a new name, or pass --overwrite if replacing it is intended.`);

let checked;
try {
  checked = await checkPlan(planArgument);
} catch (error) {
  console.error(error instanceof PlanError ? `FAILED ${planArgument}\n${error.message}` : error);
  process.exit(1);
}

const defaultChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = typeof flags["browser-executable"] === "string" ? flags["browser-executable"] : existsSync(defaultChrome) ? defaultChrome : null;
const { encoding } = checked.plan.output;
const { loudness } = checked.plan.audio;
const hasAudio = checked.resolved.audio.tracks.length > 0 || checked.resolved.audio.segmentAudio;
const normalize = loudness.normalize && hasAudio;
const remotionOutput = normalize ? output.replace(/\.mp4$/i, ".pre-loudnorm.mp4") : output;
const remotionArgs = [
  path.join(root, "node_modules/@remotion/cli/remotion-cli.js"),
  "render", "src/index.ts", "EditPlan", remotionOutput,
  `--props=${checked.propsPath}`,
  `--crf=${encoding.crf}`,
  `--x264-preset=${encoding.x264Preset}`,
  `--concurrency=${flags.concurrency ?? 2}`,
  "--disallow-parallel-encoding",
  "--offthreadvideo-cache-size-in-bytes=268435456",
  ...(typeof flags.frames === "string" ? [`--frames=${flags.frames}`] : []),
  ...(browser ? [`--browser-executable=${browser}`] : []),
];

await mkdir(path.dirname(output), { recursive: true });
const logPath = output.replace(/\.mp4$/i, ".render.log");
const log = createWriteStream(logPath);
log.write(`node ${remotionArgs.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}\n\n`);
console.log(`Rendering ${checked.plan.id} -> ${relative(output)} (log: ${relative(logPath)})`);
const child = spawn(process.execPath, remotionArgs, { cwd: root, windowsHide: true });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
const code = await new Promise((resolve) => child.on("close", resolve));
log.end();
if (code !== 0) {
  console.error(`Render failed with exit code ${code}; see ${relative(logPath)}`);
  process.exit(code ?? 1);
}
console.log("EXPORT_STAGE=processing");
if (normalize) {
  console.log(`Normalizing loudness to ${loudness.targetLufs} LUFS / ${loudness.truePeakDb} dBTP (video stream copied)...`);
  const report = await normalizeLoudness(remotionOutput, output, loudness, checked.resolved.durationInFrames / checked.resolved.fps);
  await writeFile(output.replace(/\.mp4$/i, ".loudnorm.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(remotionOutput);
  console.log(`  before ${report.firstPass.input_i} LUFS / ${report.firstPass.input_tp} dBTP -> after ${report.secondPass.output_i} LUFS / ${report.secondPass.output_tp} dBTP (${report.secondPass.normalization_type})`);
} else {
  console.log(hasAudio ? "Loudness normalization off in the plan (audio.loudness.normalize = false)." : "No audio in the plan; nothing to normalize.");
}
console.log(`Rendered ${relative(output)}`);

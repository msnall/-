// Find stills in the project's own footage for a missing asset (e.g. a
// product shot), so nothing has to be reshot when the footage already has it.
//
//   node scripts/find-candidates.mjs bloom10-v2 --sheet [--every=1]
//       -> out/desk-cache/<id>/candidates/sheet-NN.jpg (numbered contact sheets
//          of the preview proxy; numbers are source frames). Claude looks at
//          them and picks frames.
//   node scripts/find-candidates.mjs bloom10-v2 --extract=860 --as=product-front [--crop=x,y,w,h] [--kind=image] [--note=…]
//       -> public/projects/<id>/assets/<asset>-f0860.jpg cut from the ORIGINAL
//          footage at full resolution, recorded as a candidate in assets.json.
//          The editor approves candidates in the asset desk.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { probe, publicDir, relative, root, run, sha256File } from "./lib/media.mjs";
import { projectFile, projectIdFrom, readJson, writeJson } from "./lib/storage.mjs";
import { loadProjectInputs } from "./lib/storyboard-files.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((arg) => {
  const [key, ...value] = arg.slice(2).split("=");
  return [key, value.length ? value.join("=") : true];
}));
const projectArgument = args.find((arg) => !arg.startsWith("--"));

const fontFile = "C\\:/Windows/Fonts/arial.ttf";

async function footageInfo(projectId) {
  const { project, assets } = await loadProjectInputs(projectId);
  const item = assets.items.find((entry) => entry.id === project.footage);
  if (!item?.file) throw new Error(`footage "${project.footage}" has no file in assets.json`);
  const proxies = await readJson(projectFile(projectId, "analysis/proxies.json"), { assets: {} });
  const original = path.join(publicDir, item.file);
  const info = await probe(original);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const [num, den] = video.r_frame_rate.split("/").map(Number);
  return { original, proxy: proxies.assets[item.id] ? path.join(publicDir, proxies.assets[item.id].file) : null, fps: num / den, duration: Number(info.format.duration), width: video.width, height: video.height };
}

async function sheets(projectId, every) {
  const info = await footageInfo(projectId);
  const outDir = path.join(root, "out/desk-cache", projectId, "candidates");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const perSheet = 30;
  for (let sheet = 0; sheet * perSheet * every < info.duration - 1; sheet++) {
    const start = sheet * perSheet * every;
    const output = path.join(outDir, `sheet-${String(sheet + 1).padStart(2, "0")}.jpg`);
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", info.proxy ?? info.original, "-t", String(perSheet * every),
      "-vf", `fps=1/${every},scale=180:320,drawtext=fontfile='${fontFile}':text='%{eif\\:(t+${start})*${info.fps}\\:d}':x=6:y=6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=6x5:padding=4:color=white`,
      "-frames:v", "1", "-q:v", "3", output,
    ]);
    console.log(`sheet ${relative(output)} (source ${start.toFixed(0)}–${Math.min(info.duration, start + perSheet * every).toFixed(0)} s, label = source frame at ${info.fps} fps)`);
  }
}

async function extract(projectId, frame, assetId, { crop, kind = "image", note }) {
  const info = await footageInfo(projectId);
  const dir = path.join(publicDir, "projects", projectId, "assets");
  await mkdir(dir, { recursive: true });
  const name = `${assetId}-f${String(frame).padStart(4, "0")}.jpg`;
  const output = path.join(dir, name);
  // --crop is x,y,w,h; FFmpeg's crop filter takes w:h:x:y.
  const [x, y, w, h] = crop ? crop.split(",").map(Number) : [];
  const filters = crop ? [`crop=${w}:${h}:${x}:${y}`] : [];
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(frame / info.fps), "-i", info.original, "-frames:v", "1", ...(filters.length ? ["-vf", filters.join(",")] : []), "-q:v", "2", output]);
  const file = path.relative(publicDir, output).split(path.sep).join("/");
  const assetsFile = projectFile(projectId, "assets.json");
  const assets = await readJson(assetsFile, { version: 1, items: [], claims: [] });
  let item = assets.items.find((entry) => entry.id === assetId);
  if (!item) {
    item = { id: assetId, kind, status: "missing", neededBy: [], candidates: [] };
    assets.items.push(item);
  }
  item.candidates = [...(item.candidates ?? []).filter((candidate) => candidate.file !== file), { file, frame, ms: Math.round((frame / info.fps) * 1000), ...(note ? { note } : {}) }];
  if (item.status === "missing") item.status = "candidate";
  await writeJson(assetsFile, assets);
  console.log(`candidate ${relative(output)} (sha256 ${(await sha256File(output)).slice(0, 12)}…) recorded for ${assetId}; approve it in the asset desk`);
}

try {
  if (!projectArgument) throw new Error("Usage: node scripts/find-candidates.mjs <project> --sheet [--every=1] | --extract=<frame> --as=<asset-id> [--crop=x,y,w,h] [--kind=image] [--note=…]");
  const projectId = projectIdFrom(projectArgument);
  if (flags.sheet) await sheets(projectId, Number(flags.every ?? 1));
  else if (flags.extract) {
    if (!flags.as) throw new Error("--as=<asset-id> is required");
    await extract(projectId, Number(flags.extract), flags.as, { crop: flags.crop, kind: flags.kind, note: flags.note });
  } else throw new Error("Give --sheet or --extract=<frame>");
} catch (error) {
  console.error(error.message ?? error);
  process.exit(1);
}

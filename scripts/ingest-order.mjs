// Ingest a TikTok One order folder into a VideoAutomation project.
//
//   node scripts/ingest-order.mjs <orderDir> <projectId> [--force]
//
// Reads (never writes) the order folder:
//   03_脚本/script.json, 03_脚本/brief.json    structured script + brand brief
//   04_达人回片/<creator>/*                    creator footage (talk / action)
//   02_官方素材/materials.json + files          screen recordings / brand assets
// (also copies candidates.json / confirm.json when present)
// Writes:
//   public/derived/<id>/<assetId>.mp4           upright, <=1080 wide, 30 fps working copies
//   projects/<id>/ingest.json                   asset manifest (roles, probe data, hashes)
//   projects/<id>/script.json, brief.json       copies of the order's script inputs
// The order folder and public/recordings are never modified.
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probe, publicDir, root, run, sha256File, relative } from "./lib/media.mjs";
import { writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [orderArg, projectId] = args.filter((a) => !a.startsWith("--"));
if (!orderArg || !projectId || !/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
  console.error("Usage: node scripts/ingest-order.mjs <orderDir> <projectId (lowercase, digits, hyphens)> [--force]");
  process.exit(1);
}
const order = path.resolve(orderArg);
const projectDir = path.join(root, "projects", projectId);
const derivedDir = path.join(publicDir, "derived", projectId);
const exists = (file) => stat(file).then(() => true, () => false);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const MEDIA = /\.(mp4|mov|m4v|webm)$/i;

// ---- classification --------------------------------------------------------
// Creator footage role comes from the file name the order folder already uses.
function creatorRole(name) {
  if (/近景|closeup|close-up/i.test(name)) return { kind: "talk", framing: "closeup", slug: "closeup" };
  if (/半身|waist/i.test(name)) {
    const take = name.match(/口播\s*([A-Za-z0-9]+)/)?.[1]?.toLowerCase();
    return { kind: "talk", framing: "waist", slug: `waist${take ? `-${take}` : ""}` };
  }
  if (/动作|action/i.test(name)) return { kind: "action", framing: "action", slug: "action" };
  return { kind: "talk", framing: "unknown", slug: "clip" };
}

async function normalize(src, dest, { keepAudio }) {
  // ffmpeg applies the rotation tag; scale only down, never up; even dimensions.
  const filter = "scale='min(1080,iw)':-2:flags=lanczos,fps=30,format=yuv420p";
  const audio = keepAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"];
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", ...(keepAudio ? ["-map", "0:a:0?"] : []),
    "-vf", filter, "-c:v", "libx264", "-crf", "17", "-preset", "veryfast", ...audio, "-movflags", "+faststart", dest]);
}

async function describe(file) {
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  return {
    width: v.width, height: v.height, durationMs: Math.round(Number(info.format.duration) * 1000),
    fps: Number(v.avg_frame_rate.split("/")[0]) / Number(v.avg_frame_rate.split("/")[1] || 1),
    hasAudio: Boolean(a),
  };
}

// ---- main ------------------------------------------------------------------
await mkdir(projectDir, { recursive: true });
await mkdir(derivedDir, { recursive: true });
const items = [];
const intake = await readJson(path.join(order, "intake.json")).catch(() => ({ files: {} })); // written by the page's drag-in inbox (desk/server/inbox.mjs)
const intakeOf = (...rel) => intake.files?.[rel.join("/")] ?? intake.files?.[rel.join("\\")] ?? null;

// Creator footage
const creatorRoot = path.join(order, "04_达人回片");
const creators = (await readdir(creatorRoot, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory());
let creatorIndex = 0;
for (const dir of creators) {
  creatorIndex += 1;
  const creatorId = `c${creatorIndex}`;
  const creatorName = dir.name.replace(/^达人\d+_?/, "") || dir.name;
  const files = (await readdir(path.join(creatorRoot, dir.name))).filter((f) => MEDIA.test(f)).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  for (const file of files) {
    const role = creatorRole(file);
    let id = `${creatorId}-${role.slug}`;
    for (let n = 2; items.some((x) => x.id === id); n += 1) id = `${creatorId}-${role.slug}-${n}`; // several actions / unnamed clips must not share an id
    items.push({ id, source: path.join(creatorRoot, dir.name, file), originalName: file, group: "creator", creator: { id: creatorId, name: creatorName }, ...role, keepAudio: role.kind === "talk" }); // only the talking clips keep sound; action shots are treated as silent
  }
}

// Brand / screen-recording materials. materials.json carries tags + usage notes.
const materialsDir = path.join(order, "02_官方素材");
const materials = (await exists(path.join(materialsDir, "materials.json"))) ? await readJson(path.join(materialsDir, "materials.json")) : { assets: [] };
for (const m of materials.assets ?? []) {
  const source = path.join(materialsDir, m.file);
  if (!(await exists(source))) continue;
  if (!MEDIA.test(m.file)) {
    items.push({ id: `brand-${m.id}`, source, originalName: m.file, group: "brand", kind: "image", materialId: m.id, tags: m.tags ?? [], usable: m.usable });
    continue;
  }
  items.push({ id: `screen-${m.id}`, source, originalName: m.file, group: "screen", kind: "screen", materialId: m.id, tags: m.tags ?? [], usable: m.usable, keepAudio: false });
}

// Files in 02_官方素材 that materials.json does not describe (a new order has no materials.json): still ingest them,
// as plain official footage; the catalog's AI describer fills in what they show.
const IMAGE = /.(png|jpe?g|webp)$/i;
const known = new Set((materials.assets ?? []).map((m) => m.file));
let extra = 0;
for (const file of (await readdir(materialsDir).catch(() => [])).sort((x, y) => x.localeCompare(y, "zh-CN", { numeric: true }))) {
  if (known.has(file) || !(MEDIA.test(file) || IMAGE.test(file))) continue;
  extra += 1;
  const source = path.join(materialsDir, file);
  if (IMAGE.test(file)) items.push({ id: `brand-o${extra}`, source, originalName: file, group: "brand", kind: "image", materialId: `o${extra}`, tags: [], usable: null, intake: intakeOf("02_官方素材", file) });
  else items.push({ id: `screen-o${extra}`, source, originalName: file, group: "screen", kind: "screen", materialId: `o${extra}`, tags: [], usable: null, keepAudio: false, intake: intakeOf("02_官方素材", file) });
}

const previous = await readFile(path.join(projectDir, "ingest.json"), "utf8").then(JSON.parse, () => null);
const manifest = { version: 1, projectId, order: path.basename(order), ingestedAt: new Date().toISOString(), assets: [] };
for (const item of items) {
  const entry = { id: item.id, group: item.group, kind: item.kind, originalName: item.originalName, ...(item.intake ? { intake: item.intake } : {}) };
  entry.sourceSha256 = await sha256File(item.source);
  if (item.kind === "image") {
    const dest = path.join(derivedDir, `${item.id}${path.extname(item.source).toLowerCase()}`);
    if (force || !(await exists(dest))) await copyFile(item.source, dest);
    Object.assign(entry, { file: relative(dest).replace(/^public\//, ""), tags: item.tags, usable: item.usable });
  } else {
    const dest = path.join(derivedDir, `${item.id}.mp4`);
    if (force || !(await exists(dest))) {
      process.stdout.write(`normalizing ${item.originalName} -> ${item.id}.mp4\n`);
      await normalize(item.source, dest, { keepAudio: item.keepAudio });
    }
    const info = await describe(dest);
    const sourceInfo = await describe(item.source);
    Object.assign(entry, {
      file: relative(dest).replace(/^public\//, ""), sha256: await sha256File(dest), ...info,
      orientation: info.height >= info.width ? "portrait" : "landscape",
      sourceDurationMs: sourceInfo.durationMs, sourceHasAudio: sourceInfo.hasAudio,
    });
    if (item.group === "creator") Object.assign(entry, { creator: item.creator, framing: item.framing });
    else Object.assign(entry, { tags: item.tags, usable: item.usable, materialId: item.materialId });
    if (item.group === "screen" && info.orientation === "portrait" && info.width < 1080) entry.warning = `only ${info.width}x${info.height}; avoid scaling above 100%`;
  }
  const before = previous?.assets?.find((x) => x.id === entry.id && x.sourceSha256 === entry.sourceSha256);
  if (before?.transcript) Object.assign(entry, { speech: before.speech, transcript: before.transcript });
  manifest.assets.push(entry);
}

for (const name of (await readdir(path.join(order, "03_脚本")).catch(() => [])).filter((n) => /\.(txt|md)$/i.test(n))) { // the text the creator was asked to read
  await mkdir(path.join(projectDir, "script-text"), { recursive: true });
  await copyFile(path.join(order, "03_脚本", name), path.join(projectDir, "script-text", name));
}
for (const name of ["script.json", "brief.json", "candidates.json", "confirm.json"]) {
  const src = path.join(order, "03_脚本", name);
  if (await exists(src)) await copyFile(src, path.join(projectDir, name));
}
await writeJson(path.join(projectDir, "ingest.json"), manifest);
console.log(`ingested ${manifest.assets.length} assets -> projects/${projectId}/ingest.json`);
for (const a of manifest.assets) console.log(`  ${a.id.padEnd(22)} ${a.group.padEnd(8)} ${a.width ?? ""}x${a.height ?? ""} ${a.durationMs ? (a.durationMs / 1000).toFixed(1) + "s" : ""} ${a.warning ?? ""}`);

// Compile a v2 cut script into a rendered-ready edit-plan.
//
//   node scripts/compile-cut-script.mjs <projectId> [--file=cut-script.json] [--plan=edit-plan.json] [--force]
//
// 1. Voice master: the beats' voice ranges are cut from the creator clips and joined into one
//    video (public/derived/<id>/voice-master.mp4). Its transcript gets the proofread words with
//    master-timeline times, chunked into caption cues that never cross a beat boundary.
// 2. edit-plan: one segment per beat on the master (the creator keeps talking), b-roll as
//    `video-clip@1` overlays anchored to the beat's segment, captions from the master transcript.
// Nothing is rendered here. The plan is written as revision 0; it never overwrites an existing plan
// without --force (after that, changes go through proposals in the review desk).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { publicDir, root, sha256File } from "./lib/media.mjs";
import { FORBIDDEN } from "./lib/claims.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";
import { transcriptPaths } from "./lib/transcripts.mjs";
import { loadCleanup } from "./lib/beats.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
if (!projectId) { console.error("Usage: node scripts/compile-cut-script.mjs <projectId> [--file=cut-script.json] [--plan=edit-plan.json] [--force]"); process.exit(1); }
const dir = path.join(root, "projects", projectId);
const planFile = path.join(dir, opt("plan", "edit-plan.json"));
const FPS = 30;
const frameMs = 1000 / FPS;
const toFrames = (ms) => Math.round((ms * FPS) / 1000);
const exists = (f) => stat(f).then(() => true, () => false);

const cut = await readJson(path.join(dir, opt("file", "cut-script.json")));
const ingest = await readJson(path.join(dir, "ingest.json"));
const brief = await readJson(path.join(dir, "brief.json"), null);
const assets = new Map(ingest.assets.map((a) => [a.id, a]));
const errors = [];
const hasBrief = await stat(path.join(dir, "brief.json")).then(() => true, () => false);
const warnings = [];

// ---- validate -------------------------------------------------------------
if (cut.schemaVersion !== 2) errors.push("cut script must be schemaVersion 2 (see docs/cut-script.md)");
const beats = cut.beats.map((b) => {
  // a beat is one or more kept pieces of its clip (pieces appear when a voice cleanup took dead air or retakes out)
  const pieces = (b.voice.ranges ?? [[b.voice.startMs, b.voice.endMs]]).map(([from, to]) => { const startFrame = toFrames(from); return { startFrame, frames: toFrames(to) - startFrame }; });
  return { ...b, pieces, startFrame: pieces[0].startFrame, frames: pieces.reduce((s, p) => s + p.frames, 0) };
});
let offset = 0;
for (const b of beats) {
  b.offsetFrames = offset; offset += b.frames;
  const clip = assets.get(b.voice.asset);
  if (!clip?.speech) errors.push(`${b.id}: voice asset ${b.voice.asset} is missing or has no speech`);
  else if (b.voice.endMs > clip.durationMs + 50) errors.push(`${b.id}: voice ends at ${b.voice.endMs}ms but ${clip.id} is ${clip.durationMs}ms`);
  if (b.frames < 6) errors.push(`${b.id}: shorter than 6 frames`);
  // Brand claim rules belong to an order's brief; without brief.json a hit is only a warning (same rule as the director).
  for (const [re, why] of FORBIDDEN) if (re.test(b.text)) (hasBrief ? errors : warnings).push(`${b.id}: forbidden claim (${why}) in "${b.text}"${hasBrief ? "" : " (this order has no brief; check by hand)"}`);
  for (const s of b.broll ?? []) {
    const a = assets.get(s.asset);
    if (!a?.durationMs) { errors.push(`${s.id}: unknown or non-video asset ${s.asset}`); continue; }
    if (s.srcStartMs + s.durationMs > a.durationMs + 50) errors.push(`${s.id}: source range ${s.srcStartMs}-${s.srcStartMs + s.durationMs}ms is past the end of ${a.id} (${a.durationMs}ms)`);
    if (s.atMs + s.durationMs > b.frames * frameMs + 50) errors.push(`${s.id}: ends ${Math.round(s.atMs + s.durationMs - b.frames * frameMs)}ms after beat ${b.id} ends`);
    if (a.group === "creator" && a.speech) warnings.push(`${s.id}: b-roll from a talking clip (${a.id})`);
  }
}
const totalFrames = offset;
// Generated files are named by content, so a new cut script never overwrites what an existing plan version points at.
const digest = (value) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 8);
const masterHash = digest(beats.map((b) => [b.voice.asset, b.pieces.map((p) => [p.startFrame, p.frames])]));
const textHash = digest([masterHash, beats.map((b) => [b.id, b.text, b.voice.wordStart, b.voice.wordEnd])]);
if (errors.length) { console.error(errors.map((e) => `ERROR ${e}`).join("\n")); process.exit(1); }
const existingPlan = (await exists(planFile)) ? await readJson(planFile) : null;
if (existingPlan && (existingPlan.revision ?? 0) > 0 && !args.includes("--discard-edits")) { console.error(`${path.relative(root, planFile)} is at revision ${existingPlan.revision}: it holds edits made in the review desk. Rebuilding would discard them; pass --discard-edits only if that is intended (the old revisions stay in versions/).`); process.exit(1); }
if (existingPlan && !args.includes("--force")) { console.error(`${path.relative(root, planFile)} exists; pass --force to rebuild it from the cut script (a reviewed plan should change through proposals instead).`); process.exit(1); }

// ---- 1. voice master -------------------------------------------------------
const derivedDir = path.join(publicDir, "derived", projectId);
await mkdir(derivedDir, { recursive: true });
const masterFile = path.join(derivedDir, `voice-master-${masterHash}.mp4`);
const clipIds = [...new Set(beats.map((b) => b.voice.asset))];
const filters = [];
const pieceList = beats.flatMap((b) => b.pieces.map((p) => ({ beat: b, ...p })));
pieceList.forEach((p, i) => {
  const k = clipIds.indexOf(p.beat.voice.asset);
  const dur = p.frames / FPS;
  filters.push(`[${k}:v]trim=start_frame=${p.startFrame}:end_frame=${p.startFrame + p.frames},setpts=PTS-STARTPTS,fps=${FPS}[v${i}]`);
  filters.push(`[${k}:a]atrim=start=${(p.startFrame / FPS).toFixed(4)}:end=${((p.startFrame + p.frames) / FPS).toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st=${(dur - 0.008).toFixed(4)}:d=0.008[a${i}]`);
});
filters.push(`${pieceList.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${pieceList.length}:v=1:a=1[v][a]`);
const ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-y", ...clipIds.flatMap((id) => ["-i", path.join(publicDir, assets.get(id).file)]),
  "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "17", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", masterFile];
if (await exists(masterFile)) console.log(`voice master voice-master-${masterHash}.mp4 already built`);
else await new Promise((resolve, reject) => { const p = spawn("ffmpeg", ffmpegArgs, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] }); p.on("error", reject); p.on("close", (c) => c ? reject(new Error(`ffmpeg exited ${c}`)) : resolve()); });

// ---- master transcript ------------------------------------------------------
const cleanup = await loadCleanup(projectId);
const editedWords = {};
for (const id of clipIds) editedWords[id] = await readJson(path.join(publicDir, transcriptPaths(assets.get(id)).edited));
const masterWords = [];
const masterCues = [];
for (const b of beats) {
  const beatStart = Math.round(b.offsetFrames * frameMs), beatEnd = Math.round((b.offsetFrames + b.frames) * frameMs);
  // words of this beat on the master timeline: with pieces, a word moves by what was cut out before it; dropped words disappear
  const clipWords = editedWords[b.voice.asset];
  const timing = b.voice.ranges ? cleanup?.clips?.[b.voice.asset]?.timings : null;
  if (b.voice.ranges && !timing) throw new Error(`${b.id} was cut with a voice cleanup, but projects/${projectId}/cleanup.json is not confirmed (or lost); open 口播清理 again`);
  const dropped = new Set(b.voice.droppedWords ?? []);
  const words = [];
  for (let i = b.voice.wordStart; i <= b.voice.wordEnd; i++) {
    if (dropped.has(i)) continue;
    const [ws, we] = timing ? timing[i] : [clipWords[i].startMs, clipWords[i].endMs];
    let before = 0, mapped = null;
    for (const p of b.pieces) {
      const pa = p.startFrame * frameMs, pb = (p.startFrame + p.frames) * frameMs;
      const mid = (ws + we) / 2;
      if (mid >= pa - 1 && mid <= pb + 1) { mapped = [before + Math.max(ws, pa) - pa, before + Math.min(we, pb) - pa]; break; }
      before += p.frames * frameMs;
    }
    if (!mapped) continue;
    words.push({ text: clipWords[i].text, startMs: Math.min(beatEnd - 2, Math.max(beatStart, Math.round(beatStart + mapped[0]))), endMs: Math.min(beatEnd, Math.max(beatStart + 1, Math.round(beatStart + mapped[1]))), beat: b.id });
  }
  for (let i = 0; i < words.length; i++) if (words[i].endMs <= words[i].startMs) words[i].endMs = words[i].startMs + 1;
  b.firstWord = masterWords.length;
  masterWords.push(...words);
  // caption cues: up to 5 words / 28 chars, preferring breaks after punctuation
  let chunk = [];
  const flush = () => { if (chunk.length) { masterCues.push({ text: chunk.map((w) => w.text).join(" "), startMs: chunk[0].startMs, endMs: chunk.at(-1).endMs }); chunk = []; } };
  words.forEach((w, i) => {
    chunk.push(w);
    const chars = chunk.map((x) => x.text).join(" ").length;
    const next = words[i + 1];
    if (!next || /[.,!?]$/.test(w.text) && chunk.length >= 2 || chunk.length >= 5 || (next && chars + next.text.length + 1 > 28)) flush();
  });
}
await writeJson(path.join(publicDir, "transcripts", `${projectId}-master-${textHash}.json`), masterWords.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })));
await writeJson(path.join(publicDir, "transcripts", `${projectId}-master-${textHash}.cues.json`), masterCues);

// ---- 2. edit-plan -----------------------------------------------------------
const planAssets = { master: { type: "video", path: `derived/${projectId}/voice-master-${masterHash}.mp4`, sha256: await sha256File(masterFile) } };
for (const s of beats.flatMap((b) => b.broll ?? [])) {
  if (planAssets[s.asset]) continue;
  const a = assets.get(s.asset);
  planAssets[s.asset] = { type: "video", path: a.file, sha256: a.sha256 };
}
const segmentId = (b) => b.id;
let talkIndex = 0;
const segments = beats.map((b) => {
  const covered = (b.broll ?? []).some((s) => s.atMs <= 200 && s.durationMs >= b.frames * frameMs - 200);
  const zoom = typeof b.zoom === "number" ? b.zoom : covered ? 1 : (talkIndex++ % 2 ? 1.1 : 1);
  return { id: segmentId(b), asset: "master", sourceStartMs: Math.floor(b.offsetFrames * frameMs), sourceEndMs: Math.ceil((b.offsetFrames + b.frames) * frameMs),
    camera: { zoom, originX: 0.5, originY: 0.38, punchIns: [] } };
});
const overlays = [];
for (const b of beats) for (const s of b.broll ?? []) {
  const a = assets.get(s.asset);
  const native = a.orientation === "portrait" && a.width >= 1080;
  const from = { segment: segmentId(b), edge: "start", offsetMs: Math.round(s.atMs) };
  const durationFrames = toFrames(s.durationMs);
  if (s.layout === "pip") {
    // Picture-in-picture: small window in a corner, the creator stays visible. Native pixels are never upscaled.
    const lower = s.slot?.startsWith("lower");
    const width = Math.min(a.width, a.orientation === "portrait" ? 320 : 560);
    // Top windows keep the clip's shape; lower windows are cropped to at most 330 px tall so they stay below the face.
    const height = Math.min(Math.round((width * a.height) / a.width), lower ? 330 : 1000);
    const margin = 40;
    const x = s.slot?.endsWith("right") ? 918 - 8 - width : margin; // stay left of the TikTok button column (x > 918)
    const y = lower ? 1170 - height : 170;
    overlays.push({ id: s.id, effect: "video-clip@1", from, durationFrames, layer: "below-captions", props: { asset: s.asset, sourceStartMs: s.srcStartMs, x, y, width, height, fit: "cover", borderRadius: 24 } });
    continue;
  }
  if (native) {
    overlays.push({ id: s.id, effect: "video-clip@1", from, durationFrames, layer: "below-captions", props: { asset: s.asset, sourceStartMs: s.srcStartMs, x: 0, y: 0, width: 1080, height: 1920, fit: "cover", pushIn: 1.04 } });
  } else {
    // Too small to fill the frame without upscaling: show it at native size on a dark backdrop (no blur/pixelation).
    const width = Math.min(1080, a.width), height = Math.round((width * a.height) / a.width);
    overlays.push({ id: `${s.id}-bg`, effect: "rect@1", from, durationFrames, layer: "below-captions", props: { x: 0, y: 0, width: 1080, height: 1920, color: "#101820" } });
    overlays.push({ id: s.id, effect: "video-clip@1", from, durationFrames, layer: "below-captions", props: { asset: s.asset, sourceStartMs: s.srcStartMs, x: Math.round((1080 - width) / 2), y: Math.round((1920 - height) / 2) - 120, width, height, fit: "contain", borderRadius: 28 } });
    warnings.push(`${s.id}: ${a.id} is ${a.width}x${a.height}; shown at native size on a backdrop`);
  }
}
if (cut.logo) {
  const b = beats.find((x) => x.id === cut.logo.beat);
  const logoAsset = ingest.assets.find((x) => x.kind === "image" && x.group === "brand");
  if (!b || !logoAsset) errors.push("logo: beat or brand logo asset not found");
  else {
    planAssets["brand-logo"] = { type: "image", path: logoAsset.file };
    overlays.push({ id: "brand-logo", effect: "image-card@1", from: { segment: segmentId(b), edge: "start", offsetMs: Math.round(cut.logo.atMs ?? 0) }, until: { fromEnd: 0 }, layer: "below-captions",
      props: { asset: "brand-logo", x: 40, y: 170, width: 150, height: 150, fit: "contain", borderRadius: 28, enter: { type: "pop", frames: 8 }, exit: { type: "none", frames: 0 } } });
  }
}
// sound effects, per beat: auto = a whoosh under each cutaway and a pop at the logo; none; or one fixed kind at each cutaway (or the beat start)
const sfxList = [];
for (const b of beats) {
  const mode = b.sfx ?? "auto";
  if (mode === "none") continue;
  const shots = b.broll ?? [];
  if (mode === "auto") shots.forEach((s) => sfxList.push({ atFrame: Math.max(0, b.offsetFrames + toFrames(s.atMs) - 1), kind: "whoosh" }));
  else if (shots.length) shots.forEach((s) => sfxList.push({ atFrame: b.offsetFrames + toFrames(s.atMs), kind: mode }));
  else sfxList.push({ atFrame: b.offsetFrames, kind: mode });
  if (cut.logo?.beat === b.id && mode === "auto") sfxList.push({ atFrame: b.offsetFrames + toFrames(cut.logo.atMs ?? 0), kind: "pop" });
}
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const emphasis = (cut.emphasis ?? []).map((e) => {
  const b = beats.find((x) => x.id === e.beat);
  const rel = masterWords.slice(b.firstWord).findIndex((w) => w.beat === b.id && norm(w.text) === norm(e.word));
  if (rel < 0) { errors.push(`emphasis: "${e.word}" is not in beat ${e.beat}`); return null; }
  return { word: b.firstWord + rel, expect: masterWords[b.firstWord + rel].text, color: e.color ?? "#2ee6c8", scale: 1.12 };
}).filter(Boolean);
if (errors.length) { console.error(errors.map((e) => `ERROR ${e}`).join("\n")); process.exit(1); }

const plan = {
  schemaVersion: 1, id: projectId, revision: 0,
  meta: { source: "cut-script.json", scriptId: cut.scriptId, builtAt: new Date().toISOString(), brief: brief?.orderId ?? null, sfx: sfxList.sort((x, y) => x.atFrame - y.atFrame), note: "First cut r0 compiled from the cut script. Draft for review; not a delivered video." },
  output: { width: 1080, height: 1920, fps: FPS, encoding: { crf: 18, x264Preset: "veryfast" } },
  theme: { background: "#101820", textColor: "#ffffff", fontFamily: "\"BloomInter\", sans-serif", fonts: [{ family: "BloomInter", src: "fonts/Inter-700.woff2", weight: 700, style: "normal" }] },
  assets: planAssets,
  transcript: { asset: "master", words: `transcripts/${projectId}-master-${textHash}.json`, cues: `transcripts/${projectId}-master-${textHash}.cues.json` },
  segments,
  layout: { footage: { x: 0, y: 0, width: 1080, height: 1920, borderRadius: 0, fit: "cover" } },
  captions: { box: { x: 70, y: 1180, width: 840, height: 200 }, fontSize: 72, lineHeight: 86, fontWeight: 700, color: "#ffffff", activeColor: "#ffd23f", background: "#000000a6",
    wordGap: 16, maxLines: 2, singleLineMaxChars: 18, balanceWeight: 0.2, textTransform: "uppercase", emphasis },
  overlays,
  audio: { segmentAudio: true, tracks: [], loudness: { normalize: true, targetLufs: -16, truePeakDb: -1.5, lra: 11 } },
  qc: { loudnessLufs: -16, loudnessToleranceLu: 1.5, maxTruePeakDb: -1 },
};
await writeJson(planFile, plan);
console.log(`master ${(totalFrames / FPS).toFixed(1)} s, ${beats.length} segments, ${overlays.length} overlays, ${masterCues.length} caption cues -> ${path.relative(root, planFile)}`);
warnings.forEach((w) => console.log(`warning ${w}`));

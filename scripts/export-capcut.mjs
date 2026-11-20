// Export an edit-plan as a 剪映 (JianYing) draft: every cut, caption, cutaway, keyframe and sound effect already placed,
// so the editor only fine-tunes and exports inside 剪映.
//
//   node scripts/export-capcut.mjs <projectId> [--plan=edit-plan.json] [--name=<draft name>] [--install[=<drafts folder>]]
//
// 1. validates the plan like plan:check and reads the resolved timeline (every time in output frames);
// 2. writes a timeline spec (projects/<id>/exports/capcut/<name>.spec.json, in 剪映 units);
// 3. runs scripts/capcut/build_draft.py with the project-local Python (tools/python, pyJianYingDraft pinned in
//    requirements-capcut.txt) to create projects/<id>/exports/capcut/<name>/;
// 4. with --install, copies that folder into 剪映's draft folder (auto-detected from root_meta_info.json).
// Media is referenced by its path in this repo (not copied); keep the files where they are.
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePlan } from "./edit-plan.mjs";
import { fillMeta, installDraft, jianyingDraftRoot } from "./lib/capcut.mjs";
import { probe, publicDir, root, run } from "./lib/media.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => { const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`)); return hit === undefined ? fallback : hit.includes("=") ? hit.split("=").slice(1).join("=") : true; };
if (!projectId) { console.error("Usage: node scripts/export-capcut.mjs <projectId> [--plan=edit-plan.json] [--name=<draft name>] [--install[=<drafts folder>]]"); process.exit(1); }

const exists = (f) => stat(f).then(() => true, () => false);
const python = path.join(root, "tools", "python", "python.exe");
if (!(await exists(python))) { console.error("Project Python not found (tools/python). See docs/capcut-export.md for the one-time setup."); process.exit(2); }

// ---- plan -> resolved timeline ----------------------------------------------------------------------------------
const planFile = path.join(root, "projects", projectId, opt("plan", "edit-plan.json"));
const raw = JSON.parse(await readFile(planFile, "utf8"));
const { plan, resolved } = await validatePlan(raw);
const { width: W, height: H, fps: FPS } = resolved;
const us = (frames) => Math.round((frames * 1e6) / FPS);
const msToUs = (ms) => Math.round(ms * 1000);
// start and length of a frame range; the length is the difference of two rounded ends so neighbours never overlap by a microsecond
const span = (fromFrame, frames) => ({ startUs: us(fromFrame), durUs: us(fromFrame + frames) - us(fromFrame) });
const abs = (rel) => path.join(publicDir, rel);
const skipped = [];

const dims = new Map();
const natural = async (file) => {
  if (!dims.has(file)) {
    const info = await probe(file);
    const v = info.streams.find((s) => s.codec_type === "video");
    dims.set(file, { w: v.width, h: v.height });
  }
  return dims.get(file);
};
// Where a picture of natural size n shows when it is drawn inside box b (px, canvas coordinates), in 剪映's units:
// 剪映 first fits the clip inside the canvas (scale 1 = that size), positions are in half canvas widths/heights from the
// centre, y up. fit "contain" keeps the whole picture inside the box, "cover" fills it (the overflow is not cropped).
const place = (n, box, fit = "contain") => {
  const base = Math.min(W / n.w, H / n.h);
  const [fw, fh] = [n.w * base, n.h * base];
  const k = fit === "cover" ? Math.max(box.width / n.w, box.height / n.h) : Math.min(box.width / n.w, box.height / n.h);
  const [dw, dh] = [n.w * k, n.h * k];
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  return { scaleX: dw / fw, scaleY: dh / fh, x: (cx - W / 2) / (W / 2), y: -(cy - H / 2) / (H / 2) };
};

// ---- helper media made once: a solid colour picture and two synthetic sound effects ------------------------
const sfxDir = path.join(root, "library", "sfx");
await mkdir(sfxDir, { recursive: true });
const ffmpeg = (a) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const sfx = { whoosh: path.join(sfxDir, "whoosh.wav"), pop: path.join(sfxDir, "pop.wav") };
if (!(await exists(sfx.whoosh))) await ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=0.45:c=pink:a=0.6", "-af", "highpass=f=250,lowpass=f=7000,afade=t=in:d=0.16,afade=t=out:st=0.18:d=0.27,volume=0.9", sfx.whoosh]);
if (!(await exists(sfx.pop))) await ffmpeg(["-f", "lavfi", "-i", "sine=f=700:d=0.14", "-af", "afade=t=out:st=0.01:d=0.13,volume=0.9", sfx.pop]);
const colorPng = async (hex) => {
  const file = path.join(root, "out", "scratch", `solid-${hex.replace("#", "")}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  if (!(await exists(file))) await ffmpeg(["-f", "lavfi", "-i", `color=c=${hex}:s=64x64:d=1`, "-frames:v", "1", file]);
  return file;
};

// ---- lanes (tracks), bottom to top ----------------------------------------------------------------------------------
const lanes = [];
const addLane = (kind, name, segments) => { if (segments.length) lanes.push({ kind, name, segments }); };

// main footage: one segment per plan segment, with the segment's camera zoom as scale + the punch-ins as keyframes
const main = [];
for (const seg of resolved.footage.segments) {
  if (seg.source.type !== "video") { skipped.push(`segment ${seg.id}: image sequences cannot be exported`); continue; }
  const file = abs(seg.source.src);
  const n = await natural(file);
  const z = seg.camera.zoom;
  const base = place(n, resolved.footage, resolved.footage.fit === "contain" ? "contain" : "cover");
  // zoom about the camera origin: the point at the origin stays where it is
  const [ox, oy] = [seg.camera.originX * W, seg.camera.originY * H];
  const dx = (z - 1) * (W / 2 - ox), dy = (z - 1) * (H / 2 - oy);
  const keyframes = [];
  for (const p of seg.camera.punchIns) {
    const t0 = us(p.from), t1 = us(p.from + p.rampFrames), t2 = us(p.from + p.durationInFrames - p.rampFrames), t3 = us(p.from + p.durationInFrames);
    keyframes.push({ tUs: t0, value: 1 }, { tUs: t1, value: p.zoom }, { tUs: t2, value: p.zoom }, { tUs: t3, value: 1 });
  }
  main.push({ file, srcStartUs: msToUs(seg.sourceStartMs), ...span(seg.from, seg.durationInFrames), volume: 1,
    clip: { scaleX: base.scaleX * z, scaleY: base.scaleY * z, x: base.x + dx / (W / 2), y: base.y - dy / (H / 2) }, scaleKeyframes: keyframes });
}
addLane("video", "口播", main);

// overlays: backdrops (rect), cutaways/picture-in-picture (video-clip), logo and stills (image-card)
const backdrops = [], clips = [], stills = [], cards = [];
const sounds = [];
for (const o of resolved.overlays) {
  const { startUs, durUs } = span(o.from, o.durationInFrames);
  const p = o.props;
  if (o.effect === "rect@1") {
    const file = await colorPng(p.color.slice(0, 7));
    backdrops.push({ file, startUs, durUs, clip: { ...place({ w: 64, h: 64 }, p, "cover"), alpha: p.opacity ?? 1 } });
  } else if (o.effect === "video-clip@1") {
    const file = abs(resolved.assets[p.asset].path);
    const n = await natural(file);
    const box = { x: p.x, y: p.y, width: p.width, height: p.height };
    const kf = p.pushIn && p.pushIn !== 1 ? [{ tUs: 0, value: 1 }, { tUs: durUs, value: p.pushIn }] : [];
    clips.push({ file, srcStartUs: msToUs(p.sourceStartMs), startUs, durUs, volume: 0, clip: place(n, box, p.fit === "cover" ? "cover" : "contain"), scaleKeyframes: kf });
    sounds.push({ kind: "whoosh", atUs: Math.max(0, startUs - 40000) });
  } else if (o.effect === "image-card@1") {
    const file = abs(resolved.assets[p.asset].path);
    const n = await natural(file);
    const pad = p.padding ?? 0;
    const box = { x: p.x + pad, y: p.y + pad, width: p.width - 2 * pad, height: p.height - 2 * pad };
    (p.asset.includes("logo") ? stills : cards).push({ file, startUs, durUs, clip: place(n, box, "contain") });
    if (p.asset.includes("logo")) sounds.push({ kind: "pop", atUs: startUs });
  } else skipped.push(`overlay ${o.id}: ${o.effect} has no 剪映 equivalent yet`);
}
// segments that overlap in time cannot share a track: first-fit into as many lanes as needed
const pack = (segments, name, kind = "video") => {
  const rows = [];
  for (const s of segments.sort((a, b) => a.startUs - b.startUs)) {
    const row = rows.find((r) => r.at(-1).startUs + r.at(-1).durUs <= s.startUs);
    if (row) row.push(s); else rows.push([s]);
  }
  rows.forEach((row, i) => addLane(kind, rows.length > 1 ? `${name} ${i + 1}` : name, row));
};
pack(backdrops, "底色");
pack(clips, "插画");
pack(cards, "图片");
pack(stills, "品牌图标");

// captions: one text segment per cue, styled like the plan's caption box
if (resolved.captions) {
  const c = resolved.captions;
  const upper = c.textTransform === "uppercase";
  const centre = { x: c.box.x + c.box.width / 2, y: c.box.y + c.box.height / 2 };
  const background = c.background ? { color: `#${c.background.slice(1, 7)}`, alpha: c.background.length === 9 ? parseInt(c.background.slice(7, 9), 16) / 255 : 1 } : null;
  const text = c.cues.map((cue) => {
    const words = cue.lines.flat().map((w) => w.text).join(" ");
    return { text: upper ? words.toUpperCase() : words, ...span(cue.from, cue.to - cue.from),
      style: { size: Number((c.fontSize / 9).toFixed(1)), bold: c.fontWeight >= 600, color: c.color, maxLineWidth: Math.min(0.9, c.box.width / W) },
      background, x: (centre.x - W / 2) / (W / 2), y: -(centre.y - H / 2) / (H / 2) };
  });
  addLane("text", "字幕", text);
  if (c.cues.some((cue) => cue.lines.flat().some((w) => w.color))) skipped.push("字幕里单个词的强调色（剪映里请手动选词上色）");
}
// sound effects: a whoosh under every cutaway start, a pop when the logo appears
// the cut script decides where sounds go (per beat: auto / none / whoosh / pop); older plans fall back to the rule above
const planned = Array.isArray(plan.meta?.sfx) ? plan.meta.sfx.map((x) => ({ kind: x.kind, atUs: us(x.atFrame) })) : null;
if (planned) sounds.length = 0, sounds.push(...planned);
addLane("audio", "音效", sounds.sort((a, b) => a.atUs - b.atUs).map((s) => ({ file: sfx[s.kind], startUs: s.atUs, durUs: s.kind === "whoosh" ? 450000 : 140000, volume: s.kind === "whoosh" ? 0.5 : 0.6 })));

// ---- write spec, build the draft --------------------------------------------------------------------------------
const revision = plan.revision ?? 0;
const name = String(opt("name", `${projectId} r${revision}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || `${projectId} r${revision}`;
const outRoot = path.join(root, "projects", projectId, "exports", "capcut");
await mkdir(outRoot, { recursive: true });
const specFile = path.join(outRoot, `${name}.spec.json`);
await writeJson(specFile, { name, canvas: { width: W, height: H, fps: FPS }, lanes, skipped });

// A failure must print as one readable line (the page shows the last lines of stderr), not as a Node stack trace.
const fail = (message) => { console.error(`导出剪映草稿失败：${message}`); process.exit(5); };
const result = await new Promise((resolve, reject) => {
  const child = spawn(python, [path.join(root, "scripts", "capcut", "build_draft.py"), specFile, outRoot], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").slice(-6).join("\n") || `python exited ${code}`))));
}).catch((error) => fail(error.message));
const summary = JSON.parse(result.split("\n").find((l) => l.startsWith("SUMMARY ")).slice(8));
const draftDir = path.join(outRoot, name);
const firstFile = lanes[0]?.segments[0]?.file;
if (firstFile) await ffmpeg(["-ss", "1", "-i", firstFile, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", path.join(draftDir, "draft_cover.jpg")]).catch(() => {});
await fillMeta(draftDir, name, outRoot, summary.durationUs);
console.log(`draft: ${draftDir}`);
for (const t of summary.tracks) console.log(`  ${t.kind.padEnd(5)} ${t.name.padEnd(10)} ${t.segments} segment(s)`);
skipped.forEach((s) => console.log(`  not exported: ${s}`));
await writeFile(path.join(outRoot, `${name}.summary.json`), JSON.stringify({ ...summary, skipped, planRevision: revision, builtAt: new Date().toISOString() }, null, 2) + "\n");

if (opt("install", false)) {
  const target = typeof opt("install") === "string" ? opt("install") : await jianyingDraftRoot();
  if (!target) { console.error("Could not find 剪映's draft folder; pass --install=<folder>"); process.exit(3); }
  let dest;
  try { dest = await installDraft(draftDir, name, target, summary.durationUs); } catch (error) { console.error(error.message); process.exit(4); }
  console.log(`installed: ${dest}`);
}

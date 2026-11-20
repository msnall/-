// Structural check of a generated 剪映 draft (no 剪映 needed): the JSON loads, every segment points at a material that
// exists, media files exist, nothing overlaps on a track, source ranges fit the material, and the top-level layout
// matches a real draft written by the installed 剪映 (compared when one is found).
//
//   node scripts/check-capcut-draft.mjs <draft folder> [--reference=<a real draft's draft_content.json>]
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) { console.error("Usage: node scripts/check-capcut-draft.mjs <draft folder> [--reference=<draft_content.json>]"); process.exit(1); }
const exists = (f) => stat(f).then(() => true, () => false);
const readJson = async (f) => JSON.parse((await readFile(f, "utf8")).replace(/^﻿/, ""));

const problems = [];
const notes = [];
const draft = await readJson(path.join(dir, "draft_content.json"));
const meta = await readJson(path.join(dir, "draft_meta_info.json")).catch(() => null);
if (!meta) problems.push("draft_meta_info.json is missing or not JSON");

// materials by id
const materials = new Map();
for (const [kind, list] of Object.entries(draft.materials)) if (Array.isArray(list)) for (const m of list) if (m?.id) materials.set(m.id, { kind, m });

let segments = 0;
let danglingText = 0;
for (const track of draft.tracks) {
  let end = -1;
  for (const seg of [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start)) {
    segments++;
    const { start, duration } = seg.target_timerange;
    if (start < end) problems.push(`track "${track.name}": segments overlap at ${start}µs`);
    end = start + duration;
    if (duration <= 0) problems.push(`track "${track.name}": empty segment at ${start}µs`);
    const main = materials.get(seg.material_id);
    if (!main) { problems.push(`track "${track.name}": segment points at unknown material ${seg.material_id}`); continue; }
    // pyJianYingDraft gives every text segment a speed reference without a speed material; 剪映 ignores it, so it is only counted.
    for (const ref of seg.extra_material_refs ?? []) if (!materials.has(ref)) { if (track.type === "text") danglingText++; else problems.push(`track "${track.name}": extra material ${ref} missing`); }
    if (main.m.path && !(await exists(main.m.path))) problems.push(`media file not found: ${main.m.path}`);
    if (["videos", "audios"].includes(main.kind) && main.m.duration && seg.source_timerange && seg.source_timerange.start + seg.source_timerange.duration > main.m.duration + 1000) problems.push(`track "${track.name}": source range leaves ${path.basename(main.m.path)} (${main.m.duration}µs)`);
  }
}
if (danglingText) notes.push(`${danglingText} text segments carry the library's usual unused speed reference (harmless)`);
const total = Math.max(0, ...draft.tracks.flatMap((t) => t.segments.map((s) => s.target_timerange.start + s.target_timerange.duration)));
if (draft.duration !== total) problems.push(`draft duration ${draft.duration} is not the end of the last segment ${total}`);
notes.push(`canvas ${draft.canvas_config.width}x${draft.canvas_config.height} @ ${draft.fps} fps, ${(total / 1e6).toFixed(2)} s, ${draft.tracks.length} tracks, ${segments} segments, ${materials.size} materials`);

// compare with a real draft made by this machine's 剪映
const refArg = args.find((a) => a.startsWith("--reference="))?.slice(12);
let reference = refArg;
if (!reference) {
  const store = path.join(process.env.LOCALAPPDATA ?? "", "JianyingPro", "User Data", "Projects", "com.lveditor.draft", "root_meta_info.json");
  const info = await readJson(store).catch(() => null);
  const pick = info?.all_draft_store?.find((d) => d.draft_json_file);
  if (pick) reference = pick.draft_json_file;
}
if (reference && (await exists(reference))) {
  const real = await readJson(reference).catch(() => null);
  if (real) {
    const missing = Object.keys(real).filter((k) => !(k in draft)), extra = Object.keys(draft).filter((k) => !(k in real));
    notes.push(`top-level keys: ${missing.length ? `missing vs the real draft: ${missing.join(", ")}` : "same as the real draft"}${extra.length ? `; extra: ${extra.join(", ")}` : ""}`);
    notes.push(`version fields: this draft ${draft.version}/${draft.new_version}   real draft ${real.version}/${real.new_version}`);
    const lacking = Object.keys(real.materials).filter((k) => !(k in draft.materials));
    if (lacking.length) notes.push(`material lists a real draft has and this one lacks: ${lacking.join(", ")}`);
  }
} else notes.push("no real 剪映 draft found to compare with");

console.log(notes.join("\n"));
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log("OK: structure is consistent");

// Detect dead air, fillers, stutters and retakes in every creator clip -> projects/<id>/cleanup.json
//
//   node scripts/cleanup-voice.mjs <projectId> [--review]
//
// --review  also asks the model (「API 设置」) for slips and retakes the rules cannot see; its flags are added as
//           suggestions (source "model", decision "delete") that the editor can flip like any other.
// Decisions the editor already made survive a re-run (an edit that overlaps an earlier one of the same type keeps its decision),
// and a confirmed file is reopened (confirmedAt cleared) because the cuts may have changed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readApiSettings } from "../desk/server/settings.mjs";
import { publicDir, root } from "./lib/media.mjs";
import { DEFAULTS, detectEdits, dropNoiseStretches, detectSilences, retimeWords, reviewWithModel, speechSegments } from "./lib/cleanup.mjs";
import { transcriptPaths } from "./lib/transcripts.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
if (!projectId) { console.error("Usage: node scripts/cleanup-voice.mjs <projectId> [--review]"); process.exit(1); }
const dir = path.join(root, "projects", projectId);
const file = path.join(dir, "cleanup.json");
const ingest = await readJson(path.join(dir, "ingest.json"));
const previous = await readJson(file, null);

// The proofread (.edited) transcript is what everything downstream reads. If nobody changed a word it does not exist yet: write it (identical to the machine transcript) first.
execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/sync-transcripts.mjs", projectId], { cwd: root, stdio: "inherit" });

const clips = {};
const forReview = [];
for (const clip of ingest.assets.filter((a) => a.group === "creator" && a.speech && a.transcript?.words)) {
  const words = await readJson(path.join(publicDir, transcriptPaths(clip).edited));
  const silences = await detectSilences(path.join(publicDir, clip.file), clip.durationMs);
  const segments = dropNoiseStretches(speechSegments(silences, clip.durationMs), words);
  const timings = retimeWords(words, segments);
  let edits = detectEdits({ words, timings, segments, durationMs: clip.durationMs });
  const old = previous?.clips?.[clip.id];
  if (old) {
    // keep the editor's decisions, and keep earlier model/user edits that the rules would not recreate
    edits = edits.map((e) => { const hit = old.edits.find((o) => o.type === e.type && o.source === "auto" && o.fromMs < e.toMs && e.fromMs < o.toMs); return hit ? { ...e, decision: hit.decision } : e; });
    for (const o of old.edits) if (o.source !== "auto" && !edits.some((e) => e.fromMs < o.toMs && o.fromMs < e.toMs)) edits.push(o);
    edits.sort((x, y) => x.fromMs - y.fromMs);
    edits.forEach((e, i) => { e.id = `e${i + 1}`; });
  }
  clips[clip.id] = { durationMs: clip.durationMs, segments, timings, edits };
  forReview.push({ id: clip.id, words });
}

let model = previous?.model ?? null;
if (args.includes("--review")) {
  const settings = await readApiSettings();
  if (!settings.apiKey) { console.error("No API key saved (设置 → API 设置); skipped the model review."); process.exit(1); }
  const flags = await reviewWithModel(forReview, settings);
  for (const f of flags) {
    const c = clips[f.clip];
    const from = c.timings[f.fromWord][0] - 20, to = c.timings[f.toWord][1] + 20;
    if (c.edits.some((e) => e.fromMs < to && from < e.toMs && ["retake", "slip", "stutter"].includes(e.type))) continue;
    c.edits.push({ id: "", type: f.type, fromMs: Math.max(0, from), toMs: Math.min(c.durationMs, to), reason: f.reason || (f.type === "retake" ? "模型认为这里是重说" : "模型认为这里说错了"), source: "model", decision: "delete", wordFrom: f.fromWord, wordTo: f.toWord });
    model = f.model;
  }
  for (const c of Object.values(clips)) { c.edits.sort((x, y) => x.fromMs - y.fromMs); c.edits.forEach((e, i) => { e.id = `e${i + 1}`; }); }
  console.log(`model review: ${flags.length} flag(s)`);
}

await writeJson(file, { version: 1, projectId, createdAt: new Date().toISOString(), params: DEFAULTS, model, confirmedAt: null, clips });
for (const [id, c] of Object.entries(clips)) {
  console.log(`${id}: ${c.segments.length} speech stretches, ${c.edits.length} edit(s)`);
  for (const e of c.edits) console.log(`   ${e.type.padEnd(7)} ${(e.fromMs / 1000).toFixed(2)}–${(e.toMs / 1000).toFixed(2)}s  ${e.reason}`);
}

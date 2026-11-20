// Seed a cut script from the creators' own (proofread) transcripts.
//
//   node scripts/cut-from-transcripts.mjs <projectId> [--split=<clipId>:<wordIndex>,<wordIndex>;<clipId>:...] [--out=cut-script.json]
//
// One beat per line of corrected text (plus --split points inside a long line); see scripts/lib/beats.mjs.
// B-roll and emphasis are added afterwards (by hand or by scripts/auto-director.mjs); this only writes the
// voice side. It refuses to overwrite a non-draft file.
import { stat } from "node:fs/promises";
import path from "node:path";
import { root } from "./lib/media.mjs";
import { FPS, beatLengthMs, seedBeats } from "./lib/beats.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
if (!projectId) { console.error("Usage: node scripts/cut-from-transcripts.mjs <projectId> [--split=clip:idx,idx;clip:idx] [--out=cut-script.json]"); process.exit(1); }
const outFile = path.join(root, "projects", projectId, opt("out", "cut-script.json"));
const splits = Object.fromEntries((opt("split", "") || "").split(";").filter(Boolean).map((s) => { const [clip, list] = s.split(":"); return [clip, list.split(",").map(Number)]; }));
if ((await stat(outFile).catch(() => null)) && (await readJson(outFile)).status !== "draft") { console.error(`${path.basename(outFile)} is not a draft; refusing to overwrite`); process.exit(1); }
const beats = await seedBeats(projectId, splits);
await writeJson(outFile, { schemaVersion: 2, projectId, scriptId: "creator", status: "draft", builtAt: new Date().toISOString(), fps: FPS,
  note: "Beats come from the creators' proofread transcripts. Add `broll` shots per beat; see docs/cut-script.md (v2).", beats });
console.log(`${path.relative(root, outFile)}: ${beats.length} beats, ${(beats.reduce((s, b) => s + beatLengthMs(b), 0) / 1000).toFixed(1)} s of voice`);
for (const b of beats) console.log(`${b.id} ${b.voice.asset} ${b.voice.startMs.toFixed(0)}-${b.voice.endMs.toFixed(0)}ms  ${b.text}`);

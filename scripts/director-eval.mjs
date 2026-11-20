// Did the director get better? (方案 v1.2, sections G and H8)
//
//   node scripts/director-eval.mjs <projectId> [<projectId> …]
//
// Per project it prints, and appends to projects/<id>/analysis/director-metrics.json:
//   - first-pass rate and mean attempts of the three plans (from analysis/director-log.<slot>.json)
//   - pairwise zoom sameness and b-roll overlap of the three plans
//   - H8: how much the editor changed the chosen plan in 精修 — the draft the live edit-plan came from (meta in versions) against the live
//     edit-plan, counted separately for shots, zoom and emphasis. Needs the draft that was applied (director-run.json -> applied.variant).
import path from "node:path";
import { root } from "./lib/media.mjs";
import { similarity } from "./lib/plan-similarity.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length) { console.error("Usage: node scripts/director-eval.mjs <projectId> [<projectId> …]"); process.exit(1); }
const SLOTS = ["a", "b", "c"];

const shotKey = (o) => `${o.id}|${o.props?.asset}|${o.from?.segment}|${o.from?.offsetMs}|${o.durationFrames}|${o.props?.x}|${o.props?.y}|${o.props?.width}|${o.props?.height}`;
const isShot = (o) => o.effect === "video-clip@1";
const countDiff = (a, b) => { const A = new Set(a), B = new Set(b); return [...A].filter((x) => !B.has(x)).length + [...B].filter((x) => !A.has(x)).length; };

for (const id of ids) {
  const dir = path.join(root, "projects", id);
  const out = { id, at: new Date().toISOString() };
  const cuts = {};
  const attempts = [];
  for (const slot of SLOTS) {
    const cut = await readJson(path.join(dir, `cut-script.${slot}.json`), null);
    if (cut?.beats) cuts[slot] = cut;
    const log = await readJson(path.join(dir, "analysis", `director-log.${slot}.json`), null);
    if (log) attempts.push(log.attempts?.length ?? 1);
  }
  if (attempts.length) Object.assign(out, { plans: attempts.length, firstPassRate: Number((attempts.filter((n) => n === 1).length / attempts.length).toFixed(2)), meanAttempts: Number((attempts.reduce((t, n) => t + n, 0) / attempts.length).toFixed(2)) });
  const slots = Object.keys(cuts);
  out.pairs = [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const s = similarity(cuts[slots[i]], cuts[slots[j]]);
    out.pairs.push({ pair: `${slots[i]}/${slots[j]}`, sameZoom: Number(s.sameZoom.toFixed(2)), brollOverlap: Number(s.overlap.toFixed(2)), sameHook: s.sameHook });
  }
  // H8: what the editor changed after choosing
  const run = await readJson(path.join(dir, "director-run.json"), null);
  const variant = run?.applied?.variant;
  const live = await readJson(path.join(dir, "edit-plan.json"), null);
  const draft = variant ? await readJson(path.join(dir, `edit-plan.draft.${variant}.json`), null) : null;
  if (draft && live) {
    const zoomOf = (p) => p.segments.map((s) => `${s.id}:${s.camera?.zoom ?? 1}`);
    const emphOf = (p) => (p.captions?.emphasis ?? []).map((e) => `${e.word}|${e.color ?? ""}`);
    out.editorChanges = {
      chosen: variant, appliedRevision: run.applied.revision, liveRevision: live.revision ?? 0,
      shots: countDiff(draft.overlays.filter(isShot).map(shotKey), live.overlays.filter(isShot).map(shotKey)),
      zoom: countDiff(zoomOf(draft), zoomOf(live)),
      emphasis: countDiff(emphOf(draft), emphOf(live)),
    };
  }
  const file = path.join(dir, "analysis", "director-metrics.json");
  const history = await readJson(file, { runs: [] });
  history.runs.push(out);
  await writeJson(file, history);
  console.log(JSON.stringify(out, null, 1));
}

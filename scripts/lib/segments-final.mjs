// L4: what the editor did with the AI's plan. After a video is exported (or a 剪映 draft built from the live plan), every beat of the final
// plan becomes a library segment: "human_edited" when the editor changed it in 精修, "ai_accepted" when it is still what the AI proposed.
// The segments replace the project's earlier ones, so exporting twice does not pile up copies.
import path from "node:path";
import { beatLengthMs } from "./beats.mjs";
import { zoomIdOf } from "./effects.mjs";
import { root } from "./media.mjs";
import { heuristicLabel, replaceSegments } from "./segments.mjs";
import { readJson } from "./storage.mjs";

const END_CARD = /结尾|end[- ]?card|下载引导|品牌结尾|download/i;
const nearestZoom = (scale) => zoomIdOf(scale) ?? (scale >= 1.175 ? "z120" : scale >= 1.125 ? "z115" : scale >= 1.05 ? "z110" : "z100");
const shotSig = (o) => `${o.props?.asset}|${o.from?.offsetMs}|${o.durationFrames}|${o.props?.x}|${o.props?.y}|${o.props?.width}|${o.props?.height}`;

export async function recordFinal(projectId) {
  const dir = path.join(root, "projects", projectId);
  const live = await readJson(path.join(dir, "edit-plan.json"), null);
  if (!live) return { skipped: "no live plan" };
  // the snapshot of the AI's plan made when the plan was put into 精修; older projects fall back to the current draft of the applied variant
  let ai = live.meta?.aiPlan ?? null;
  if (!ai) {
    const run = await readJson(path.join(dir, "director-run.json"), null);
    const variant = run?.applied?.variant;
    const draft = variant ? await readJson(path.join(dir, `edit-plan.draft.${variant}.json`), null) : null;
    const cut = variant ? await readJson(path.join(dir, `cut-script.${variant}.json`), null) : null;
    if (!draft || !cut?.beats) return { skipped: "no applied director plan" };
    ai = { beats: cut.beats.map((b) => ({ id: b.id, text: b.text, lengthMs: Math.round(beatLengthMs(b)), zoom: draft.segments.find((x) => x.id === b.id)?.camera?.zoom ?? 1, shots: (draft.overlays ?? []).filter((o) => o.effect === "video-clip@1" && o.from?.segment === b.id).map(shotSig) })) };
  }
  const labels = await readJson(path.join(dir, "analysis", "line-labels.json"), { labels: {} });
  const catalog = await readJson(path.join(dir, "catalog.json"), { items: {} });
  const ingest = await readJson(path.join(dir, "ingest.json"), { assets: [] });
  const category = (id) => catalog.items?.[id]?.human?.category ?? catalog.items?.[id]?.ai?.category ?? "screen";
  const description = (id) => `${catalog.items?.[id]?.human?.description ?? catalog.items?.[id]?.ai?.description ?? ""} ${(catalog.items?.[id]?.ai?.tags ?? []).join(" ")}`;
  const assetType = (id) => (END_CARD.test(description(id)) ? "end_card" : category(id) === "action" ? "action_clip" : category(id) === "official" ? "product_shot" : "screen_recording");
  void ingest;
  const liveSeg = new Map(live.segments.map((s) => [s.id, s]));
  const shots = (plan, id) => (plan.overlays ?? []).filter((o) => o.effect === "video-clip@1" && o.from?.segment === id);
  const out = [];
  const beats = ai.beats;
  for (const [i, b] of beats.entries()) {
    const ls = liveSeg.get(b.id);
    if (!ls) continue; // the editor removed this beat
    const lShots = shots(live, b.id);
    const zoomChanged = Math.abs((ls.camera?.zoom ?? 1) - (b.zoom ?? 1)) > 0.001;
    const shotsChanged = lShots.map(shotSig).sort().join(";") !== [...(b.shots ?? [])].sort().join(";");
    const length = Math.max(1, b.lengthMs);
    const words = b.text.split(/\s+/);
    const first = [...lShots].sort((x, y) => (x.from.offsetMs ?? 0) - (y.from.offsetMs ?? 0))[0];
    const covers = first && (first.from.offsetMs ?? 0) <= 150 && (first.durationFrames * 1000) / 30 >= length * 0.7;
    const baseId = b.id.replace(/[a-z]$/, "");
    const label = labels.labels?.[baseId] ?? heuristicLabel(b.text, { first: i === 0, last: i === beats.length - 1 });
    const emphasis = (live.captions?.emphasis ?? []).map((e) => e.expect).filter((w) => w && b.text.toLowerCase().includes(String(w).toLowerCase().replace(/[^a-z0-9']/g, "")));
    out.push({
      id: `final-${projectId}-${b.id}`, source: zoomChanged || shotsChanged ? "human_edited" : "ai_accepted", projectId, cardId: null, productType: "app",
      role: label.role, text: b.text, durationMs: length, lineFeatures: label.features,
      treatment: {
        visual: !first ? "talk" : covers ? "broll" : "talk→broll",
        ...(first ? { brollAtWord: Math.min(words.length - 1, Math.round(((first.from.offsetMs ?? 0) / length) * words.length)), layout: first.props.width >= 1000 ? "full" : "pip", assetType: assetType(first.props.asset) } : {}),
        zoom: nearestZoom(ls.camera?.zoom ?? 1), emphasisWords: [...new Set(emphasis)].slice(0, 3),
        what_zh: lShots.map((s) => `${s.props.asset}`).join("、") ? `用了 ${lShots.map((s) => s.props.asset).join("、")}` : "达人画面",
      },
      prevRole: null, nextRole: null, edits: { zoom: zoomChanged, shots: shotsChanged }, recordedAt: new Date().toISOString(), planRevision: live.revision ?? 0,
    });
  }
  out.forEach((s, i) => { s.prevRole = out[i - 1]?.role ?? null; s.nextRole = out[i + 1]?.role ?? null; });
  await replaceSegments((s) => s.projectId === projectId && (s.source === "human_edited" || s.source === "ai_accepted"), out);
  return { recorded: out.length, humanEdited: out.filter((s) => s.source === "human_edited").length, aiAccepted: out.filter((s) => s.source === "ai_accepted").length };
}

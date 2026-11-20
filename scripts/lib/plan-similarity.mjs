// How different are two plans? (used by the director's compare stage and by director-eval.mjs)
import { beatLengthMs } from "./beats.mjs";

export const summarizePlan = (cut) => {
  const zoomAt = new Map(); // "clip:word" -> zoom
  let at = 0;
  const intervals = [];
  for (const b of cut.beats) {
    for (let w = b.voice.wordStart; w <= b.voice.wordEnd; w++) zoomAt.set(`${b.voice.asset}:${w}`, b.zoom ?? 1);
    for (const s of b.broll) intervals.push([at + s.atMs, at + s.atMs + s.durationMs]);
    at += beatLengthMs(b);
  }
  const first = cut.beats[0];
  const hookColors = (cut.emphasis ?? []).filter((e) => e.beat === first?.id).map((e) => e.color ?? "default").sort().join(",");
  return { zoomAt, intervals, totalMs: at, hook: `${first?.zoom ?? 1}|${first?.broll.length ? "broll" : "creator"}|${hookColors}` };
};
const overlapMs = (a, b) => { let t = 0; for (const [s1, e1] of a) for (const [s2, e2] of b) t += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2)); return t; };

// sameZoom: share of the words that sit in a beat with the same zoom; overlap: b-roll time shared / the larger b-roll time;
// sameHook: the first beat has the same zoom, b-roll presence and emphasis colours
export function similarity(cutA, cutB) {
  const A = summarizePlan(cutA), B = summarizePlan(cutB);
  const keys = [...A.zoomAt.keys()].filter((k) => B.zoomAt.has(k));
  const sameZoom = keys.length ? keys.filter((k) => A.zoomAt.get(k) === B.zoomAt.get(k)).length / keys.length : 0;
  const covered = (x) => x.intervals.reduce((t, [s, e]) => t + (e - s), 0);
  const overlap = overlapMs(A.intervals, B.intervals) / Math.max(covered(A), covered(B), 1);
  return { sameZoom, overlap, sameHook: A.hook === B.hook };
}

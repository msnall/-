// 口播清理 (voice cleanup): find what to cut out of each creator clip before anything is edited.
//
//   dead air      silence between phrases (and before the first / after the last word), measured on the audio itself
//   fillers       um / uh / er …
//   stutters      the same word twice in a row
//   retakes       a sentence the speaker started again right away (the first, unfinished try is cut)
//   slips         found by the model (mispronounced word corrected at once …), only suggested, never silent
//
// Word times from Whisper are estimates and drift around pauses (a word can sit 0.8 s before the sound), so the words are
// first re-timed onto the real speech stretches found by silence detection. Everything lands in projects/<id>/cleanup.json:
// each edit has a decision ("delete" / "keep") the editor can flip, and nothing is applied until the file is confirmed.
import { spawn } from "node:child_process";
import { callModel } from "../../desk/server/settings.mjs";

export const DEFAULTS = { noiseDb: -38, minGapMs: 120, minPauseMs: 250, keepPauseMs: 100, headPadMs: 60, tailPadMs: 80 };

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const FILLER = /^(um+|uh+|er+|erm+|ah+|hmm+|mm+)$/;
const lev = (a, b) => {
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
};
const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (Math.min(x.length, y.length) >= 4 && 1 - lev(x, y) / Math.max(x.length, y.length) >= 0.8); };

// ---- silence -> speech stretches ------------------------------------------------------------------------------
export const detectSilences = (file, durationMs, noiseDb = DEFAULTS.noiseDb) => new Promise((resolve, reject) => {
  const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=0.08`, "-vn", "-f", "null", "-"], { windowsHide: true });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("error", reject);
  p.on("close", () => {
    const silences = [];
    let start = null;
    for (const m of err.matchAll(/silence_(start|end): (-?[0-9.]+)/g)) {
      const t = Math.round(Number(m[2]) * 1000);
      if (m[1] === "start") start = Math.max(0, t);
      else if (start !== null) { silences.push([start, Math.min(durationMs, t)]); start = null; }
    }
    if (start !== null) silences.push([start, durationMs]);
    resolve(silences);
  });
});

// speech stretches = the complement of the silences; gaps shorter than minGapMs stay inside speech (breaths between words)
export const speechSegments = (silences, durationMs, minGapMs = DEFAULTS.minGapMs) => {
  const real = silences.filter(([a, b]) => b - a >= minGapMs);
  const segs = [];
  let at = 0;
  for (const [a, b] of real) { if (a > at) segs.push([at, a]); at = b; }
  if (at < durationMs) segs.push([at, durationMs]);
  return segs.filter(([a, b]) => b - a >= 150).map(([a, b], i) => ({ id: `s${i + 1}`, startMs: a, endMs: b }));
};

// Room noise, a click or a breath can show up as a short "speech" stretch where nobody speaks. Whisper's own word times drift, but not by
// 250 ms and more over a whole word: a stretch under 400 ms that no word comes near is noise, and it must not receive words in the re-timing.
export const dropNoiseStretches = (segments, words, maxMs = 400, slackMs = 250) => {
  const kept = segments.filter((seg) => seg.endMs - seg.startMs >= maxMs || words.some((w) => w.endMs > seg.startMs - slackMs && w.startMs < seg.endMs + slackMs));
  return kept.map((seg, i) => ({ ...seg, id: `s${i + 1}` }));
};

// ---- re-time Whisper's words onto the real speech stretches ---------------------------------------------------------------
// Whisper stretches words over pauses, so its times cannot say which stretch a word belongs to. Instead the words are cut into
// one run per stretch by dynamic programming: each cut should leave the same share of words as the stretches hold of speech
// time, and should preferably fall after a word that ends a sentence (. ? !). Inside a stretch the words share the time by length.
export const retimeWords = (words, segments) => {
  const K = segments.length, N = words.length;
  if (!K || !N) return words.map((w) => [w.startMs, w.endMs]);
  const weight = words.map((w) => Math.max(2, norm(w.text).length) + (/[.!?,]$/.test(w.text) ? 1 : 0));
  const cum = [0];
  weight.forEach((x) => cum.push(cum[cum.length - 1] + x));
  const dur = segments.map((s) => s.endMs - s.startMs), T = dur.reduce((a, b) => a + b, 0);
  const target = []; // share of speech time up to and including segment k
  dur.reduce((a, d, k) => { target[k] = (a + d) / T; return a + d; }, 0);
  const punct = (i) => /[.!?]$/.test(words[i].text);
  // best[k][j]: lowest cost with the first k+1 stretches holding words 0..j-1
  const INF = 1e9;
  const best = Array.from({ length: K }, () => new Float64Array(N + 1).fill(INF));
  const from = Array.from({ length: K }, () => new Int32Array(N + 1).fill(-1));
  // With enough sentence ends in the text, cuts must fall on them. Without punctuation the only other signal is where Whisper put the end
  // of the stretch (it drifts, but not by much), so that counts for more.
  const ends = words.filter((_, i) => punct(i) && i < N - 1).length;
  const penalty = ends >= K - 1 ? 0.8 : 0, hint = ends >= K - 1 ? 0.1 : 1.0;
  const cost = (k, j) => Math.abs(cum[j] / cum[N] - target[k]) * 4 + (k < K - 1 && j > 0 ? (punct(j - 1) ? 0 : penalty) + Math.min(0.6, Math.abs(words[j - 1].endMs - segments[k].endMs) / 1000) * hint : 0);
  for (let j = 1; j <= N; j++) best[0][j] = cost(0, j);
  for (let k = 1; k < K; k++) for (let j = k + 1; j <= N; j++) for (let i = k; i < j; i++) {
    const c = best[k - 1][i] + cost(k, j);
    if (c < best[k][j]) { best[k][j] = c; from[k][j] = i; }
  }
  if (N < K) return words.map((w) => [w.startMs, w.endMs]);
  const cuts = [N];
  for (let k = K - 1, j = N; k > 0; k--) { j = from[k][j]; cuts.unshift(j); }
  const out = new Array(N);
  segments.forEach((s, k) => {
    const a = k === 0 ? 0 : cuts[k - 1], b = cuts[k];
    const total = cum[b] - cum[a];
    let at = s.startMs;
    for (let i = a; i < b; i++) { const len = ((s.endMs - s.startMs) * weight[i]) / total; out[i] = [Math.round(at), Math.round(at + len)]; at += len; }
  });
  return out;
};

// ---- detections ------------------------------------------------------------------------------------------------------------
let counter = 0;
const edit = (type, fromMs, toMs, reason, extra = {}) => ({ id: `e${++counter}`, type, fromMs: Math.round(fromMs), toMs: Math.round(toMs), reason, source: "auto", decision: "delete", ...extra });

export function detectEdits({ words, timings, segments, durationMs, params = DEFAULTS }) {
  counter = 0;
  const edits = [];
  const first = segments[0], last = segments.at(-1);
  if (first && first.startMs > params.headPadMs + 40) edits.push(edit("pause", 0, first.startMs - params.headPadMs, `开头的静音 ${((first.startMs) / 1000).toFixed(2)} 秒`, { part: "head" }));
  if (last && durationMs - last.endMs > params.tailPadMs + 40) edits.push(edit("pause", last.endMs + params.tailPadMs, durationMs, `结尾的静音 ${((durationMs - last.endMs) / 1000).toFixed(2)} 秒`, { part: "tail" }));
  for (let k = 0; k + 1 < segments.length; k++) {
    const gap = segments[k + 1].startMs - segments[k].endMs;
    if (gap >= params.minPauseMs) {
      const cutFrom = segments[k].endMs + params.keepPauseMs / 2, cutTo = segments[k + 1].startMs - params.keepPauseMs / 2;
      if (cutTo - cutFrom >= 80) edits.push(edit("pause", cutFrom, cutTo, `两句之间停了 ${(gap / 1000).toFixed(2)} 秒，留 ${params.keepPauseMs} 毫秒换气`));
    }
  }
  const t = (i) => timings[i];
  words.forEach((w, i) => {
    if (FILLER.test(norm(w.text))) edits.push(edit("filler", t(i)[0] - 20, t(i)[1] + 20, `语气词“${w.text}”`, { wordFrom: i, wordTo: i }));
    else if (i > 0 && norm(w.text) && norm(w.text) === norm(words[i - 1].text) && !FILLER.test(norm(w.text))) edits.push(edit("stutter", t(i - 1)[0], t(i)[0], `“${words[i - 1].text}”连说了两遍，删掉前一个`, { wordFrom: i - 1, wordTo: i - 1 }));
  });
  // retakes: split into sentences (end punctuation or a pause of 400 ms+), then look for a sentence that is restarted right away
  const units = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(i);
    const pause = i + 1 < words.length ? timings[i + 1][0] - timings[i][1] : Infinity;
    if (/[.!?]$/.test(w.text) || pause >= 400) { units.push(cur); cur = []; }
  });
  if (cur.length) units.push(cur);
  for (let u = 0; u + 1 < units.length; u++) {
    const squeeze = (list) => list.filter((x, k) => k === 0 || x !== list[k - 1]); // a stutter inside the first try must not hide the restart
    const a = squeeze(units[u].map((i) => norm(words[i].text)).filter(Boolean)), b = squeeze(units[u + 1].map((i) => norm(words[i].text)).filter(Boolean));
    const lead = Math.min(3, a.length, b.length);
    if (lead < 2) continue;
    const restart = a.slice(0, lead).every((x, k) => same(x, b[k]));
    const wholeAgain = a.length === b.length && a.every((x, k) => same(x, b[k])); // the same sentence said twice in a row
    const partial = a.length < b.length || !/[.!?]$/.test(words[units[u].at(-1)].text) || wholeAgain;
    if (restart && partial) {
      const from = units[u][0], to = units[u].at(-1);
      edits.push(edit("retake", timings[from][0] - 20, Math.max(timings[to][1], timings[units[u + 1][0]][0] - 10), `这句没说完又重说了一遍：“${words.slice(from, to + 1).map((x) => x.text).join(" ")}”`, { wordFrom: from, wordTo: to }));
    }
  }
  return edits.sort((x, y) => x.fromMs - y.fromMs);
}

// ---- the model's review: slips and retakes the rules cannot see ----------------------------------------------------------------
export async function reviewWithModel(clips, settings) {
  const system = `You review the transcript of a creator's spoken take for an editor. Mark only CLEAR mistakes that a viewer should not hear:
- "retake": a sentence or phrase that was started and then said again properly right after (cut the earlier, flawed one);
- "slip": a word or short stretch that was misspoken and corrected immediately, or a stumble ("the- the keyboard").
Do not flag normal repetition for emphasis, informal grammar, or anything you are unsure about. Words are numbered per clip. Reply with ONE JSON object only: {"flags":[{"clip":"<id>","type":"retake|slip","fromWord":<int>,"toWord":<int>,"reason":"<short reason, Chinese>"}]} — an empty list when the takes are clean.`;
  const text = clips.map((c) => `CLIP ${c.id}\n${c.words.map((w, i) => `${i}:${w.text}`).join(" ")}`).join("\n\n");
  const reply = await callModel({ system, parts: [{ type: "text", text }], settings: { ...settings, maxTokens: Math.max(settings.maxTokens, 1500) } });
  const json = JSON.parse(/\{[\s\S]*\}/.exec(reply.text)?.[0] ?? "{\"flags\":[]}");
  const out = [];
  for (const f of json.flags ?? []) {
    const c = clips.find((x) => x.id === f.clip);
    if (!c || !["retake", "slip"].includes(f.type) || !Number.isInteger(f.fromWord) || !Number.isInteger(f.toWord) || f.fromWord < 0 || f.toWord < f.fromWord || f.toWord >= c.words.length) continue;
    if (f.toWord - f.fromWord + 1 > Math.max(8, c.words.length * 0.4)) continue; // never let a review swallow most of a take
    out.push({ clip: c.id, type: f.type, fromWord: f.fromWord, toWord: f.toWord, reason: String(f.reason ?? "").slice(0, 160), model: reply.model });
  }
  return out;
}

// ---- applying decisions ----------------------------------------------------------------------------------------------------------
export const deletedIntervals = (clip) => {
  const spans = clip.edits.filter((e) => e.decision === "delete").map((e) => [e.fromMs, e.toMs]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) { const last = merged.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  return merged;
};
export const droppedWords = (clip) => {
  const set = new Set();
  for (const e of clip.edits) if (e.decision === "delete" && e.wordFrom !== undefined) for (let i = e.wordFrom; i <= e.wordTo; i++) set.add(i);
  return set;
};
// the kept stretches of [from,to] once the deleted intervals are taken out
export const piecesOf = (clip, from, to) => {
  const pieces = [];
  let at = from;
  for (const [a, b] of deletedIntervals(clip)) {
    if (b <= from || a >= to) continue;
    if (a > at) pieces.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
  }
  if (at < to) pieces.push([at, to]);
  return pieces.filter(([a, b]) => b - a > 0);
};
export const stats = (cleanup) => {
  let before = 0, after = 0, cuts = 0;
  for (const c of Object.values(cleanup.clips)) {
    before += c.durationMs;
    after += c.durationMs - deletedIntervals(c).reduce((s, [a, b]) => s + (Math.min(b, c.durationMs) - Math.max(a, 0)), 0);
    cuts += c.edits.filter((e) => e.decision === "delete").length;
  }
  return { beforeMs: before, afterMs: Math.round(after), cuts };
};

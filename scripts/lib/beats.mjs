// Beat seeding shared by cut-from-transcripts.mjs, the auto director and the compiler.
//
// One beat per line of the proofread transcript (plus split points). Two ways to find a beat's cut points:
//  - with a CONFIRMED voice cleanup (projects/<id>/cleanup.json): words use the re-timed positions, words cut as retakes /
//    slips / fillers are dropped, and the beat is made of one or more kept pieces (`voice.ranges`) with dead air taken out;
//  - without one (older projects): the quietest 10 ms near the word edges, never inside a word.
// Either way every cut lands on the 30 fps frame grid.
import { spawn } from "node:child_process";
import path from "node:path";
import { publicDir, root } from "./media.mjs";
import { droppedWords, piecesOf } from "./cleanup.mjs";
import { readJson } from "./storage.mjs";
import { transcriptPaths } from "./transcripts.mjs";

export const FPS = 30;
export const snapFrame = (ms) => Math.round((ms * FPS) / 1000) * 1000 / FPS;

const pcm = (file) => new Promise((resolve, reject) => {
  const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { windowsHide: true });
  const chunks = []; p.stdout.on("data", (c) => chunks.push(c)); p.on("error", reject);
  p.on("close", (code) => code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve(Buffer.concat(chunks)));
});
// RMS per 10 ms (80 samples at 8 kHz)
const rmsTrack = (buf) => { const n = Math.floor(buf.length / 2 / 80); const r = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < 80; j++) { const v = buf.readInt16LE((i * 80 + j) * 2); s += v * v; } r[i] = Math.sqrt(s / 80); } return r; };
const quietest = (rms, fromMs, toMs, aim) => {
  const a = Math.max(0, Math.floor(fromMs / 10)), b = Math.min(rms.length - 1, Math.ceil(toMs / 10));
  let best = a;
  for (let i = a; i <= b; i++) if (rms[i] < rms[best] - 1e-9 || (Math.abs(rms[i] - rms[best]) < 1e-9 && Math.abs(i * 10 - aim) < Math.abs(best * 10 - aim))) best = i;
  return best * 10 + 5;
};

// length of a beat's voice, and where a moment of the clip falls inside the beat (cut-out stretches do not count)
export const beatLengthMs = (beat) => (beat.voice.ranges ? beat.voice.ranges.reduce((s, [a, b]) => s + (b - a), 0) : beat.voice.endMs - beat.voice.startMs);
export const mapToBeatMs = (beat, clipMs) => {
  if (!beat.voice.ranges) return clipMs - beat.voice.startMs;
  let before = 0;
  for (const [a, b] of beat.voice.ranges) {
    if (clipMs < a) return before;
    if (clipMs <= b) return before + (clipMs - a);
    before += b - a;
  }
  return before;
};

export const loadCleanup = async (projectId) => {
  const cleanup = await readJson(path.join(root, "projects", projectId, "cleanup.json"), null);
  return cleanup?.confirmedAt ? cleanup : null;
};

// The words (proofread, re-timed and flagged when a cleanup is confirmed) and corrected lines of every creator clip that has speech.
export async function loadClips(projectId) {
  const ingest = await readJson(path.join(root, "projects", projectId, "ingest.json"));
  const cleanup = await loadCleanup(projectId);
  const clips = [];
  for (const clip of ingest.assets.filter((a) => a.group === "creator" && a.speech)) {
    let words = await readJson(path.join(publicDir, transcriptPaths(clip).edited));
    const lines = await readJson(path.join(publicDir, transcriptPaths(clip).editedCues));
    const cut = cleanup?.clips?.[clip.id] ?? null;
    if (cut) {
      const dropped = droppedWords(cut);
      words = words.map((w, i) => ({ ...w, startMs: cut.timings[i][0], endMs: cut.timings[i][1], dropped: dropped.has(i) }));
    }
    clips.push({ clip, words, lines, cut });
  }
  return clips;
}

// splits: { "<clipId>": [wordIndex, ...] } — a new beat starts at each listed word.
// joins: { "<clipId>": [wordIndex, ...] } — the beat starting at that word is merged into the one before it (a very short line).
export async function seedBeats(projectId, splits = {}, joins = {}) {
  const beats = [];
  for (const { clip, words, lines, cut } of await loadClips(projectId)) {
    let ranges = [];
    let at = 0;
    for (const line of lines) { const n = line.text.split(/\s+/).length; ranges.push([at, at + n - 1]); at += n; }
    for (const split of splits[clip.id] ?? []) ranges = ranges.flatMap(([s, e]) => (split > s && split <= e ? [[s, split - 1], [split, e]] : [[s, e]]));
    for (const join of joins[clip.id] ?? []) { const k = ranges.findIndex(([s]) => s === join); if (k > 0) ranges.splice(k - 1, 2, [ranges[k - 1][0], ranges[k][1]]); }
    const push = (voice, text) => beats.push({ id: `b${String(beats.length + 1).padStart(2, "0")}`, text, voice: { asset: clip.id, ...voice }, broll: [] });

    if (cut) {
      let previousEnd = 0;
      for (const [s, e] of ranges) {
        const kept = [];
        for (let i = s; i <= e; i++) if (!words[i].dropped) kept.push(i);
        if (!kept.length) continue;
        // a little air around the beat, but never more than half the gap to the neighbouring word (words inside one phrase touch)
        const first = words[kept[0]], last = words[kept.at(-1)], before = words[kept[0] - 1], after = words[kept.at(-1) + 1];
        const start = Math.max(previousEnd, first.startMs - Math.min(60, before ? Math.max(0, (first.startMs - before.endMs) / 2) : 60));
        const end = Math.min(clip.durationMs, last.endMs + Math.min(80, after ? Math.max(0, (after.startMs - last.endMs) / 2) : 80));
        // the stretch minus the deleted spans, each piece on the frame grid
        const pieces = piecesOf(cut, start, end).map(([a, b]) => [snapFrame(a), snapFrame(b)]).filter(([a, b]) => b - a >= 100);
        if (!pieces.length) continue;
        previousEnd = pieces.at(-1)[1];
        push({ startMs: pieces[0][0], endMs: pieces.at(-1)[1], wordStart: s, wordEnd: e, ranges: pieces, droppedWords: Array.from({ length: e - s + 1 }, (_, k) => s + k).filter((i) => words[i].dropped) }, kept.map((i) => words[i].text).join(" "));
      }
      continue;
    }

    const rms = rmsTrack(await pcm(path.join(publicDir, clip.file)));
    const bounds = ranges.map(([s, e], i) => ({
      start: i === 0 ? quietest(rms, words[s].startMs - 200, words[s].startMs + 40, words[s].startMs - 60) : null,
      end: i === ranges.length - 1 ? quietest(rms, words[e].endMs - 40, Math.min(clip.durationMs - 20, words[e].endMs + 250), words[e].endMs + 80) : quietest(rms, words[e].endMs - 120, words[e].endMs + 120, words[e].endMs),
    }));
    ranges.forEach(([s, e], i) => push({ startMs: snapFrame(i === 0 ? bounds[0].start : bounds[i - 1].end), endMs: snapFrame(bounds[i].end), wordStart: s, wordEnd: e }, words.slice(s, e + 1).map((w) => w.text).join(" ")));
  }
  return beats;
}

// Align creator transcripts to the script and report which script lines have footage.
//
//   node scripts/align-script.mjs <projectId> [--candidate=cand-b|all] [--min=0.6]
//
// Inputs : projects/<id>/ingest.json (+ transcripts), script.json, and for candidate-based
//          orders candidates.json + confirm.json (the confirmed candidate is the default).
// Output : projects/<id>/analysis/alignment.json
// Method : approximate word-sequence matching (edit distance with fuzzy word similarity,
//          free start/end inside the transcript) of each script line against every speech clip.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publicDir, root } from "./lib/media.mjs";
import { writeJson } from "./lib/storage.mjs";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
if (!projectId) { console.error("Usage: node scripts/align-script.mjs <projectId> [--candidate=cand-b|all] [--min=0.6]"); process.exit(1); }
const dir = path.join(root, "projects", projectId);
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { if (fallback !== undefined) return fallback; throw new Error(`Cannot read ${file}`); } };
const minScore = Number(opt("min", "0.6"));

// ---- script lines ----------------------------------------------------------
export const scriptLines = async () => {
  const candidates = await readJson(path.join(dir, "candidates.json"), null);
  const confirm = await readJson(path.join(dir, "confirm.json"), null);
  if (candidates) {
    const want = opt("candidate", confirm?.selected ?? "all");
    const picked = candidates.candidates.filter((c) => want === "all" || c.id === want);
    if (!picked.length) throw new Error(`Candidate "${want}" not found`);
    return { scriptId: want, lines: picked.flatMap((c) => ["readingA", "readingB"].flatMap((part) => c[part].lines.map((l, i) => ({
      id: `${c.id}.${part}.${i + 1}`, candidate: c.id, part, index: i + 1, text: l.text, tone: l.tone ?? null }))))};
  }
  const script = await readJson(path.join(dir, "script.json"));
  const lines = [];
  for (const section of script.readingParts) for (const task of section.tasks) task.lines.forEach((l, i) => lines.push({
    id: `task${task.number}.${i + 1}`, candidate: null, part: task.role, index: i + 1, text: l.text, tone: l.tone ?? null }));
  return { scriptId: "script", lines };
};

// ---- fuzzy matching --------------------------------------------------------
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const tokens = (text) => text.split(/\s+/).map(norm).filter(Boolean);
const lev = (a, b) => {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
};
// 1 = same word, 0 = unrelated. Handles whisper misspellings (kaomoji/commojis, Kika/geeka).
const sim = (a, b) => { if (a === b) return 1; const s = 1 - lev(a, b) / Math.max(a.length, b.length); return s >= 0.6 ? s : 0; };

// Sellers: best-matching window of `text` for `pattern`; returns {start,end,cost}.
function bestWindow(pattern, text) {
  const m = pattern.length, n = text.length;
  const D = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const S = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) D[i][0] = i;
  for (let j = 0; j <= n; j++) S[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const sub = D[i - 1][j - 1] + (1 - sim(pattern[i - 1], text[j - 1]));
    const del = D[i - 1][j] + 1, ins = D[i][j - 1] + 1;
    const best = Math.min(sub, del, ins); D[i][j] = best;
    S[i][j] = best === sub ? S[i - 1][j - 1] : best === del ? S[i - 1][j] : S[i][j - 1];
  }
  let end = 1; for (let j = 1; j <= n; j++) if (D[m][j] < D[m][end]) end = j;
  return { start: S[m][end], end, cost: D[m][end] };
}

// ---- main ------------------------------------------------------------------
const ingest = await readJson(path.join(dir, "ingest.json"));
const clips = [];
for (const asset of ingest.assets.filter((a) => a.group === "creator" && a.speech)) {
  const words = await readJson(path.join(publicDir, asset.transcript.words));
  clips.push({ asset, words, toks: words.map((w) => norm(w.text)) });
}
const { scriptId, lines } = await scriptLines();
const result = [];
const GAP = 220; // pauses longer than this are jump-cut candidates (ms)
for (const line of lines) {
  const pattern = tokens(line.text);
  const found = [];
  for (const clip of clips) {
    const w = bestWindow(pattern, clip.toks);
    const score = Math.max(0, 1 - w.cost / pattern.length);
    const span = clip.words.slice(w.start, w.end);
    if (!span.length) continue;
    const gaps = span.slice(1).map((x, i) => ({ afterWord: w.start + i, startMs: span[i].endMs, endMs: x.startMs })).filter((g) => g.endMs - g.startMs > GAP);
    found.push({ asset: clip.asset.id, wordStart: w.start, wordEnd: w.end - 1, startMs: span[0].startMs, endMs: span.at(-1).endMs,
      score: Number(score.toFixed(3)), extraWords: span.length - pattern.length, heard: span.map((x) => x.text).join(" "), pausesMs: gaps });
  }
  // Best take: score first, then the tighter window (fewer stray words).
  found.sort((a, b) => b.score - a.score || Math.abs(a.extraWords) - Math.abs(b.extraWords));
  const best = found[0];
  const status = !best || best.score < minScore ? "missing" : best.score >= 0.85 ? "matched" : "partial";
  result.push({ lineId: line.id, candidate: line.candidate, text: line.text, tone: line.tone, status,
    best: status === "missing" ? null : best, alternates: found.slice(status === "missing" ? 0 : 1).filter((f) => f.score >= minScore) });
}

// Speech in the footage that no matched line uses (ad-libs, restarts, other scripts).
const used = new Map();
for (const r of result) if (r.best) { const arr = used.get(r.best.asset) ?? []; arr.push([r.best.wordStart, r.best.wordEnd]); used.set(r.best.asset, arr); }
const unused = [];
for (const clip of clips) {
  const spans = used.get(clip.asset.id) ?? [];
  let run = null;
  clip.words.forEach((w, i) => {
    const covered = spans.some(([s, e]) => i >= s && i <= e);
    if (!covered) { run ??= { asset: clip.asset.id, wordStart: i, wordEnd: i, startMs: w.startMs, endMs: w.endMs, words: [] }; run.wordEnd = i; run.endMs = w.endMs; run.words.push(w.text); }
    else if (run) { unused.push(run); run = null; }
  });
  if (run) unused.push(run);
}
const summary = { lines: result.length, matched: result.filter((r) => r.status === "matched").length, partial: result.filter((r) => r.status === "partial").length, missing: result.filter((r) => r.status === "missing").length };
await writeJson(path.join(dir, "analysis", "alignment.json"), { version: 1, projectId, scriptId, minScore, alignedAt: new Date().toISOString(), summary,
  clips: clips.map((c) => ({ asset: c.asset.id, words: c.words.length, durationMs: c.asset.durationMs })), lines: result,
  unusedSpeech: unused.map((u) => ({ ...u, text: u.words.join(" "), words: undefined })) });
console.log(`script ${scriptId}: ${summary.matched} matched, ${summary.partial} partial, ${summary.missing} missing of ${summary.lines}`);
for (const r of result) console.log(`${r.status.padEnd(8)} ${r.lineId.padEnd(18)} ${r.best ? `${r.best.asset} ${r.best.startMs}-${r.best.endMs}ms score ${r.best.score}` : ""}  ${r.text.slice(0, 50)}`);
for (const u of unused) console.log(`unused   ${u.asset} ${u.startMs}-${u.endMs}ms "${u.words.join(" ")}"`);

// Cut script: the reviewable middle layer between footage + script and edit-plan.
//
//   node scripts/cut-script.mjs build <projectId> [--candidate=cand-b]   draft from analysis/alignment.json
//   node scripts/cut-script.mjs check <projectId> [--file=<name>]        validate (exit 1 on errors)
//
// File: projects/<id>/cut-script.<scriptId>.json   (format: docs/cut-script.md)
// `build` never overwrites a file whose status is not "draft" (a human has touched it).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { publicDir, root, sha256File } from "./lib/media.mjs";
import { writeJson } from "./lib/storage.mjs";

const [command, projectId, ...rest] = process.argv.slice(2);
const opt = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
if (!["build", "check"].includes(command) || !projectId) { console.error("Usage: node scripts/cut-script.mjs build|check <projectId> [--candidate=<id>] [--file=<name>]"); process.exit(1); }
const dir = path.join(root, "projects", projectId);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = (file) => stat(file).then(() => true, () => false);

import { FORBIDDEN } from "./lib/claims.mjs";
// Allowed product facts, matched by keyword; ids point at brief.claimsAllowed text.
const CLAIM_RULES = [
  [/\b(ten thousand|10,?000)\b/i, "over 10,000 free keyboard themes"],
  [/\bfree\b/i, "free"],
  [/\b(fonts?|emojis?|stickers?|kaomoji|commojis?)\b/i, "font, emoji, sticker and kaomoji support"],
  [/\block ?screen\b/i, "keyboard and lock screen matching"],
];
const KEYWORD_TAGS = [[/theme/i, ["themes"]], [/\b(font|emoji|sticker|kaomoji|type|text)/i, ["typing"]], [/\bfree\b/i, ["FREE KEYBOARD THEMES"]], [/\b(cat|butterfly)\b/i, ["cat", "butterfly"]], [/\b(anime)\b/i, ["anime"]], [/\b(galaxy|transparent|led)\b/i, ["transparent"]]];

const roleOf = (line) => /^(readingA)$/.test(line.part) ? (line.index <= 2 ? "hook" : "product") : line.index === 3 ? "cta" : "proof";
const fileOf = (scriptId) => path.join(dir, `cut-script.${scriptId}.json`);

if (command === "build") {
  const alignment = await readJson(path.join(dir, "analysis", "alignment.json"));
  const ingest = await readJson(path.join(dir, "ingest.json"));
  const brief = await readJson(path.join(dir, "brief.json"));
  const scriptId = opt("candidate") ?? alignment.scriptId;
  if (alignment.scriptId !== scriptId && alignment.scriptId !== "all") { console.error(`alignment.json is for "${alignment.scriptId}"; run align-script.mjs --candidate=${scriptId} first`); process.exit(1); }
  const target = fileOf(scriptId);
  if (await exists(target) && (await readJson(target)).status !== "draft") { console.error(`${path.basename(target)} is ${(await readJson(target)).status}; refusing to overwrite`); process.exit(1); }
  const screens = ingest.assets.filter((a) => a.group === "screen");
  const words = {};
  const beats = [];
  for (const line of alignment.lines.filter((l) => alignment.scriptId === "all" ? l.candidate === scriptId : true)) {
    const [, part, idx] = line.lineId.split(".");
    const beat = { id: `b${String(beats.length + 1).padStart(2, "0")}`, lineId: line.lineId, role: roleOf({ part, index: Number(idx) }), text: line.text, tone: line.tone };
    beat.claims = CLAIM_RULES.filter(([re]) => re.test(line.text)).map(([, id]) => id);
    if (line.status === "missing" || !line.best) { beat.voice = null; beat.status = "missing-footage"; beats.push(beat); continue; }
    const b = line.best;
    const asset = ingest.assets.find((a) => a.id === b.asset);
    words[b.asset] ??= await readJson(path.join(publicDir, asset.transcript.words));
    const w = words[b.asset];
    // Cut in the middle of the surrounding silence, never inside a word; cap padding at 120 ms head / 180 ms tail.
    const prevEnd = w[b.wordStart - 1]?.endMs ?? 0, nextStart = w[b.wordEnd + 1]?.startMs ?? asset.durationMs;
    const startMs = Math.max(Math.round((prevEnd + b.startMs) / 2), b.startMs - 120, 0);
    const endMs = Math.min(Math.round((b.endMs + nextStart) / 2), b.endMs + 180, asset.durationMs);
    beat.status = line.status === "matched" ? "ready" : "needs-review";
    beat.voice = { asset: b.asset, startMs, endMs, wordStart: b.wordStart, wordEnd: b.wordEnd, score: b.score, heard: b.heard, pausesMs: b.pausesMs, alternates: line.alternates.map((a) => ({ asset: a.asset, startMs: a.startMs, endMs: a.endMs, score: a.score })) };
    // Default picture = the creator on screen for the whole line; screen-recording cutaways are added in review.
    beat.visuals = [{ kind: "talk", asset: b.asset, layout: "full" }];
    const wanted = KEYWORD_TAGS.filter(([re]) => re.test(line.text)).flatMap(([, tags]) => tags);
    beat.suggest = screens.map((s) => ({ asset: s.id, hits: (s.tags ?? []).filter((t) => wanted.includes(t)).length })).filter((s) => s.hits).sort((a, c) => c.hits - a.hits).slice(0, 3).map((s) => s.asset);
    beats.push(beat);
  }
  const ready = beats.filter((b) => b.voice);
  const doc = { schemaVersion: 1, projectId, scriptId, status: "draft", builtAt: new Date().toISOString(),
    inputs: { ingestSha256: await sha256File(path.join(dir, "ingest.json")), alignmentSha256: await sha256File(path.join(dir, "analysis", "alignment.json")), briefOrder: brief.orderId },
    summary: { beats: beats.length, ready: beats.filter((b) => b.status === "ready").length, needsReview: beats.filter((b) => b.status === "needs-review").length, missingFootage: beats.filter((b) => b.status === "missing-footage").length, voiceDurationMs: ready.reduce((s, b) => s + b.voice.endMs - b.voice.startMs, 0) },
    beats };
  await writeJson(target, doc);
  console.log(`${path.relative(root, target)}: ${JSON.stringify(doc.summary)}`);
}

if (command === "check") {
  const file = opt("file") ?? (await (async () => { const { readdir } = await import("node:fs/promises"); return (await readdir(dir)).find((f) => /^cut-script\..+\.json$/.test(f)); })());
  if (!file) { console.error("No cut-script file"); process.exit(1); }
  const doc = await readJson(path.join(dir, file));
  const ingest = await readJson(path.join(dir, "ingest.json"));
  const brief = await readJson(path.join(dir, "brief.json"));
  const assets = new Map(ingest.assets.map((a) => [a.id, a]));
  const errors = [], warnings = [];
  const err = (b, m) => errors.push(`${b.id ?? "-"}: ${m}`), warn = (b, m) => warnings.push(`${b.id ?? "-"}: ${m}`);
  const range = (b, label, asset, s, e) => { const a = assets.get(asset); if (!a || !a.durationMs) return err(b, `${label}: unknown or non-video asset "${asset}"`); if (!(e > s) || s < 0 || e > a.durationMs + 50) err(b, `${label}: ${s}-${e}ms outside ${asset} (0-${a.durationMs}ms)`); };
  if (doc.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const ids = new Set();
  for (const b of doc.beats) {
    if (ids.has(b.id)) err(b, "duplicate beat id"); ids.add(b.id);
    for (const [re, why] of FORBIDDEN) if (re.test(b.text) || (b.overlayText ?? []).some((t) => re.test(t))) err(b, `forbidden claim (${why}) in "${b.text}"`);
    for (const c of b.claims ?? []) if (!brief.product.claimsAllowed.includes(c)) err(b, `claim "${c}" is not in brief.claimsAllowed`);
    if (!b.voice) { (b.status === "missing-footage" ? warn : err)(b, `no voice footage (${b.status})`); continue; }
    range(b, "voice", b.voice.asset, b.voice.startMs, b.voice.endMs);
    if (!assets.get(b.voice.asset)?.speech) err(b, `voice asset ${b.voice.asset} has no speech`);
    if (b.status === "needs-review") warn(b, `matched at ${b.voice.score}; heard "${b.voice.heard}"`);
    if (!b.visuals?.length) err(b, "no visuals");
    for (const v of b.visuals ?? []) {
      const a = assets.get(v.asset ?? b.voice.asset);
      if (!a) { err(b, `visual references unknown asset "${v.asset}"`); continue; }
      if (v.kind === "screen" && v.srcStartMs !== undefined) range(b, "screen shot", v.asset, v.srcStartMs, v.srcStartMs + (v.durationMs ?? 1));
      if (a.warning) warn(b, `${a.id}: ${a.warning}`);
    }
  }
  const total = doc.beats.filter((b) => b.voice).reduce((s, b) => s + b.voice.endMs - b.voice.startMs, 0);
  if (total > 60000) warn({ id: "-" }, `total voice ${total}ms exceeds 60 s`);
  console.log(`${file}: ${doc.beats.length} beats, ${errors.length} errors, ${warnings.length} warnings`);
  errors.forEach((e) => console.log(`ERROR   ${e}`)); warnings.forEach((w) => console.log(`warning ${w}`));
  process.exit(errors.length ? 1 : 0);
}

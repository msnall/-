// Turn an analysed reference video into a style card (library/style-cards/<id>.json, status "draft").
//
//   node scripts/learn-style-card.mjs <refId>
//
// Input : library/references/<refId>/analysis.json (+ frames) from scripts/analyze-reference.mjs — one frame per second,
//         scene cuts, shot lengths, spoken words with times.
// Model : the one configured in 「API 设置」. It reads the frames and the measured numbers and fills the six areas of the card.
// Output: a draft card. Nothing steers the auto director until the editor edits and confirms it in the 风格库 page.
import { readFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { callModel, readApiSettings } from "../desk/server/settings.mjs";
import { root } from "./lib/media.mjs";
import { parseCard, ROLES } from "./lib/style-card.mjs";
import { readJson, writeJson } from "./lib/storage.mjs";

const refId = process.argv[2];
if (!refId || !/^[a-z0-9][a-z0-9-]*$/.test(refId)) { console.error("Usage: node scripts/learn-style-card.mjs <refId>"); process.exit(1); }
const refDir = path.join(root, "library", "references", refId);
const analysis = await readJson(path.join(refDir, "analysis.json"));
const settings = await readApiSettings();
if (!settings.apiKey) { console.error("No API key saved (设置 → API 设置)."); process.exit(1); }

// ---- strips of 5 one-second frames each -------------------------------------------------------------------------
const PER = 5;
const strips = [];
for (let i = 0; i < analysis.frames.length; i += PER) {
  const group = analysis.frames.slice(i, i + PER);
  const out = path.join(refDir, `strip-${String(i / PER).padStart(2, "0")}.jpg`);
  if (!(await stat(out).catch(() => null))) {
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...group.flatMap((f) => ["-i", path.join(refDir, f.file)]), "-filter_complex", group.length > 1 ? `hstack=${group.length}` : "null", "-q:v", "4", out], { windowsHide: true });
      p.on("error", reject); p.on("close", (c) => (c ? reject(new Error(`ffmpeg exited ${c}`)) : resolve()));
    });
  }
  strips.push({ file: out, times: group.map((f) => f.t) });
}

const system = `You are a senior TikTok e-commerce (UGC) video editor. You are shown a FINISHED reference video as one frame per second (in strips, left to right) plus measured data. Write its STYLE CARD, so a different video can be edited the same way.
Describe only what you can see or measure. Times are in milliseconds from the start of the video. All prose in Chinese except "directorRules" (English).
Our editing engine today: main footage with per-segment zoom and punch-ins; captions (word-timed, box position, size, colours, uppercase, dark background, per-word emphasis colour/scale); overlays: text card, still image (logo), muted video clip anywhere on the canvas at any size (full-screen cutaway or picture-in-picture), solid rectangle, short fade-through-black. The editor adds stickers, emoji, sound effects and music in 剪映 afterwards.
Not supported by the engine yet: glow/neon/outline text, animated emoji and stickers, sound effects, background music and ducking, speed ramps, face filters.
Reply with ONE JSON object only:
{"summary":"整体风格 2-3 句",
 "structure":[{"role":"hook|pain|demo|proof|benefit|cta|other","label":"钩子/痛点/…","fromMs":0,"toMs":4400,"what":"这一段做了什么"}],
 "rhythm":{"avgCutMs":<average time between picture changes, counting cutaways and overlays>,"removePauses":<bool: pauses between sentences are cut out>,"maxPauseMs":<longest pause left in>,"note":""},
 "camera":{"zoomOnKeywords":<bool>,"zoomRange":[1.0,1.2],"alternateFraming":<bool: alternates close and medium>,"note":""},
 "captions":{"position":"top|center|center-low|bottom","yRatio":<0-1 from top>,"look":"字体颜色、描边或底色","highlight":"关键词怎么强调","animation":"逐词弹出/整句出现/…","wordsPerChunk":[2,4],"upper":<bool>,"emoji":<bool: emoji next to the captions>,"note":""},
 "inserts":{"layout":"full|pip|mixed","firstAtMs":<when the first cutaway or overlay appears>,"shotMs":[<min>,<max> length of one cutaway],"share":<0-1 share of the video covered by cutaways>,"triggers":"什么时候插画","logoPersistent":<bool>,"ending":"fullscreen|end-card|none","note":""},
 "packaging":{"stickers":"贴纸/表情","sfx":"音效","music":"背景音乐","duckDb":<number, music level under speech in dB, -20 if unknown>,"note":""},
 "support":[{"area":"captions|camera|inserts|packaging|rhythm|structure","feature":"具体做法","level":"supported|partial|needs-effect","note":"引擎现在能做到什么、缺什么"}],
 "directorRules":["Imperative one-line rules for an automatic editor, English, 4-8 of them, concrete"]}
Cover the whole video in "structure" with 3-6 consecutive segments. Use only the roles listed. Be concrete and measured; do not invent product claims.`;

const secs = (ms) => (ms / 1000).toFixed(1);
const parts = [{ type: "text", text: `Reference: ${analysis.title}. ${secs(analysis.facts.durationMs)} s, ${analysis.facts.width}x${analysis.facts.height}.\nMeasured: ${analysis.pacing.shotCount} hard-cut shots, average ${analysis.pacing.avgShotMs} ms (min ${analysis.pacing.minShotMs}, max ${analysis.pacing.maxShotMs}). Hard cuts at ${analysis.cuts.timesMs.map(secs).join(", ") || "none"} s; picture-in-picture and overlays are NOT detected as cuts, look at the frames for them.\nSpoken words (word@seconds): ${analysis.transcript.words.map((w) => `${w.text}@${secs(w.startMs)}`).join(" ")}\nFrames follow, 5 per strip.` }];
for (const s of strips) {
  parts.push({ type: "text", text: `Strip with frames at t = ${s.times.map((t) => `${t}.3`).join(", ")} s:` });
  parts.push({ type: "image", mediaType: "image/jpeg", data: (await readFile(s.file)).toString("base64") });
}

console.log(`style card: asking ${settings.model} (${strips.length} strips)…`);
let json = null, model = null;
for (let attempt = 0; attempt < 3 && !json; attempt++) {
  const reply = await callModel({ system, parts, settings: { ...settings, maxTokens: Math.max(settings.maxTokens, 4500), timeoutSec: Math.max(settings.timeoutSec, 240) } });
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(reply.text)?.[0] ?? "");
    if (!Array.isArray(parsed.structure) || parsed.structure.length < 2 || !parsed.inserts || !parsed.captions) throw new Error("missing structure / inserts / captions");
    json = parsed; model = reply.model;
  } catch (error) { console.log(`  attempt ${attempt + 1} rejected: ${error.message}`); }
}
if (!json) { console.error("the model did not return a usable card"); process.exit(1); }

// never overwrite a confirmed card: a second run of the same reference gets a new id
const cardsDir = path.join(root, "library", "style-cards");
await mkdir(cardsDir, { recursive: true });
let id = refId, n = 1;
while (true) {
  const existing = await readJson(path.join(cardsDir, `${id}.json`), null);
  if (!existing || existing.status === "draft") break;
  id = `${refId}-${++n}`;
}
const dur = analysis.facts.durationMs;
const card = parseCard({
  ...json, version: 1, id, name: analysis.title, status: "draft", model,
  source: { referenceId: refId, title: analysis.title, durationMs: dur, shots: analysis.pacing.shotCount },
  structure: json.structure.map((s) => ({ ...s, fromMs: Math.max(0, Math.min(dur, Number(s.fromMs) || 0)), toMs: Math.max(0, Math.min(dur, Number(s.toMs) || 0)) })),
  createdAt: new Date().toISOString(), confirmedAt: null,
});
await writeJson(path.join(cardsDir, `${id}.json`), card);
console.log(`style card ${id}: ${card.structure.map((s) => `${ROLES[s.role]} ${secs(s.fromMs)}–${secs(s.toMs)}s`).join(" / ")}`);
console.log(`  rhythm ${card.rhythm.avgCutMs} ms · inserts ${card.inserts.layout} ${Math.round(card.inserts.share * 100)}% · ${card.support.length} support notes -> library/style-cards/${id}.json`);

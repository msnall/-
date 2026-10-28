import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stem = path.join(root, "public/transcripts/Bloom10-达人素材");
const raw = JSON.parse(await readFile(`${stem}.json`, "utf8"));
const meta = JSON.parse(await readFile(`${stem}.meta.json`, "utf8"));
const source = path.join(root, "public/recordings/Bloom10/Bloom10-达人素材.mp4");
const sourceHash = createHash("sha256").update(await readFile(source)).digest("hex");
if (sourceHash !== meta.sourceSha256 || meta.durationMs !== 30278 || !meta.model.endsWith("ggml-small.en.bin")) {
  throw new Error("Expected the reviewed 30.278s English small.en source. Revisit the edit before applying corrections.");
}

const words = raw.map((word) => ({ ...word }));
const replacement = words.find((word) => word.startMs === 14090);
if (replacement?.text !== "go") throw new Error("Expected raw word 'go' at 14.09s");
replacement.text = "throw";
const first = words.find((word) => word.startMs === 27120);
const duplicate = words.findIndex((word) => word.startMs === 28000);
if (first?.text !== "I'll" || words[duplicate]?.text !== "I'll") throw new Error("Expected repeated I'll");
first.endMs = words[duplicate].endMs;
words.splice(duplicate, 1);

const phrases = [
  [0, 2610, "I've been taking these biotic breast gummies"],
  [2610, 3720, "for about a week now."],
  [3720, 5580, "And I'm gonna tell you what I"],
  [5580, 7600, "like the best about them, other than the flavor,"],
  [7600, 8780, "is the fact that they are"],
  [8780, 10080, "individually wrapped."],
  [10080, 11700, "I don't have to worry about them getting stuck"],
  [11700, 12570, "to the side of the bottle."],
  [12570, 13550, "And then I can't get them out,"],
  [13550, 15190, "and I have to throw the bottle away."],
  [15190, 17160, "So I'm gonna link them for y'all."],
  [17160, 19330, "They come in a pretty good size container,"],
  [19330, 21540, "and this one here has, well, it's"],
  [21540, 22920, "30 days' worth,"],
  [22920, 24460, "because you take two gummies a day."],
  [24460, 25790, "That's what's recommended,"],
  [25790, 27000, "and that's what I've been taking."],
  [27000, 29620, "So I'll highly recommend these to you."],
].map(([startMs, endMs, text]) => ({
  startMs, endMs, startFrame: Math.round(startMs * 30 / 1000), endFrame: Math.round(endMs * 30 / 1000), text,
}));

function wrap(text) {
  if (text.length <= 24) return text;
  const pieces = text.split(" ");
  let best = { score: Infinity, lines: [text] };
  for (let i = 1; i < pieces.length; i++) {
    const lines = [pieces.slice(0, i).join(" "), pieces.slice(i).join(" ")];
    const score = Math.max(...lines.map((s) => s.length)) + Math.abs(lines[0].length - lines[1].length) * 0.2;
    if (score < best.score) best = { score, lines };
  }
  return best.lines.join("\n");
}
function timestamp(ms) {
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
let previousEnd = 0;
for (const cue of phrases) {
  if (cue.startMs !== previousEnd || cue.endMs <= cue.startMs || cue.endMs > meta.durationMs ||
      wrap(cue.text).split("\n").some((line) => line.length > 28)) throw new Error("Invalid caption cue");
  previousEnd = cue.endMs;
}
await writeFile(`${stem}.edited.json`, JSON.stringify(words, null, 2) + "\n");
await writeFile(`${stem}.edited.cues.json`, JSON.stringify(phrases, null, 2) + "\n");
await writeFile(`${stem}.edited.srt`, phrases.map((cue, i) => `${i + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${wrap(cue.text)}\n`).join("\n"));
await writeFile(`${stem}.edited.txt`, phrases.map((cue) => cue.text).join(" ") + "\n");
const corrections = {
  sourceSha256: sourceHash, status: "editorial revision ready for storyboard acceptance",
  changes: [
    { startMs: 14090, original: "go", revised: "throw", evidence: "User explicitly confirmed throw the bottle away in this chat" },
    { startMs: 27120, endMs: 28200, original: "I'll I'll", revised: "I'll", evidence: "Caption readability cleanup; both timings combined, source audio not cut" },
    { original: "automatic phrase breaks", revised: "18 readable cues, punctuation and at most two lines", evidence: "Editorial punctuation and line wrapping; original word times preserved except combined stutter" },
  ],
  retained: "gonna, y'all and other spoken forms retained; highly comes from small.en and was accepted for this revision, not separately certified by human listening",
  namePolicy: "Keep spoken biotic in captions. Do not replace it with BLOOM10 or a guessed formal brand; label text visible on the package is a separate visual reference.",
  timing: "Whisper estimated timings, rounded to nearest 30fps frame for cues; not forced alignment",
};
await writeFile(`${stem}.edited.review.json`, JSON.stringify(corrections, null, 2) + "\n");
if (process.argv.includes("--captions-only")) {
  console.log(`Prepared ${phrases.length} revised cues with compact line wrapping`);
  process.exit(0);
}

const directory = path.join(root, "public/storyboards/bloom10");
await mkdir(directory, { recursive: true });
const beats = [
  { id: "b01", title: "体验开场", fromMs: 0, toMs: 7600, stillAt: 800, headline: "ONE WEEK IN", caption: "I've been taking these\nbiotic breast gummies", note: "保留真人建立信任。上方仅放小标题，不添加产品功效承诺。", graphic: "小标题淡入；面部不遮挡。", sound: "人声为主，配乐轻入。", layout: "top" },
  { id: "b02", title: "独立包装", fromMs: 7600, toMs: 10080, stillAt: 9000, headline: "INDIVIDUALLY WRAPPED", caption: "individually wrapped.", note: "在说 individually 的约 8.78 秒强调独立包装，配合原片产品展示。", graphic: "标签入场；HyperFrames 柔和光泽仅作为待验证方案。", sound: "轻微 pop，与标签落点同步。", layout: "middle" },
  { id: "b03", title: "解释粘瓶痛点", fromMs: 10080, toMs: 15190, stillAt: 12200, headline: "THE BOTTLE PROBLEM", caption: "and I have to throw\nthe bottle away.", note: "保留完整上下文，throw 已由用户明确确认。只用小标注，不制造不存在的前后对比。", graphic: "侧边短线标注；轻微镜头放大在成片阶段验证。", sound: "不覆盖口播，不对每个词加音效。", layout: "top" },
  { id: "b04", title: "链接引导与容器展示", fromMs: 15190, toMs: 19580, stillAt: 18400, headline: "A CLOSER LOOK", caption: "They come in a\npretty good size container,", note: "容器和包装保持完整可见。口播中有 link 引导；发布位置未确定，暂不画购物车箭头。", graphic: "简洁框线或标签，不遮挡包装文字。", sound: "可选一次轻滑动音。", layout: "top" },
  { id: "b05", title: "数量信息", fromMs: 19580, toMs: 27120, stillAt: 22300, headline: "30-DAY SUPPLY", caption: "because you take\ntwo gummies a day.", note: "字幕忠实保留口播。30-DAY SUPPLY 大字图形暂标待核对，需与包装信息一致后再启用。", graphic: "数量卡片待确认；未确认时只保留字幕。", sound: "若启用卡片，仅一个柔和提示音。", layout: "middle", optional: true },
  { id: "b06", title: "推荐结尾", fromMs: 27120, toMs: 30278, stillAt: 28800, headline: "SEE PRODUCT DETAILS", caption: "I'll highly recommend\nthese to you.", note: "字幕合并重复 I'll，保留原声。结尾短文字作为行动引导；具体链接在发布时设置。", graphic: "小型结束提示，不制作无实际链接的按钮。", sound: "配乐自然收尾，避免截断推荐语。", layout: "top" },
].map((beat) => ({ ...beat, fromFrame: Math.round(beat.fromMs * 30 / 1000), toFrame: Math.ceil(beat.toMs * 30 / 1000) }));
// Adjacent storyboard intervals share one exact frame boundary.
for (let i = 1; i < beats.length; i++) beats[i].fromFrame = beats[i - 1].toFrame;
for (const beat of beats) {
  const cue = phrases.find((item) => item.startMs <= beat.stillAt && item.endMs > beat.stillAt);
  beat.caption = cue ? wrap(cue.text) : "";
  const file = path.join(directory, `${beat.id}.jpg`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(beat.stillAt / 1000), "-i", source,
    "-frames:v", "1", "-vf", "scale=360:-1", "-q:v", "5", file], { windowsHide: true });
  beat.image = `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`;
}
const plan = {
  revision: "bloom10-storyboard-r1", sourceSha256: sourceHash, fps: 30, totalFrames: 909,
  durationMs: meta.durationMs, editApproach: "First review retains source order and full duration. No final video has been edited.",
  palette: { ink: "#231b22", paper: "#fff8fb", pink: "#c95f8e" },
  brandStatus: "Temporary package-inspired palette, not an approved brand sheet",
  sourcePlacement: { x: 43, y: 38, width: 842, height: 1498, note: "Inset full source to reserve caption space without covering face or package; pending user design acceptance" },
  captionArea: { left: 90, right: 190, top: 1540, bottom: 1680, note: "1080x1920 proposal; inspect every shot and target platform UI before rendering" },
  beats: beats.map(({ image, ...beat }) => beat),
};
await writeFile(path.join(directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
await mkdir(path.join(root, "out/review/bloom10"), { recursive: true });
await writeFile(path.join(root, "out/review/bloom10/storyboard-inline-data.json"), JSON.stringify({ ...plan, beats }));
console.log(JSON.stringify({ cues: phrases.length, editedWords: words.length, beats: beats.length, sourceHash, totalFrames: plan.totalFrames }, null, 2));

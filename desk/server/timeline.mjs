// 表格方案: one version of the plan as a table the editor can read and change line by line. The table is a view of that version's
// cut script (projects/<id>/cut-script.<style>.json, the single timeline file): saving writes the cut script and rebuilds the
// draft plan; nothing else is stored.
//
// Row = one beat (one spoken line):  时间 | 口播内容 | 画面 (cutaway shots) | 效果 (zoom) | 字幕 (emphasis words) | 音效
import { beatLengthMs } from "../../scripts/lib/beats.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { readCatalog } from "./catalog.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import { cutName, directorStatus, recompile, STYLES } from "./director.mjs";
import { EFFECTS, ZOOM_SCALE, zoomIdOf } from "../../scripts/lib/effects.mjs";

const PIP_SLOTS = ["top-left", "top-right", "lower-left", "lower-right"];
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const FPS = 30;

async function assetOptions(id) {
  const catalog = await readCatalog(id);
  const ingest = await readJson(projectFile(id, "ingest.json"), { assets: [] });
  const facts = new Map(ingest.assets.map((a) => [a.id, a]));
  return catalog.items.filter((i) => i.type === "video" && ["screen", "official", "action"].includes(i.category) && i.durationMs)
    .map((i) => ({ id: i.id, title: i.title, description: i.description, durationMs: i.durationMs, width: facts.get(i.id)?.width, height: facts.get(i.id)?.height, category: i.category }));
}

export async function readTable(id, variant) {
  const cut = await readJson(projectFile(id, cutName(variant)), null);
  if (!cut) throw new HttpError(404, "这套方案还没有生成");
  let at = 0;
  const emphasis = cut.emphasis ?? [];
  const rows = cut.beats.map((b) => {
    const length = Math.round(Math.round((beatLengthMs(b) * FPS) / 1000) * 1000 / FPS);
    const row = {
      id: b.id, text: b.text, startMs: Math.round(at), lengthMs: length,
      words: b.text.split(/\s+/).filter(Boolean),
      emphasis: emphasis.filter((e) => e.beat === b.id).map((e) => e.word),
      broll: b.broll.map((s) => ({ id: s.id, asset: s.asset, srcStartMs: s.srcStartMs, atMs: s.atMs, durationMs: s.durationMs, layout: s.layout ?? "full", slot: s.slot ?? null, note: s.note ?? "" })),
      voice: { asset: b.voice.asset, atMs: Math.min((b.voice.ranges?.[0]?.[0] ?? b.voice.startMs) + 300, b.voice.endMs - 100) }, // a still of the creator on this line
      zoom: typeof b.zoom === "number" ? b.zoom : null, // null = automatic (alternating close-ups)
      zoomId: typeof b.zoom === "number" ? zoomIdOf(b.zoom) : null, logoAtMs: cut.logo?.beat === b.id ? cut.logo.atMs : null,
    };
    at += length;
    return row;
  });
  return { variant, label: cut.director?.direction?.name_zh ?? STYLES[variant]?.label ?? "当前草稿", blurb: cut.director?.direction?.oneLineSummary_zh ?? null, zoomOptions: EFFECTS.zoom.filter((z) => z.ready).map((z) => ({ id: z.id, scale: z.scale })), totalMs: Math.round(at), logo: !!cut.logo, rows, assets: await assetOptions(id), builtAt: cut.builtAt };
}

// body.rows: [{ id, broll?, zoom?, sfx?, emphasis? }] — only the fields present change. Everything is checked before anything is written.
export async function saveTable(id, variant, body) {
  const cut = await readJson(projectFile(id, cutName(variant)), null);
  if (!cut) throw new HttpError(404, "这套方案还没有生成");
  const assets = new Map((await assetOptions(id)).map((a) => [a.id, a]));
  const problems = [];
  for (const edit of body.rows ?? []) {
    const beat = cut.beats.find((b) => b.id === edit.id);
    if (!beat) { problems.push(`没有这一行：${edit.id}`); continue; }
    const label = `「${beat.text.slice(0, 24)}」`;
    const length = beatLengthMs(beat);
    if (edit.broll !== undefined) {
      if (!Array.isArray(edit.broll)) { problems.push(`${label}：画面格式不对`); continue; }
      const shots = [];
      for (const [n, s] of edit.broll.entries()) {
        const a = assets.get(s.asset);
        const where = `${label}第 ${n + 1} 个镜头`;
        if (!a) { problems.push(`${where}：素材 ${s.asset} 不存在或不能当插画`); continue; }
        const durationMs = Math.round(Number(s.durationMs)), atMs = Math.round(Number(s.atMs)), srcStartMs = Math.round(Number(s.srcStartMs ?? 0));
        if (![durationMs, atMs, srcStartMs].every(Number.isFinite)) { problems.push(`${where}：时间不是数字`); continue; }
        if (durationMs < 400 || durationMs > 6000) problems.push(`${where}：时长要在 0.4–6 秒之间`);
        if (atMs < 0 || atMs + durationMs > length + 50) problems.push(`${where}：超出这一句（这一句共 ${(length / 1000).toFixed(1)} 秒）`);
        if (srcStartMs < 0 || srcStartMs + durationMs > a.durationMs) problems.push(`${where}：${a.title} 只有 ${(a.durationMs / 1000).toFixed(1)} 秒，从 ${(srcStartMs / 1000).toFixed(1)} 秒开始放不下 ${(durationMs / 1000).toFixed(1)} 秒`);
        const layout = s.layout === "pip" ? "pip" : "full";
        if (layout === "pip" && !PIP_SLOTS.includes(s.slot)) problems.push(`${where}：画中画要选一个位置`);
        shots.push({ id: `${beat.id}-${n + 1}`, asset: s.asset, srcStartMs, atMs, durationMs, layout, ...(layout === "pip" ? { slot: s.slot } : {}), note: String(s.note ?? "").slice(0, 200) });
      }
      shots.sort((x, y) => x.atMs - y.atMs).forEach((s, k) => { if (k && shots[k - 1].atMs + shots[k - 1].durationMs > s.atMs) problems.push(`${label}：两个镜头在时间上重叠了`); });
      beat.broll = shots;
    }
    if (edit.zoom !== undefined) {
      const scale = typeof edit.zoom === "string" ? ZOOM_SCALE[edit.zoom] : edit.zoom;
      if (edit.zoom === null) delete beat.zoom;
      else if (typeof scale === "number" && scale >= 1 && scale <= 1.5) beat.zoom = scale;
      else problems.push(`${label}：推近要选 ${Object.keys(ZOOM_SCALE).join(" / ")}`);
    }
    if (edit.emphasis !== undefined) {
      const known = new Set(beat.text.split(/\s+/).map(norm));
      const words = [...new Set((edit.emphasis ?? []).map(String))];
      for (const w of words) if (!known.has(norm(w))) problems.push(`${label}：强调的词 "${w}" 不在这一句里`);
      if (words.length > 3) problems.push(`${label}：一句最多强调 3 个词`);
      cut.emphasis = [...(cut.emphasis ?? []).filter((e) => e.beat !== beat.id), ...words.map((word) => ({ beat: beat.id, word }))];
    }
  }
  if (typeof body.logo === "boolean") {
    if (!body.logo) delete cut.logo;
    else if (!cut.logo) {
      const beat = cut.beats.find((b) => /kika/i.test(b.text));
      if (!beat) problems.push("口播里没有出现产品名，不知道图标该从哪里开始");
      else cut.logo = { beat: beat.id, atMs: 300, position: "top-left" };
    }
  }
  if (problems.length) throw badRequest("有几处没法保存：", { problems });
  await writeJson(projectFile(id, cutName(variant)), cut);
  try { await recompile(id, variant); }
  catch (error) { throw new HttpError(500, `保存了，但重新编译失败：${error.message}`); }
  return { table: await readTable(id, variant), status: await directorStatus(id) };
}

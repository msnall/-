// 自动导演 for a TTO project: several styles ("方案") are generated side by side, the editor compares them and puts one
// into the review desk.
//   生成方案 : 同步校对文案 → 模型按不同风格各出一套（全屏插画 / 极简口播 / 参考成品风格）→ 每套编译成草稿
//              projects/<id>/cut-script.<style>.json + edit-plan.draft.<style>.json
//   换效果   : 在某一套上开关常驻图标、全屏 ⇄ 画中画，立即重新编译（不再调用模型）
//   放进审阅精修: 选定的一套成为审阅台里的新版本（旧版本留在「版本」里，随时可回退）
// Progress is written to projects/<id>/director-run.json and polled by the page. The live edit-plan only changes in
// applyDraft, through the same installCompiledPlan the desk uses.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { root } from "../../scripts/lib/media.mjs";
import { exists, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict } from "./errors.mjs";
import { readCatalog } from "./catalog.mjs";
import { emit } from "./events.mjs";
import { installCompiledPlan, withLock } from "./projects.mjs";
import { confirmedCard } from "./styles.mjs";

export const STYLES = {
  full: { label: "全屏插画", blurb: "录屏整屏盖住达人，节奏明快，最稳妥。" },
  minimal: { label: "极简口播", blurb: "以达人为主，只在最关键的两三处插画，看起来最真实。" },
  pip: { label: "按风格卡", blurb: "完全按你选的风格卡来剪：画中画、图标、结尾等都照卡上的写法（需要先选一张已确认的风格卡）。" },
};
// a / b / c = the three creative directions of the current generation; full / minimal / pip / default = drafts of the older style-based generation
const NEW_SLOTS = ["a", "b", "c"];
const LEGACY = ["full", "minimal", "pip", "default"];
const ORDER = [...NEW_SLOTS, ...LEGACY];
const slotLabel = (cut, variant) => cut?.director?.direction?.name_zh ?? STYLES[variant]?.label ?? "当前草稿";
export const cutName = (v) => (v === "default" ? "cut-script.json" : `cut-script.${v}.json`);
export const planName = (v) => (v === "default" ? "edit-plan.draft.json" : `edit-plan.draft.${v}.json`);

const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];
const running = new Set();
const runFile = (id) => projectFile(id, "director-run.json");

const runStep = (command, args, log) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true });
  let errText = "";
  child.stdout.on("data", (d) => log.write(d));
  child.stderr.on("data", (d) => { log.write(d); errText = (errText + d).slice(-600); });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errText.trim() || `exit code ${code}`))));
});

async function summarize(id, variant, live, catalogUpdatedAt, durations, cleanupAt) {
  const cut = await readJson(projectFile(id, cutName(variant)), null);
  if (!cut || cut.schemaVersion !== 2 || !(await exists(projectFile(id, planName(variant))))) return null;
  const voiceMs = (b) => (b.voice.ranges ? b.voice.ranges.reduce((t, [x, y]) => t + (y - x), 0) : b.voice.endMs - b.voice.startMs);
  const total = cut.beats.reduce((s, b) => s + voiceMs(b), 0);
  const shots = cut.beats.flatMap((b) => b.broll);
  const fullMs = shots.filter((s) => s.layout !== "pip").reduce((s, x) => s + x.durationMs, 0);
  return {
    variant, label: slotLabel(cut, variant), blurb: cut.director?.direction?.oneLineSummary_zh ?? STYLES[variant]?.blurb ?? "", direction: cut.director?.direction ?? null, builtAt: cut.builtAt, model: cut.director?.model ?? null, notes: cut.director?.notes ?? "",
    stale: !!((catalogUpdatedAt && catalogUpdatedAt > cut.builtAt) || (cleanupAt && cleanupAt > cut.builtAt)), liveRevision: live ? (live.revision ?? 0) : null, logo: !!cut.logo, totalMs: Math.round(total),
    stats: { shots: shots.length, full: shots.filter((s) => s.layout !== "pip").length, pip: shots.filter((s) => s.layout === "pip").length, fullShare: total ? Number((fullMs / total).toFixed(2)) : 0 },
    beats: cut.beats.map((b) => ({ id: b.id, text: b.text, ms: Math.round(voiceMs(b)), broll: b.broll.map((s) => ({ asset: s.asset, frame: Math.max(0, Math.min(3, Math.floor((s.srcStartMs / (durations.get(s.asset) || 1)) * 4))), atMs: s.atMs, durationMs: s.durationMs, layout: s.layout ?? "full", slot: s.slot ?? null, note: s.note })), logoAtMs: cut.logo?.beat === b.id ? cut.logo.atMs : null })),
  };
}

export async function directorStatus(id) {
  const record = await readJson(runFile(id), { state: "idle" });
  const live = await readJson(projectFile(id, "edit-plan.json"), null);
  const catalogUpdatedAt = (await readJson(projectFile(id, "catalog.json"), {})).updatedAt ?? null;
  const ingest = await readJson(projectFile(id, "ingest.json"), { assets: [] });
  const durations = new Map(ingest.assets.map((a) => [a.id, a.durationMs]));
  const cleanupAt = (await readJson(projectFile(id, "cleanup.json"), {})).confirmedAt ?? null;
  const drafts = (await Promise.all(ORDER.map((v) => summarize(id, v, live, catalogUpdatedAt, durations, cleanupAt)))).filter(Boolean);
  return { ...record, drafts };
}

async function track(id, record, work) {
  await mkdir(projectFile(id, "logs"), { recursive: true });
  const log = createWriteStream(projectFile(id, "logs", "director.log"), { flags: "w" });
  const save = () => writeJson(runFile(id), record).then(() => emit("director", { project: id }));
  try { await work({ log, save }); } finally { log.end(); await save(); }
}

export async function startDirector(id, body = {}) {
  if (running.has(id)) throw conflict("自动导演正在运行");
  const open = (await readCatalog(id)).items.filter((i) => i.counted && !i.confirmed);
  if (open.length) throw conflict(`还有 ${open.length} 项素材没有确认：${open.map((i) => i.title).join("、")}`);
  const cleaned = await readJson(projectFile(id, "cleanup.json"), null);
  if (!cleaned?.confirmedAt) throw conflict("先在「② 口播清理」检测并确认要删掉的停顿和重说");
  const cardId = typeof body.card === "string" && body.card ? body.card : null;
  const card = cardId ? await confirmedCard(cardId) : null;
  if (cardId && !card) throw badRequest("这张风格卡不存在，或还没有在「风格库」里确认");
  const variants = NEW_SLOTS;
  const steps = [
    { name: "同步校对文案", key: "sync" },
    { name: "定三个创意方向", key: "directions" },
    ...variants.map((v, n) => ({ name: `模型出方案：方向 ${n + 1}`, key: `direct:${v}` })),
    { name: "检查三套是否足够不同", key: "compare" },
    ...variants.map((v, n) => ({ name: `编译：方向 ${n + 1}`, key: `compile:${v}` })),
  ];
  const record = { state: "running", kind: "variants", startedAt: new Date().toISOString(), finishedAt: null, steps: steps.map((s) => ({ name: s.name, key: s.key, state: "pending" })), error: null, applied: null, card: card ? { id: card.id, name: card.name } : null, note: card ? null : "没有选风格卡，三个创意方向都按节奏预设来剪；选一张已确认的风格卡，会有一个方向完全照卡来剪。" };
  await writeJson(runFile(id), record);
  running.add(id);
  (async () => {
    try {
      await track(id, record, async ({ log, save }) => {
        const mark = async (key, state) => { record.steps.find((s) => s.key === key).state = state; await save(); };
        const fail = {};
        try {
          await mark("sync", "running");
          log.write("\n=== 同步校对文案 ===\n");
          const [c0, a0] = node("scripts/sync-transcripts.mjs", id);
          try { await runStep(c0, a0, log); await mark("sync", "done"); } catch (error) { await mark("sync", "failed"); throw new Error(`同步校对文案失败：${error.message}`); }
          const cardArg = card ? [`--card=${card.id}`] : [];
          // 1 model call: three distinct creative directions
          await mark("directions", "running");
          try { const [c, a] = node("scripts/auto-director.mjs", id, "--stage=directions", ...cardArg); await runStep(c, a, log); await mark("directions", "done"); }
          catch (error) { await mark("directions", "failed"); throw new Error(`定创意方向失败：${error.message}`); }
          // one plan per direction, side by side
          await Promise.all(variants.map(async (v) => {
            await mark(`direct:${v}`, "running");
            try { const [c, a] = node("scripts/auto-director.mjs", id, "--stage=plan", `--slot=${v}`, ...cardArg); await runStep(c, a, log); await mark(`direct:${v}`, "done"); }
            catch (error) { fail[v] = error.message; await mark(`direct:${v}`, "failed"); }
          }));
          // the plans must not be near copies of each other (the most similar one is asked again)
          await mark("compare", "running");
          try { const [c, a] = node("scripts/auto-director.mjs", id, "--stage=compare", ...cardArg); await runStep(c, a, log); await mark("compare", "done"); }
          catch (error) { await mark("compare", "failed"); log.write(`\ncompare failed (the plans are kept as they are): ${error.message}\n`); }
          // compiling shares the voice master, so one at a time
          for (const v of variants.filter((x) => !fail[x])) {
            await mark(`compile:${v}`, "running");
            try { const [c, a] = node("scripts/compile-cut-script.mjs", id, `--file=${cutName(v)}`, `--plan=${planName(v)}`, "--force"); await runStep(c, a, log); await mark(`compile:${v}`, "done"); }
            catch (error) { fail[v] = error.message; await mark(`compile:${v}`, "failed"); }
          }
          const ok = variants.filter((v) => !fail[v]);
          if (!ok.length) throw new Error(`所有方案都失败：${Object.values(fail)[0]}`);
          if (Object.keys(fail).length) record.note = `${record.note ? `${record.note} ` : ""}有 ${Object.keys(fail).length} 套没成功：${Object.entries(fail).map(([v, m]) => `方向 ${NEW_SLOTS.indexOf(v) + 1}（${m.split("\n")[0].slice(0, 120)}）`).join("；")}`;
          // a style that failed this time must not keep an old draft around; the earlier single draft is superseded
          for (const v of Object.keys(fail)) { await rm(projectFile(id, cutName(v)), { force: true }); await rm(projectFile(id, planName(v)), { force: true }); }
          // the drafts of the older style-based generation are superseded by this run
          for (const v of LEGACY) { await rm(projectFile(id, cutName(v)), { force: true }); await rm(projectFile(id, planName(v)), { force: true }); }
          record.state = "done";
        } catch (error) {
          record.state = "failed"; record.error = `${error.message}。详细日志：projects/${id}/logs/director.log`;
        } finally { record.finishedAt = new Date().toISOString(); }
      });
    } finally { running.delete(id); }
  })();
  return record;
}

// Switches on one style: 常驻图标 on/off, 全屏 ⇄ 画中画. Edits that style's cut script and recompiles its draft; no model call.
export async function setOptions(id, variant, body) {
  if (running.has(id)) throw conflict("自动导演正在运行");
  if (!ORDER.includes(variant)) throw badRequest(`没有这套方案：${variant}`);
  const file = projectFile(id, cutName(variant));
  const cut = await readJson(file, null);
  if (!cut) throw badRequest("这套方案还没有生成");
  if (typeof body.logo === "boolean") {
    if (!body.logo) delete cut.logo;
    else if (!cut.logo) {
      const brief = await readJson(projectFile(id, "brief.json"), null);
      const product = String(brief?.product?.name ?? id).split(/[\s-]+/)[0].replace(/[^a-z0-9]/gi, "");
      const beat = product ? cut.beats.find((b) => new RegExp(product, "i").test(b.text)) : null;
      if (!beat) throw badRequest("口播里没有出现产品名，不知道图标该从哪里开始");
      cut.logo = { beat: beat.id, atMs: 300, position: "top-left" };
    }
  }
  if (body.layout === "full" || body.layout === "pip") {
    const slots = ["top-right", "top-left", "lower-right", "lower-left"];
    let n = 0;
    for (const [bi, b] of cut.beats.entries()) for (const s of b.broll) {
      if (body.layout === "full" || bi === cut.beats.length - 1) { s.layout = "full"; delete s.slot; } // the closing card stays full-screen
      else { s.layout = "pip"; s.slot = slots[n++ % 2]; }
    }
  }
  await writeJson(file, cut);
  await recompile(id, variant);
  return directorStatus(id);
}

// Rebuild one style's draft plan from its cut script (the voice master already exists, so this takes a few seconds).
export async function recompile(id, variant) {
  if (running.has(id)) throw conflict("自动导演正在运行");
  running.add(id);
  try {
    await mkdir(projectFile(id, "logs"), { recursive: true });
    const log = createWriteStream(projectFile(id, "logs", "director.log"), { flags: "a" });
    try { const [c, a] = node("scripts/compile-cut-script.mjs", id, `--file=${cutName(variant)}`, `--plan=${planName(variant)}`, "--force"); await runStep(c, a, log); }
    finally { log.end(); }
  } finally { running.delete(id); }
}

// The style the user tuned in the review desk (caption box/font/colours, theme, layout, loudness) survives a new draft;
// the content (assets, transcript, segments, overlays, emphasis, metadata) comes from the draft.
const mergeDraft = (draft, live) => {
  if (!live) return draft;
  const { revision, ...liveRest } = live;
  void revision;
  return {
    ...draft,
    output: liveRest.output, theme: liveRest.theme, layout: liveRest.layout, qc: liveRest.qc,
    audio: { ...draft.audio, loudness: liveRest.audio?.loudness ?? draft.audio.loudness },
    captions: liveRest.captions && draft.captions ? { ...liveRest.captions, emphasis: draft.captions.emphasis } : draft.captions,
  };
};

export async function applyDraft(id, { variant, expectedRevision } = {}) {
  if (running.has(id)) throw conflict("自动导演正在运行");
  if (!ORDER.includes(variant)) throw badRequest("请选一套方案");
  if (!(await exists(projectFile(id, planName(variant))))) throw badRequest("这套方案还没有草稿：先点「生成方案」");
  const draft = await readJson(projectFile(id, planName(variant)));
  // A snapshot of what the AI proposed, kept in the live plan's meta: after export, the editor's changes are measured against it
  // (scripts/lib/segments-final.mjs), even if the drafts are regenerated in between.
  const cutForSnapshot = await readJson(projectFile(id, cutName(variant)), null);
  const shotSig = (o) => `${o.props?.asset}|${o.from?.offsetMs}|${o.durationFrames}|${o.props?.x}|${o.props?.y}|${o.props?.width}|${o.props?.height}`;
  draft.meta = { ...(draft.meta ?? {}), appliedVariant: variant, aiPlan: { variant, at: new Date().toISOString(), beats: (cutForSnapshot?.beats ?? []).map((b) => {
    const seg = draft.segments.find((s) => s.id === b.id);
    return { id: b.id, text: b.text, lengthMs: Math.round(b.voice.ranges ? b.voice.ranges.reduce((t, [x, y]) => t + (y - x), 0) : b.voice.endMs - b.voice.startMs), zoom: seg?.camera?.zoom ?? 1, shots: (draft.overlays ?? []).filter((o) => o.effect === "video-clip@1" && o.from?.segment === b.id).map(shotSig) };
  }) } };
  const record = { ...(await readJson(runFile(id), { state: "idle" })) };
  running.add(id);
  try {
    const result = await withLock(id, async () => {
      const live = await readJson(projectFile(id, "edit-plan.json"), null);
      const liveRevision = live ? (live.revision ?? 0) : null;
      if (expectedRevision !== undefined && expectedRevision !== liveRevision) throw conflict(`审阅台里的方案已经是版本 ${liveRevision}，不是 ${expectedRevision}。刷新后再试。`);
      return installCompiledPlan(id, mergeDraft(draft, live), `自动导演：${slotLabel(await readJson(projectFile(id, cutName(variant)), null), variant)}${live ? `（保留你调过的字幕/主题样式；上一版本 ${liveRevision} 可在「版本」里还原）` : ""}`);
    });
    await track(id, { ...record, state: "running" }, async ({ log }) => {
      log.write("\n=== 生成预览和人脸检测 ===\n");
      for (const command of [node("scripts/make-proxy.mjs", id), node("scripts/detect-faces.mjs", id)]) await runStep(command[0], command[1], log);
    });
    await writeJson(runFile(id), { ...record, applied: { revision: result.revision, variant, at: new Date().toISOString() } });
    return { revision: result.revision, warnings: result.warnings?.length ?? 0 };
  } finally { running.delete(id); }
}

export const directorLog = async (id) => ((await exists(projectFile(id, "logs", "director.log"))) ? readFile(projectFile(id, "logs", "director.log"), "utf8") : "");

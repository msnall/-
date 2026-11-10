import { readFile } from "node:fs/promises";
import { SIMPLE_ROLES } from "../../src/engine/beat-roles.ts";
import { loadProjectInputs } from "../../scripts/lib/storyboard-files.mjs";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { footageThumb } from "./media.mjs";
import { withLock } from "./projects.mjs";
import { unprocessable } from "./errors.mjs";

const MODEL = "gpt-5.6-luna";
const KEY = "BEESWITCH_API_KEY";
const apiKey = () => process.env[KEY];

export async function classifyBeats(id) {
  const key = apiKey();
  if (!key) throw unprocessable("未配置 BeeSwitch API 密钥，请重启已读取 BEESWITCH_API_KEY 的工作台服务。");
  const { project, beats, transcript } = await loadProjectInputs(id);
  if (!beats?.beats.length) throw unprocessable("请先完成转录与段落切分");
  if (beats.confirmedAt) throw unprocessable("已确认的段落分类不能重新识别；历史方案保持不变。");
  const rows = beats.beats.map((beat, index) => ({ id: beat.id, text: beat.text, previous: beats.beats[index - 1]?.text ?? "", next: beats.beats[index + 1]?.text ?? "", startSeconds: Math.round((transcript.words[beat.words[0]]?.startMs ?? 0) / 100) / 10, position: Math.round(index / Math.max(1, beats.beats.length - 1) * 100) }));
  const prompt = `你是短视频口播分镜分析员。通读全部段落，结合每段文字、前后文、视频位置及提供的取样画面，为每段选择最贴切的角色。七类仅为 hook(开场), pain(痛点), benefit(卖点/产品/用量), proof(真实体验或证明), offer(优惠), cta(行动号召), filler(确实无明确语义的过渡)。不要因短句不完整就全部归为 filler，要结合上下文。不要把产品功效陈述当作已经核实的事实。输出严格 JSON：{"beats":[{"id":"b1","role":"hook","confidence":0.8,"alternatives":["benefit"]}]}。confidence 是你对分类的自评，不是统计校准概率；不确定时低于 0.75。必须覆盖所有 id，顺序一致。\n产品：${project.productName}\n段落：${JSON.stringify(rows)}`;
  const content = [{ type: "input_text", text: prompt }];
  const samples = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((value, index, all) => all.indexOf(value) === index);
  for (const index of samples) {
    try {
      const image = await readFile(await footageThumb(id, project.footage, Math.round(rows[index].startSeconds * 1000)));
      content.push({ type: "input_text", text: `取样画面：${rows[index].id}，约 ${rows[index].startSeconds} 秒` });
      content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${image.toString("base64")}` });
    } catch { /* Classify from transcript when a proxy or thumbnail is unavailable. */ }
  }
  const response = await fetch("https://api.beeswitch.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, input: [{ role: "user", content }], max_output_tokens: 4000 }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`BeeSwitch 分类请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  const answer = payload.output?.flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("") || payload.output_text;
  let parsed;
  try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("分类模型没有返回可解析的 JSON"); }
  if (!Array.isArray(parsed.beats) || parsed.beats.length !== beats.beats.length) throw new Error("分类模型返回的段落数量不匹配");
  const recommendations = new Map(parsed.beats.map((row) => [row.id, row]));
  for (const beat of beats.beats) {
    const row = recommendations.get(beat.id);
    if (!row || !SIMPLE_ROLES.includes(row.role) || typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) throw new Error(`分类模型返回了无效的 ${beat.id} 结果`);
  }
  const latest = await readJson(projectFile(id, "analysis/beats.json"));
  return withLock(id, async () => {
    const current = await readJson(projectFile(id, "analysis/beats.json"));
    if (JSON.stringify(current.beats.map((beat) => [beat.id, beat.words])) !== JSON.stringify(latest.beats.map((beat) => [beat.id, beat.words]))) throw new Error("段落在识别期间发生变化，请重试");
    const updated = { ...current, beats: current.beats.map((beat) => {
      const row = recommendations.get(beat.id);
      const manual = beat.classification?.source === "manual";
      const confidence = Math.round(row.confidence * 100) / 100;
      return { ...beat, role: manual ? beat.role : row.role, classification: { recommendedRole: row.role, confidence, source: manual ? "manual" : "ai", confirmed: manual ? beat.classification.confirmed : false, alternatives: (row.alternatives ?? []).filter((value) => SIMPLE_ROLES.includes(value)).slice(0, 2), model: MODEL, analyzedAt: new Date().toISOString() } };
    }) };
    await writeJson(projectFile(id, "analysis/beats.json"), updated);
    return updated;
  });
}

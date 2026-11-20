// AI describer for the asset catalog. This is the single place to connect a vision/LLM API.
//
// Contract: describeItem(item, { frames, catalog }) -> { category, description, tags, provider, model? }
//   item.type   "video" | "image" | "text"
//   frames      absolute paths of 4 JPEG key frames (video only)
//   item.body   script text (text items); item.context carries ingest facts, transcript path, tags
// Choose the provider with CATALOG_PROVIDER (default "heuristic"). To connect an API, add an entry
// to `providers` that calls it with the frames and returns the same shape; nothing else changes.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publicDir } from "../../scripts/lib/media.mjs";
import { HttpError } from "./errors.mjs";
import { callModel, readApiSettings } from "./settings.mjs";

const FRAMING = { closeup: "近景（脸和手机在画面里）", waist: "半身（腰部以上）" };

// Offline first pass from facts we already hold: ingest data, the brand's own usage notes, the transcript.
const heuristic = async (item) => {
  const c = item.context ?? {};
  if (item.type === "text") {
    const action = item.id.includes(".action.");
    return { category: "script", provider: "heuristic",
      description: action ? `达人动作要求：${item.body.replace(/\n/g, " ")}` : `台词：“${item.body}”${c.tone ? `。语气 ${c.tone}` : ""}${c.footage === "missing" ? "。目前没有对应口播，需要补拍。" : ""}`,
      tags: [action ? "动作要求" : "台词", c.candidate].filter(Boolean) };
  }
  if (c.group === "creator") {
    if (c.speech) {
      const words = JSON.parse(await readFile(path.join(publicDir, c.transcriptWords), "utf8"));
      const said = words.map((w) => w.text).join(" ");
      return { category: "talk", provider: "heuristic", tags: ["口播", c.framing ?? ""].filter(Boolean),
        description: `达人${FRAMING[c.framing] ?? ""}口播，约 ${(item.durationMs / 1000).toFixed(0)} 秒。说的是：“${said}”` };
    }
    return { category: "action", provider: "heuristic", tags: ["动作", "无人声", c.framing ?? ""].filter(Boolean),
      description: `达人${FRAMING[c.framing] ?? ""}画面，没有人声，约 ${(item.durationMs / 1000).toFixed(0)} 秒，可作动作镜头。具体动作需看画面确认。` };
  }
  return { category: "official", provider: "heuristic", tags: c.tags ?? [],
    description: c.usable ?? `官方素材 ${item.title}` };
};

const CATEGORY_IDS = ["script", "talk", "action", "screen", "official"];
const SYSTEM = `你是 TikTok 电商短视频的素材整理助手。根据给出的素材信息和关键帧，为剪辑师写一条素材描述。
分类只能是：script（文案/台词）、talk（达人对镜头口播）、action（达人手部/表情/拿手机等动作，无台词）、screen（我们自己录的软件或游戏操作录屏）、official（品牌方提供的素材）。
要求：
- 描述用中文，1-3 句，只写画面里看得见、信息里写明的内容：谁在做什么、景别、画面里的屏幕/主题/文字、适合放在视频的哪个位置。
- 不要编造产品功能、数字、评价；看不清就写“看不清”。
- 只输出一个 JSON 对象，不要其他文字：{"category":"...","description":"...","tags":["...","..."]}，tags 为 2-6 个简短中文或英文关键词。`;

const factsText = (item) => [
  `文件名：${item.title}`, `素材 ID：${item.id}`, `类型：${item.type}`,
  item.facts?.length ? `基本信息：${item.facts.join("，")}` : "",
  item.context?.usable ? `品牌说明：${item.context.usable}` : "",
  item.context?.tags?.length ? `品牌标签：${item.context.tags.join("，")}` : "",
  item.body ? `文案内容：${item.body}` : "",
  item.context?.tone ? `语气提示：${item.context.tone}` : "",
  `程序初判分类：${item.defaultCategory}`,
].filter(Boolean).join("\n");

const api = async (item, { frames }) => {
  const settings = await readApiSettings();
  const parts = [{ type: "text", text: factsText(item) }];
  if (item.context?.transcriptWords && item.context.speech) {
    const words = JSON.parse(await readFile(path.join(publicDir, item.context.transcriptWords), "utf8"));
    parts.push({ type: "text", text: `口播转录：${words.map((w) => w.text).join(" ")}` });
  }
  for (const frame of frames ?? []) parts.push({ type: "image", mediaType: "image/jpeg", data: (await readFile(frame)).toString("base64") });
  if (item.type === "image" && item.file) {
    const ext = path.extname(item.file).toLowerCase();
    parts.push({ type: "image", mediaType: ext === ".png" ? "image/png" : "image/jpeg", data: (await readFile(path.join(publicDir, item.file))).toString("base64") });
  }
  const out = await callModel({ system: SYSTEM, parts, settings });
  const json = /\{[\s\S]*\}/.exec(out.text)?.[0];
  let parsed; try { parsed = JSON.parse(json ?? ""); } catch { throw new Error(`模型返回的不是 JSON：${out.text.slice(0, 120)}`); }
  if (typeof parsed.description !== "string" || !parsed.description.trim()) throw new Error("模型没有返回 description");
  return { category: CATEGORY_IDS.includes(parsed.category) ? parsed.category : item.defaultCategory, description: parsed.description.trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 8) : [], provider: "api", model: out.model };
};

const providers = { heuristic, api };
const chosen = async () => process.env.CATALOG_PROVIDER ?? ((await readApiSettings()).apiKey ? "api" : "heuristic");

export const providerInfo = async () => {
  const name = await chosen();
  const settings = await readApiSettings();
  return { name, available: Object.keys(providers), model: name === "api" ? settings.model : null, baseUrl: name === "api" ? settings.baseUrl : null,
    note: name === "heuristic" ? "离线草稿：只用已有信息（品牌说明、转录、文件信息），没有看画面。到「API 设置」保存 Key 后改用模型看画面描述。" : "" };
};

export async function describeItem(item, context) {
  const name = await chosen();
  const provider = providers[name];
  if (!provider) throw new HttpError(501, `描述服务 "${name}" 尚未接入（可用：${Object.keys(providers).join("、")}）`);
  const out = await provider(item, context);
  if (!out?.description) throw new Error("描述服务没有返回 description");
  return { category: out.category, description: out.description, tags: out.tags ?? [], provider: out.provider ?? name, model: out.model ?? null };
}

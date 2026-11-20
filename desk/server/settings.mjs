// Local desk settings (API connection). Stored in .local/desk-settings.json, which is gitignored.
// The API key is write-only through the API: it is never sent back to the page, only whether one
// is saved and its last four characters.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest } from "./errors.mjs";

const file = path.join(root, ".local", "desk-settings.json");
export const API_DEFAULTS = { baseUrl: "https://api.beeswitch.com", model: "anthropic.claude-sonnet-5-5", format: "anthropic", maxTokens: 1024, timeoutSec: 90 };
const FORMATS = ["anthropic", "openai"];

export async function readApiSettings() {
  const stored = (await readJson(file, {})).api ?? {};
  return { ...API_DEFAULTS, ...stored, apiKey: stored.apiKey ?? "" };
}

export async function publicApiSettings() {
  const { apiKey, ...rest } = await readApiSettings();
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `…${apiKey.slice(-4)}` : "", defaults: API_DEFAULTS, file: ".local/desk-settings.json" };
}

export async function saveApiSettings(body) {
  const current = await readApiSettings();
  const next = { ...current };
  if (body.baseUrl !== undefined) {
    let url;
    try { url = new URL(String(body.baseUrl).trim()); } catch { throw badRequest("Base URL 不是有效网址"); }
    if (!/^https?:$/.test(url.protocol)) throw badRequest("Base URL 必须以 http:// 或 https:// 开头");
    next.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
  }
  if (body.model !== undefined) { if (!String(body.model).trim()) throw badRequest("模型名不能为空"); next.model = String(body.model).trim(); }
  if (body.format !== undefined) { if (!FORMATS.includes(body.format)) throw badRequest(`接口格式只能是 ${FORMATS.join(" / ")}`); next.format = body.format; }
  for (const [key, min, max] of [["maxTokens", 64, 8192], ["timeoutSec", 5, 600]]) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${key} 需要是 ${min}–${max} 的整数`);
    next[key] = n;
  }
  if (body.apiKey !== undefined) next.apiKey = String(body.apiKey).trim(); // "" clears the key
  await mkdir(path.dirname(file), { recursive: true });
  const stored = await readJson(file, {});
  await writeJson(file, { ...stored, api: next, updatedAt: new Date().toISOString() });
  return publicApiSettings();
}

// One chat call to the relay. `content` is a list of {type:"text",text} | {type:"image",path→base64 given as data}.
// Returns the model's text. Throws Error with a readable message on HTTP/network failure.
// Optional: temperature, and tool = { name, description, schema } to ask for the answer as a tool call (structured output). Relays that
// reject either with a 400 get the same request again without them; the caller still validates the JSON it receives.
// cache: true marks the system prompt for prompt caching (the relay accepts it; whether it hits is the relay's business).
// Measured on the beeswitch relay (2026-11): tool_choice "auto" works, a forced tool_choice and `temperature` are rejected with 400.
export async function callModel({ system, parts, settings, temperature, tool, cache }) {
  const s = settings ?? await readApiSettings();
  if (!s.apiKey) throw new Error("还没有保存 API Key（设置 → API）");
  const base = s.baseUrl.replace(/\/v1$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.timeoutSec * 1000);
  const started = Date.now();
  try {
    let url, headers, body;
    if (s.format === "openai") {
      url = `${base}/v1/chat/completions`;
      headers = { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` };
      body = { model: s.model, max_tokens: s.maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: parts.map((p) => p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }) }] };
    } else {
      url = `${base}/v1/messages`;
      headers = { "content-type": "application/json", "x-api-key": s.apiKey, "anthropic-version": "2023-06-01" };
      body = { model: s.model, max_tokens: s.maxTokens, system, messages: [{ role: "user", content: parts.map((p) => p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } }) }] };
    }
    if (s.format !== "openai") {
      if (temperature !== undefined) body.temperature = temperature;
      if (cache) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      if (tool) { body.tools = [{ name: tool.name, description: tool.description ?? tool.name, input_schema: tool.schema }]; body.tool_choice = { type: "auto" }; }
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok && response.status === 400 && s.format !== "openai" && (tool || temperature !== undefined)) return callModel({ system, parts, settings: s });
    if (!response.ok) throw new Error(`接口返回 ${response.status}：${(data?.error?.message ?? data?.error ?? raw).toString().slice(0, 300)}`);
    const toolUse = data?.content?.find?.((b) => b.type === "tool_use");
    const text = toolUse ? JSON.stringify(toolUse.input) : s.format === "openai" ? data?.choices?.[0]?.message?.content : data?.content?.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text) {
      // The model sometimes spends the whole token budget on (hidden) thinking and returns no text block: retry once with a bigger budget.
      if (data?.stop_reason === "max_tokens" && !settings?._retried && s.maxTokens < 16000) return callModel({ system, parts, temperature, tool, cache, settings: { ...s, maxTokens: Math.min(16000, s.maxTokens * 2), _retried: true } });
      throw new Error(`接口没有返回文本（stop_reason=${data?.stop_reason ?? "?"}）：${raw.slice(0, 200)}`);
    }
    return { text, ms: Date.now() - started, model: data?.model ?? s.model };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`请求超过 ${s.timeoutSec} 秒没有响应`);
    if (error.cause?.code) throw new Error(`连接失败（${error.cause.code}）：${s.baseUrl}`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function testApi() {
  const settings = await readApiSettings();
  if (!settings.apiKey) return { ok: false, error: "还没有保存 API Key" };
  try {
    const out = await callModel({ system: "Reply with the single word: pong", parts: [{ type: "text", text: "ping" }], settings: { ...settings, maxTokens: 32 } });
    return { ok: true, ms: out.ms, model: out.model, reply: out.text.slice(0, 80) };
  } catch (error) { return { ok: false, error: error.message }; }
}

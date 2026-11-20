import { useEffect, useState } from "react";
import { ArrowLeft, PlugZap, Save } from "lucide-react";
import { settingsApi, type ApiSettings } from "./api.ts";

// API 设置：素材描述（以及之后的 AI 功能）通过中转站调用模型。Key 只存本机 .local/，不会进 Git，也不会回传到页面。

type Test = { ok: boolean; ms?: number; model?: string; reply?: string; error?: string } | null;

export const SettingsDesk: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [saved, setSaved] = useState<ApiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [format, setFormat] = useState<"anthropic" | "openai">("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [timeoutSec, setTimeoutSec] = useState("90");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<Test>(null);
  const apply = (s: ApiSettings) => { setSaved(s); setBaseUrl(s.baseUrl); setModel(s.model); setFormat(s.format); setMaxTokens(String(s.maxTokens)); setTimeoutSec(String(s.timeoutSec)); };
  useEffect(() => { settingsApi.get().then(apply).catch((error) => setMessage(error.message)); }, []);
  if (!saved) return <div className="loading">{message || "加载中…"}</div>;
  const dirty = baseUrl !== saved.baseUrl || model !== saved.model || format !== saved.format || apiKey !== "" || maxTokens !== String(saved.maxTokens) || timeoutSec !== String(saved.timeoutSec);
  const save = async (clearKey = false) => {
    setBusy(true); setMessage(""); setTest(null);
    try {
      const next = await settingsApi.save({ baseUrl, model, format, maxTokens: Number(maxTokens), timeoutSec: Number(timeoutSec), ...(clearKey ? { apiKey: "" } : apiKey ? { apiKey } : {}) });
      apply(next); setApiKey(""); setMessage(clearKey ? "已清除 API Key" : "已保存");
      return true;
    } catch (error) { setMessage((error as Error).message); return false; } finally { setBusy(false); }
  };
  const runTest = async () => {
    if (dirty && !(await save())) return;
    setBusy(true); setTest(null);
    try { setTest(await settingsApi.test()); } catch (error) { setTest({ ok: false, error: (error as Error).message }); } finally { setBusy(false); }
  };
  const reset = () => { setBaseUrl(saved.defaults.baseUrl); setModel(saved.defaults.model); setFormat(saved.defaults.format); setMaxTokens(String(saved.defaults.maxTokens)); setTimeoutSec(String(saved.defaults.timeoutSec)); };
  return <div className="settings-page">
    <header className="catalog-header"><button onClick={onBack}><ArrowLeft size={15} /> 返回</button><div><span className="eyebrow">SETTINGS</span><h1>API 设置</h1></div></header>
    <main className="settings-card">
      <p className="catalog-provider">用于“素材分类”的 AI 描述：把素材信息和 4 张关键帧发给下面的模型，返回分类和描述草稿。默认使用中转站的 Claude Sonnet 5.5。</p>
      <label>接口地址（Base URL）<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
      <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} /></label>
      <label>接口格式<select value={format} onChange={(event) => setFormat(event.target.value as "anthropic" | "openai")}><option value="anthropic">Anthropic（/v1/messages，x-api-key）</option><option value="openai">OpenAI 兼容（/v1/chat/completions，Bearer）</option></select><small>中转站按哪种格式提供就选哪种；默认 Anthropic。测试连接失败时可以换另一种试。</small></label>
      <label>API Key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={saved.hasKey ? `已保存（${saved.keyHint}），留空表示不修改` : "粘贴中转站的 Key"} spellCheck={false} /><small>只保存在本机 <code>{saved.file}</code>（已加入 .gitignore）。保存后不会再显示。</small></label>
      <div className="settings-row"><label>最大输出 tokens<input type="number" min={64} max={8192} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label><label>超时（秒）<input type="number" min={5} max={600} value={timeoutSec} onChange={(event) => setTimeoutSec(event.target.value)} /></label></div>
      <div className="catalog-actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => save()}><Save size={14} /> 保存</button>
        <button disabled={busy || (!saved.hasKey && !apiKey)} onClick={runTest}><PlugZap size={14} /> 保存并测试连接</button>
        <button disabled={busy} onClick={reset}>恢复默认地址和模型</button>
        {saved.hasKey ? <button disabled={busy} onClick={() => save(true)}>清除 Key</button> : null}
      </div>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {test ? <p className={`notice ${test.ok ? "settings-ok" : "settings-bad"}`} role="status">{test.ok ? `连接成功：${test.model}，用时 ${((test.ms ?? 0) / 1000).toFixed(1)} 秒，回复“${test.reply}”` : `连接失败：${test.error}`}</p> : null}
      <p className="catalog-hint">状态：{saved.hasKey ? "已保存 Key，素材分类将用模型描述" : "未保存 Key，素材分类使用离线草稿"}。</p>
    </main>
  </div>;
};

import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { confirmBox } from "./confirm.ts";
import { styleApi, type RoleV2, type StyleCardV2, type StyleDetail } from "./api.ts";

// 风格卡 v2：一个预先填好的「创意方向」加一份示范方案。四个标签：概览 / 时间线 / 规则 / 技巧支持。
// 数字（measured）全部由程序按时间线算出，不用手填；改时间线保存后会重算。

export const HOOK: Record<string, string> = { creator_punch: "达人冲击推近开场", pip_hook: "画中画引入开场", slow_tension: "缓推悬念开场", color_hook: "彩字关键词开场" };
export const STRUCTURE: Record<string, string> = { problem: "痛点重心", product_demo: "产品演示重心", result: "结果重心", story: "故事重心" };
export const PACING: Record<string, string> = { fast: "快节奏", medium: "中速", calm: "舒缓" };
export const PLACEMENT: Record<string, string> = { front_loaded: "插画前置", demo_cluster: "演示集中", spread: "插画分散" };
export const LAYOUT: Record<string, string> = { full: "全屏插画", pip: "画中画", mixed: "全屏和画中画混用" };
export const ZOOM_PATTERN: Record<string, string> = { alternate: "推近交替", build_up: "逐步推近", peaks_only: "仅峰值推近" };
export const ROLE2: Record<RoleV2, string> = { hook: "钩子", problem: "痛点", product_intro: "产品引入", demo: "演示", benefit: "好处", proof: "证明", cta: "行动号召" };
const ROLE_COLOR: Record<RoleV2, string> = { hook: "#e79a3c", problem: "#d9534f", product_intro: "#4f7fe0", demo: "#2b8fb3", benefit: "#2f9e6d", proof: "#7a5ac8", cta: "#c24b8a" };
const VISUAL: Record<string, string> = { talk: "达人", broll: "插画" };
const ASSET: Record<string, string> = { screen_recording: "录屏", product_shot: "产品图", action_clip: "动作镜头", end_card: "结尾卡", text_card: "文字卡", other: "其他" };
const SUPPORT: Record<string, string> = { ready: "已支持", partial: "部分支持", unsupported: "暂不支持" };
const FORMAT: Record<string, string> = { single_creator_talking: "单人口播", reaction: "反应型", comparison: "对比型", list: "清单型", story: "剧情型" };
const ZOOMS = ["z100", "z110", "z115", "z120"];
export const directionLine = (d: StyleCardV2["direction"]) => `${HOOK[d.hookTreatment] ?? d.hookTreatment}｜${PACING[d.pacing] ?? d.pacing}｜${PLACEMENT[d.brollPlacement] ?? d.brollPlacement}｜${LAYOUT[d.layoutBias] ?? d.layoutBias}｜${ZOOM_PATTERN[d.zoomPattern] ?? d.zoomPattern}`;
const sec = (ms: number) => (ms / 1000).toFixed(1);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);

const Sel: React.FC<{ label: string; value: string; options: Record<string, string>; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => <label className="sc-field">{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{Object.entries(options).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>;
const Nu: React.FC<{ label: string; value: number; step?: number; onChange: (v: number) => void }> = ({ label, value, step = 100, onChange }) => <label className="sc-field">{label}<input type="number" step={step} value={value} onChange={(e) => onChange(num(e.target.value, value))} /></label>;

type Tab = "overview" | "timeline" | "rules" | "tech";

export const CardEditorV2: React.FC<{ detail: StyleDetail; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void }> = ({ detail, onChanged, onDeleted, onError }) => {
  const [card, setCard] = useState<StyleCardV2>(detail.card as StyleCardV2);
  const [tab, setTab] = useState<Tab>("overview");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCard(detail.card as StyleCardV2); setDirty(false); }, [detail.card]);
  const change = <K extends keyof StyleCardV2>(key: K, value: StyleCardV2[K]) => { setCard((c) => ({ ...c, [key]: value })); setDirty(true); };
  const save = async () => { const saved = (await styleApi.save(card.id, card)) as unknown as StyleCardV2; setCard(saved); setDirty(false); onChanged(); return saved; };
  const act = async (task: () => Promise<unknown>) => { setBusy(true); try { await task(); } catch (e) { const err = e as Error & { problems?: string[] }; onError([err.message, ...(err.problems ?? [])].join(" ")); } finally { setBusy(false); } };
  const a = detail.analysis;
  const total = card.source.durationMs || a?.facts.durationMs || 1;
  const m = card.measured;
  const setSeg = (i: number, part: Partial<StyleCardV2["timeline"][number]>) => change("timeline", card.timeline.map((r, k) => (k === i ? { ...r, ...part } : r)));
  const setStruct = (i: number, part: Partial<StyleCardV2["structure"][number]>) => change("structure", card.structure.map((r, k) => (k === i ? { ...r, ...part } : r)));
  const st = card.selfTest;
  const used = detail.insights?.usedBy ?? [];

  return <div className="sc-editor">
    <div className="sc-top">
      <input className="sc-name" value={card.name} onChange={(e) => change("name", e.target.value)} aria-label="风格卡名称" placeholder="给这张卡起个名" />
      <span className={`sc-status ${card.status}`}>{card.status === "confirmed" ? "已确认" : dirty ? "有未保存的修改" : "草稿：确认后才能用于出方案"}</span>
      <button disabled={busy || !dirty} onClick={() => act(save)}>保存修改</button>
      <button className="primary" disabled={busy || (card.status === "confirmed" && !dirty)} onClick={() => act(async () => { if (dirty) await save(); await styleApi.confirm(card.id, card.name); onChanged(); })}>{card.status === "confirmed" ? "改完重新确认" : "确认并存入风格库"}</button>
      {card.source.referenceId ? <button disabled={busy} title="重新拆解这条成品（已确认的卡不会被覆盖，会生成新卡）" onClick={() => act(async () => { await styleApi.relearn(card.source.referenceId); onChanged(); })}><RefreshCw size={14} /> 重新拆解</button> : null}
      <button disabled={busy} title="删除这张卡" onClick={async () => { if (await confirmBox(`删除风格卡「${card.name}」？删除后不能恢复。`, { yes: "删除" })) act(async () => { await styleApi.remove(card.id); onDeleted(); }); }}><Trash2 size={14} /></button>
    </div>
    <nav className="plan-tabs sc-tabs" aria-label="风格卡内容">{([["overview", "概览"], ["timeline", "时间线"], ["rules", "规则"], ["tech", `技巧支持${card.techniques.some((t) => t.support !== "ready") ? `（${card.techniques.filter((t) => t.support !== "ready").length} 项待开发）` : ""}`]] as [Tab, string][]).map(([k, t]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}><b>{t}</b></button>)}</nav>

    {tab === "overview" ? <>
      <p className="sc-direction"><b>{directionLine(card.direction)}</b></p>
      <label className="sc-field wide">整体风格<textarea rows={2} value={card.summary_zh} onChange={(e) => change("summary_zh", e.target.value)} /></label>
      <section className="sc-panel"><header><h3>复现度</h3><span>用参考视频自己的口播，按这张卡出一次方案，和参考视频比</span></header>
        {st ? <p className="sc-repro"><b>插画位置重合 {pct(st.brollOverlap)}</b> 推近一致 {pct(st.zoomSame)} 插画占比 参考 {pct(st.brollRatioRef)} / 方案 {pct(st.brollRatioPlan)}<small>{st.note}（{st.at.slice(0, 16).replace("T", " ")}）</small></p> : <p className="catalog-hint">还没有自测。</p>}
        <div className="catalog-actions"><button disabled={busy} onClick={() => act(async () => { await styleApi.selftest(card.id); onChanged(); })}>{busy ? "自测中…（约 1 分钟）" : st ? "重新自测" : "自测复现度"}</button></div>
        <p className="catalog-hint">复现度低，说明卡没写准，或者效果清单缺东西（看「技巧支持」里暂不支持的项）。</p>
      </section>
      <section className="sc-panel"><header><h3>方向</h3><span>和出方案时的「创意方向」是同一套字段，选了这张卡，「照卡」那一套直接用它</span></header>
        <div className="sc-fields">
          <Sel label="开场处理" value={card.direction.hookTreatment} options={HOOK} onChange={(v) => change("direction", { ...card.direction, hookTreatment: v })} />
          <Sel label="结构重心" value={card.direction.structureEmphasis} options={STRUCTURE} onChange={(v) => change("direction", { ...card.direction, structureEmphasis: v })} />
          <Sel label="节奏" value={card.direction.pacing} options={PACING} onChange={(v) => change("direction", { ...card.direction, pacing: v })} />
          <Sel label="插画位置" value={card.direction.brollPlacement} options={PLACEMENT} onChange={(v) => change("direction", { ...card.direction, brollPlacement: v })} />
          <Sel label="版式" value={card.direction.layoutBias} options={LAYOUT} onChange={(v) => change("direction", { ...card.direction, layoutBias: v })} />
          <Sel label="推近方式" value={card.direction.zoomPattern} options={ZOOM_PATTERN} onChange={(v) => change("direction", { ...card.direction, zoomPattern: v })} />
          <Nu label="插画占比目标（0–1）" value={card.direction.brollRatioTarget} step={0.05} onChange={(v) => change("direction", { ...card.direction, brollRatioTarget: v })} />
        </div></section>
      <section className="sc-panel"><header><h3>程序测出的数字</h3><span>由时间线算出，不用手填；改时间线保存后自动重算</span></header>
        <div className="sc-measured">
          <span><b>{m.cutCount}</b>切点</span><span><b>{sec(m.avgShotMs)}s</b>平均镜头</span><span><b>{sec(m.medianShotMs)}s</b>中位镜头</span><span><b>{sec(m.maxStaticMs)}s</b>最长不变画面</span>
          <span><b>{sec(m.firstBrollMs)}s</b>第一次插画</span><span><b>{pct(m.brollRatio)}</b>插画占比</span><span><b>{pct(m.fullRatio)}</b>其中全屏</span><span><b>{pct(m.pipRatio)}</b>其中画中画</span><span><b>{m.zoomChangesPerTalkBeat}</b>推近变化/达人镜头</span>
        </div></section>
      <section className="sc-panel"><header><h3>节奏数字</h3><span>覆盖出方案时节奏预设的数字（由测量推出，可以改）</span></header>
        <div className="sc-fields">
          <Nu label="全屏插画最早（ms）" value={card.presetOverrides.noFullBrollBeforeMs} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, noFullBrollBeforeMs: v })} />
          <Nu label="画中画最早（ms）" value={card.presetOverrides.noPipBeforeMs} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, noPipBeforeMs: v })} />
          <Nu label="镜头最短（ms）" value={card.presetOverrides.minShotMs} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, minShotMs: v })} />
          <Nu label="镜头最长（ms）" value={card.presetOverrides.maxShotMs} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, maxShotMs: v })} />
          <Nu label="插画占比上限（0–1）" value={card.presetOverrides.maxBrollRatio} step={0.05} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, maxBrollRatio: v })} />
          <Nu label="画面最长不变（ms）" value={card.presetOverrides.maxStaticMs} onChange={(v) => change("presetOverrides", { ...card.presetOverrides, maxStaticMs: v })} />
        </div></section>
      <section className="sc-panel"><header><h3>标签</h3><span>出方案选卡时按这些排序</span></header>
        <div className="sc-fields">
          <Sel label="产品类型" value={card.meta.productType} options={{ app: "App", physical: "实物" }} onChange={(v) => change("meta", { ...card.meta, productType: v as "app" | "physical" })} />
          <Sel label="视频形式" value={card.meta.format} options={FORMAT} onChange={(v) => change("meta", { ...card.meta, format: v })} />
          <label className="sc-field">标签（逗号分隔）<input value={card.meta.tags_zh.join("，")} onChange={(e) => change("meta", { ...card.meta, tags_zh: e.target.value.split(/[,，、\s]+/).filter(Boolean) })} /></label>
        </div></section>
      <p className="catalog-hint">用过这张卡的项目：{used.length ? used.join("、") : "还没有"}。{card.model ? ` 草稿由 ${card.model} 生成，请对照视频核对。` : ""}</p>
    </> : null}

    {tab === "timeline" ? <>
      <section className="sc-source">
        <div className="sc-bar" aria-label="按时间的结构">{card.structure.map((s, i) => <span key={i} style={{ left: `${(s.startMs / total) * 100}%`, width: `${((s.endMs - s.startMs) / total) * 100}%`, background: ROLE_COLOR[s.role] }} title={`${ROLE2[s.role]} ${sec(s.startMs)}–${sec(s.endMs)}s`}>{ROLE2[s.role]}</span>)}</div>
        {a ? <div className="tech-frames">{a.frames.map((t) => <img key={t} loading="lazy" title={`${t}s`} src={styleApi.frameUrl(card.source.referenceId, t)} alt="" />)}</div> : null}
        <p className="catalog-hint">来源：{card.source.title} · {sec(total)} 秒 · 这条参考视频被拆成 {card.timeline.length} 段，每段的画面、版式、推近都可以改，改完保存，上面的数字会重算。</p>
      </section>
      <div className="sc-rows">{card.timeline.map((r, i) => <div key={i} className="sc-row sc-seg">
        <span className="sc-time">{sec(r.startMs)}–{sec(r.endMs)}s</span>
        <select value={r.role} onChange={(e) => setSeg(i, { role: e.target.value as RoleV2 })}>{(Object.keys(ROLE2) as RoleV2[]).map((k) => <option key={k} value={k}>{ROLE2[k]}</option>)}</select>
        <select value={r.visual} onChange={(e) => setSeg(i, { visual: e.target.value as "talk" | "broll", ...(e.target.value === "broll" ? { zoom: undefined } : {}) })}>{Object.entries(VISUAL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        <select value={r.layout ?? ""} onChange={(e) => setSeg(i, { layout: (e.target.value || undefined) as "full" | "pip" | undefined })}><option value="">无窗口</option><option value="full">全屏</option><option value="pip">画中画</option></select>
        <select value={r.zoom ?? ""} disabled={r.visual === "broll"} onChange={(e) => setSeg(i, { zoom: e.target.value || undefined })}><option value="">—</option>{ZOOMS.map((z) => <option key={z} value={z}>{z.replace("z", "")}%</option>)}</select>
        <select value={r.assetType ?? ""} onChange={(e) => setSeg(i, { assetType: e.target.value || undefined })}><option value="">—</option>{Object.entries(ASSET).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        <input className="grow2" value={r.what_zh} onChange={(e) => setSeg(i, { what_zh: e.target.value })} />
      </div>)}</div>
    </> : null}

    {tab === "rules" ? <>
      <section className="sc-panel"><header><h3>给自动导演的规则</h3><span>英文，每行一条，最多 8 条，不能出现产品名和产品功能；确认后写进出方案提示</span></header>
        <textarea rows={8} value={card.directorRules.join("\n")} onChange={(e) => change("directorRules", e.target.value.split("\n").filter((l) => l.trim()))} />
        <p className="catalog-hint">{card.directorRules.length} / 8 条。{card.productTerms.length ? `参考视频的产品词（规则里不能出现）：${card.productTerms.join("、")}` : ""}</p></section>
      <section className="sc-panel"><header><h3>结构</h3><span>只用通用角色；这里的剪法说明也会交给自动导演</span></header>
        <div className="sc-rows">{card.structure.map((r, i) => <div key={i} className="sc-row">
          <select value={r.role} onChange={(e) => setStruct(i, { role: e.target.value as RoleV2 })}>{(Object.keys(ROLE2) as RoleV2[]).map((k) => <option key={k} value={k}>{ROLE2[k]}</option>)}</select>
          <input type="number" step={0.1} value={Number((r.startMs / 1000).toFixed(1))} onChange={(e) => setStruct(i, { startMs: Math.round(num(e.target.value, r.startMs / 1000) * 1000) })} aria-label="开始秒" /><i>–</i>
          <input type="number" step={0.1} value={Number((r.endMs / 1000).toFixed(1))} onChange={(e) => setStruct(i, { endMs: Math.round(num(e.target.value, r.endMs / 1000) * 1000) })} aria-label="结束秒" /><span>秒</span>
          <input className="grow2" value={r.technique_zh} onChange={(e) => setStruct(i, { technique_zh: e.target.value })} />
        </div>)}</div></section>
      <section className="sc-panel sc-gray"><header><h3>只属于参考视频的内容</h3><span>只作参考，不会交给自动导演</span></header>
        <textarea rows={3} value={card.contentSpecific_zh} onChange={(e) => change("contentSpecific_zh", e.target.value)} /></section>
      <section className="sc-panel sc-gray"><header><h3>字幕和包装（只记录）</h3><span>字幕样式走主题，包装（贴纸、音效、音乐）在剪映里补；都不交给模型</span></header>
        <p className="catalog-hint">字幕：位置 {card.captions.position}，{card.captions.case}，每块 {card.captions.wordsPerBlock} 个词，强调：{card.captions.emphasis || "—"}</p>
        <textarea rows={2} value={card.packaging_zh} onChange={(e) => change("packaging_zh", e.target.value)} /></section>
    </> : null}

    {tab === "tech" ? <>
      {(["ready", "partial", "unsupported"] as const).map((level) => {
        const list = card.techniques.filter((t) => t.support === level);
        return <section key={level} className="sc-panel"><header><h3>{SUPPORT[level]}（{list.length}）</h3><span>{level === "ready" ? "渲染引擎现在能做" : level === "partial" ? "只能近似做到" : "引擎还做不到，是渲染开发的待办"}</span></header>
          {list.length ? list.map((t) => <p key={t.name_zh} className={`sc-support ${level === "ready" ? "supported" : level === "partial" ? "partial" : "needs-effect"}`}><b>{t.name_zh}</b>{t.effectId ? `（${t.effectId}）` : ""} 参考视频 {t.evidenceMs.map((x) => `${sec(x)}s`).join("、")}</p>) : <p className="catalog-hint">没有。</p>}</section>;
      })}
    </> : null}
  </div>;
};

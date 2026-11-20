import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Trash2 } from "lucide-react";
import { confirmBox } from "./confirm.ts";
import { styleApi, type StyleBrief, type StyleCard, type StyleDetail, type StyleRole, type StyleRun } from "./api.ts";
import { CardEditorV2, HOOK, PACING } from "./StyleCardV2.tsx";

// 风格库：拆解一条成品 → 模型写一张风格卡 → 你按六栏改 → 起名确认。只有「已确认」的卡能用于出方案。

const ROLE: Record<StyleRole, string> = { hook: "钩子", pain: "痛点", demo: "产品演示", proof: "证明", benefit: "卖点", cta: "行动号召", other: "其他" };
const ROLE_COLOR: Record<StyleRole, string> = { hook: "#e79a3c", pain: "#d9534f", demo: "#4f7fe0", proof: "#7a5ac8", benefit: "#2f9e6d", cta: "#c24b8a", other: "#8d94a3" };
const LEVEL: Record<string, string> = { supported: "引擎已支持", partial: "部分支持", "needs-effect": "引擎暂不支持" };
const sec = (ms: number) => (ms / 1000).toFixed(1);
const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);

type Section = "structure" | "rhythm" | "camera" | "captions" | "inserts" | "packaging";

const Check: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => <label className="sc-check"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
const Text: React.FC<{ label: string; value: string; onChange: (v: string) => void; rows?: number }> = ({ label, value, onChange, rows }) => <label className="sc-field">{label}{rows ? <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} /> : <input value={value} onChange={(e) => onChange(e.target.value)} />}</label>;
const Num: React.FC<{ label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string }> = ({ label, value, onChange, step = 1, unit }) => <label className="sc-field">{label}{unit ? `（${unit}）` : ""}<input type="number" step={step} value={value} onChange={(e) => onChange(num(e.target.value, value))} /></label>;
const Pair: React.FC<{ label: string; value: [number, number]; onChange: (v: [number, number]) => void; step?: number; unit?: string }> = ({ label, value, onChange, step = 1, unit }) => <label className="sc-field">{label}{unit ? `（${unit}）` : ""}<span className="sc-pair"><input type="number" step={step} value={value[0]} onChange={(e) => onChange([num(e.target.value, value[0]), value[1]])} /><i>–</i><input type="number" step={step} value={value[1]} onChange={(e) => onChange([value[0], num(e.target.value, value[1])])} /></span></label>;
const Pick: React.FC<{ label: string; value: string; options: [string, string][]; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => <label className="sc-field">{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>;

const Panel: React.FC<{ title: string; hint: string; support: StyleCard["support"]; area: string; children: React.ReactNode }> = ({ title, hint, support, area, children }) => <section className="sc-panel">
  <header><h3>{title}</h3><span>{hint}</span></header>
  <div className="sc-fields">{children}</div>
  {support.filter((s) => s.area === area).map((s) => <p key={s.feature} className={`sc-support ${s.level}`} title={s.note}><b>{LEVEL[s.level]}</b> {s.feature}{s.note ? ` — ${s.note}` : ""}</p>)}
</section>;

const CardEditor: React.FC<{ detail: StyleDetail & { card: StyleCard }; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void }> = ({ detail, onChanged, onDeleted, onError }) => {
  const [card, setCard] = useState<StyleCard>(detail.card);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCard(detail.card); setDirty(false); }, [detail.card]);
  const change = <K extends keyof StyleCard>(key: K, value: StyleCard[K]) => { setCard((c) => ({ ...c, [key]: value })); setDirty(true); };
  const patch = <K extends Section>(key: K, part: Partial<StyleCard[K]>) => change(key, { ...(card[key] as object), ...(part as object) } as StyleCard[K]);
  const save = async () => { const saved = await styleApi.save(card.id, card); setCard(saved); setDirty(false); onChanged(); return saved; };
  const act = async (task: () => Promise<unknown>) => { setBusy(true); try { await task(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  const a = detail.analysis;
  const total = a?.facts.durationMs ?? detail.card.source.durationMs ?? 1;
  const setRow = (i: number, part: Partial<StyleCard["structure"][number]>) => change("structure", card.structure.map((r, k) => (k === i ? { ...r, ...part } : r)));
  return <div className="sc-editor">
    <p className="notice settings-bad">这是旧格式的风格卡：里面混着参考视频的产品内容，也没有测量数字和示范方案。点「重新拆解」生成新格式（旧卡保留不删）。</p>
    <div className="sc-top">
      <input className="sc-name" value={card.name} onChange={(e) => change("name", e.target.value)} aria-label="风格卡名称" placeholder="给这张卡起个名，如 kika-UGC快节奏" />
      <span className={`sc-status ${card.status}`}>{card.status === "confirmed" ? "已确认" : dirty ? "有未保存的修改" : "草稿：确认后才能用于出方案"}</span>
      <button disabled={busy || !dirty} onClick={() => act(save)}>保存修改</button>
      <button className="primary" disabled={busy || (card.status === "confirmed" && !dirty)} onClick={() => act(async () => { if (dirty) await save(); await styleApi.confirm(card.id, card.name); onChanged(); })}>{card.status === "confirmed" ? "改完重新确认" : "确认并存入风格库"}</button>
      {card.source.referenceId ? <button disabled={busy} title="重新让模型看一遍这条成品（会替换草稿；已确认的卡不会被覆盖）" onClick={() => act(async () => { await styleApi.relearn(card.source.referenceId); onChanged(); })}><RefreshCw size={14} /> 重新拆解</button> : null}
      <button disabled={busy} title="删除这张卡" onClick={async () => { if (await confirmBox(`删除风格卡「${card.name}」？删除后不能恢复。`, { yes: "删除" })) act(async () => { await styleApi.remove(card.id); onDeleted(); }); }}><Trash2 size={14} /></button>
    </div>
    <label className="sc-field wide">整体风格（一句话描述，会给你自己看）<textarea rows={2} value={card.summary} onChange={(e) => change("summary", e.target.value)} /></label>
    {a ? <section className="sc-source">
      <div className="sc-bar" aria-label="按时间的结构">{card.structure.map((s, i) => <span key={i} style={{ left: `${(s.fromMs / total) * 100}%`, width: `${((s.toMs - s.fromMs) / total) * 100}%`, background: ROLE_COLOR[s.role] }} title={`${ROLE[s.role]} ${sec(s.fromMs)}–${sec(s.toMs)}s`}>{s.label || ROLE[s.role]}</span>)}{a.cuts.map((c) => <i key={c} style={{ left: `${(c / total) * 100}%` }} title={`硬切 ${sec(c)}s`} />)}</div>
      <div className="tech-frames">{a.frames.map((t) => <img key={t} loading="lazy" title={`${t}s`} src={styleApi.frameUrl(card.source.referenceId, t)} alt="" />)}</div>
      <p className="catalog-hint">来源：{card.source.title} · {sec(total)} 秒 · 硬切 {a.cuts.length} 次，{a.pacing.shotCount} 个镜头，平均 {sec(a.pacing.avgShotMs)} 秒 · 竖线是硬切位置；画中画和叠加不算硬切。</p>
    </section> : null}

    <Panel title="① 结构" hint="按时间分段，每段对应一种口播作用" support={card.support} area="structure">
      <div className="sc-rows">{card.structure.map((r, i) => <div key={i} className="sc-row">
        <select value={r.role} onChange={(e) => setRow(i, { role: e.target.value as StyleRole })}>{(Object.keys(ROLE) as StyleRole[]).map((k) => <option key={k} value={k}>{ROLE[k]}</option>)}</select>
        <input type="number" step={0.1} value={Number((r.fromMs / 1000).toFixed(1))} onChange={(e) => setRow(i, { fromMs: Math.round(num(e.target.value, r.fromMs / 1000) * 1000) })} aria-label="开始秒" /><i>–</i>
        <input type="number" step={0.1} value={Number((r.toMs / 1000).toFixed(1))} onChange={(e) => setRow(i, { toMs: Math.round(num(e.target.value, r.toMs / 1000) * 1000) })} aria-label="结束秒" /><span>秒</span>
        <input className="grow" value={r.label} placeholder="名称" onChange={(e) => setRow(i, { label: e.target.value })} />
        <input className="grow2" value={r.what} placeholder="这一段做了什么" onChange={(e) => setRow(i, { what: e.target.value })} />
        <button title="删除这一段" onClick={() => change("structure", card.structure.filter((_, k) => k !== i))}>×</button>
      </div>)}
        <button onClick={() => change("structure", [...card.structure, { role: "other", label: "", fromMs: card.structure[card.structure.length - 1]?.toMs ?? 0, toMs: total, what: "" }])}><Plus size={14} /> 加一段</button></div>
    </Panel>

    <Panel title="② 节奏" hint="切点多快、停顿怎么处理" support={card.support} area="rhythm">
      <Num label="平均几毫秒换一次画面" value={card.rhythm.avgCutMs} onChange={(v) => patch("rhythm", { avgCutMs: v })} step={100} unit="ms" />
      <Check label="句间停顿全部剪掉" value={card.rhythm.removePauses} onChange={(v) => patch("rhythm", { removePauses: v })} />
      <Num label="允许保留的最长停顿" value={card.rhythm.maxPauseMs} onChange={(v) => patch("rhythm", { maxPauseMs: v })} step={10} unit="ms" />
      <Text label="备注" value={card.rhythm.note} onChange={(v) => patch("rhythm", { note: v })} rows={2} />
    </Panel>

    <Panel title="③ 镜头" hint="推近和景别" support={card.support} area="camera">
      <Check label="每句重点词推近" value={card.camera.zoomOnKeywords} onChange={(v) => patch("camera", { zoomOnKeywords: v })} />
      <Pair label="推近倍数" value={card.camera.zoomRange} onChange={(v) => patch("camera", { zoomRange: v })} step={0.05} />
      <Check label="近景和中景交替" value={card.camera.alternateFraming} onChange={(v) => patch("camera", { alternateFraming: v })} />
      <Text label="备注" value={card.camera.note} onChange={(v) => patch("camera", { note: v })} rows={2} />
    </Panel>

    <Panel title="④ 字幕" hint="位置、样式、强调、出现方式" support={card.support} area="captions">
      <Pick label="位置" value={card.captions.position} options={[["top", "上"], ["center", "居中"], ["center-low", "居中偏下"], ["bottom", "底部"]]} onChange={(v) => patch("captions", { position: v })} />
      <Num label="离顶部的比例（0–1）" value={card.captions.yRatio} onChange={(v) => patch("captions", { yRatio: v })} step={0.01} />
      <Text label="样子（颜色、描边、底色）" value={card.captions.look} onChange={(v) => patch("captions", { look: v })} />
      <Text label="关键词怎么强调" value={card.captions.highlight} onChange={(v) => patch("captions", { highlight: v })} />
      <Text label="出现方式" value={card.captions.animation} onChange={(v) => patch("captions", { animation: v })} />
      <Pair label="每块几个词" value={card.captions.wordsPerChunk} onChange={(v) => patch("captions", { wordsPerChunk: v })} />
      <Check label="全大写" value={card.captions.upper} onChange={(v) => patch("captions", { upper: v })} />
      <Check label="字幕旁有 emoji" value={card.captions.emoji} onChange={(v) => patch("captions", { emoji: v })} />
      <Text label="备注" value={card.captions.note} onChange={(v) => patch("captions", { note: v })} rows={2} />
    </Panel>

    <Panel title="⑤ 插入" hint="录屏、画中画、图标、结尾" support={card.support} area="inserts">
      <Pick label="插画方式" value={card.inserts.layout} options={[["full", "全屏"], ["pip", "画中画"], ["mixed", "混合"]]} onChange={(v) => patch("inserts", { layout: v as StyleCard["inserts"]["layout"] })} />
      <Num label="第一次插画出现在" value={card.inserts.firstAtMs} onChange={(v) => patch("inserts", { firstAtMs: v })} step={100} unit="ms" />
      <Pair label="每次插画的时长" value={card.inserts.shotMs} onChange={(v) => patch("inserts", { shotMs: v })} step={100} unit="ms" />
      <Num label="插画占整条视频的比例（0–1）" value={card.inserts.share} onChange={(v) => patch("inserts", { share: v })} step={0.05} />
      <Check label="品牌图标常驻" value={card.inserts.logoPersistent} onChange={(v) => patch("inserts", { logoPersistent: v })} />
      <Pick label="结尾" value={card.inserts.ending} options={[["none", "没有特别处理"], ["end-card", "结尾卡"], ["fullscreen", "全屏产品展示"]]} onChange={(v) => patch("inserts", { ending: v as StyleCard["inserts"]["ending"] })} />
      <Text label="什么时候插" value={card.inserts.triggers} onChange={(v) => patch("inserts", { triggers: v })} rows={2} />
      <Text label="备注" value={card.inserts.note} onChange={(v) => patch("inserts", { note: v })} rows={2} />
    </Panel>

    <Panel title="⑥ 包装" hint="贴纸、音效、音乐。这些现在记在卡里，导出剪映草稿时由你在剪映里补" support={card.support} area="packaging">
      <Text label="贴纸/表情" value={card.packaging.stickers} onChange={(v) => patch("packaging", { stickers: v })} />
      <Text label="音效" value={card.packaging.sfx} onChange={(v) => patch("packaging", { sfx: v })} />
      <Text label="背景音乐" value={card.packaging.music} onChange={(v) => patch("packaging", { music: v })} />
      <Num label="说话时音乐压到" value={card.packaging.duckDb} onChange={(v) => patch("packaging", { duckDb: v })} unit="dB" />
      <Text label="备注" value={card.packaging.note} onChange={(v) => patch("packaging", { note: v })} rows={2} />
    </Panel>

    <details className="sc-rules"><summary>给自动导演的规则（英文，每行一条；确认后会直接写进选片提示）</summary>
      <textarea rows={8} value={card.directorRules.join("\n")} onChange={(e) => change("directorRules", e.target.value.split("\n").filter((l) => l.trim()))} /></details>
    {card.model ? <p className="catalog-hint">草稿由 {card.model} 生成，所有栏位都是它从画面和数据里读出来的，请你对照视频核对。</p> : null}
  </div>;
};

export const StyleLibrary: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [list, setList] = useState<{ cards: StyleBrief[]; runs: StyleRun[] }>({ cards: [], runs: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StyleDetail | null>(null);
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ name: string; done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState("");
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState({ productType: "", format: "", pacing: "" });
  const [insights, setInsights] = useState<Awaited<ReturnType<typeof styleApi.insights>> | null>(null);
  const pending = useRef<string | null>(null);
  const loadList = useCallback(() => styleApi.list().then((l) => { setList(l); setSelected((cur) => cur ?? l.cards[0]?.id ?? null); return l; }).catch((e) => { setMessage(e.message); return null; }), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { styleApi.insights().then(setInsights).catch(() => {}); }, [list.cards.length, detail?.card.status]);
  const loadDetail = useCallback((id: string) => styleApi.get(id).then(setDetail).catch((e) => { setDetail(null); setMessage(e.message); }), []);
  useEffect(() => { if (selected) loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);
  // poll while a 拆解 run is going; when it finishes, open the new card
  const running = list.runs.some((r) => r.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => loadList().then((l) => { if (l && !l.runs.some((r) => r.state === "running") && pending.current) { const fresh = l.cards.find((c) => c.source.referenceId === pending.current); if (fresh) setSelected(fresh.id); pending.current = null; } }), 3000);
    return () => window.clearTimeout(timer);
  }, [running, list, loadList]);
  // a dragged-in video is uploaded first (the browser cannot give a file path), then analysed from the saved copy
  const takeFile = async (f: File) => {
    if (!/\.(mp4|mov|m4v|webm)$/i.test(f.name)) { setMessage("只支持 mp4 / mov / m4v / webm 视频"); return; }
    setMessage(""); setUpload({ name: f.name, done: 0, total: f.size });
    try { const saved = await styleApi.upload(f, (done) => setUpload({ name: f.name, done, total: f.size })); setFile(saved.file); setTitle((t) => t || f.name.replace(/\.\w+$/, "")); }
    catch (e) { setMessage((e as Error).message); } finally { setUpload(null); }
  };
  const add = async () => {
    try { const r = await styleApi.import(file, title); pending.current = r.id; setAdding(false); setFile(""); setTitle(""); setMessage(""); await loadList(); }
    catch (e) { setMessage((e as Error).message); }
  };
  const changed = () => { loadList(); if (selected) loadDetail(selected); };
  return <div className="tech-page">
    <header className="catalog-header">
      <button onClick={onBack}><ArrowLeft size={15} /> 返回</button>
      <div><span className="eyebrow">STYLE LIBRARY</span><h1>风格库</h1></div>
      <span className="sc-stats"><i><b>{list.cards.filter((c) => c.status === "confirmed").length}</b> 张已确认，可用于出方案</i>{insights?.segments ? <i title="参考视频的每一句、你精修过的、你没改直接用的，出方案时会挑最像的当示范"><b>{insights.segments.total}</b> 句片段库（参考 {insights.segments.reference} · 精修 {insights.segments.human_edited} · 采用 {insights.segments.ai_accepted}）</i> : null}</span>
      <button className="primary" style={{ marginLeft: "auto" }} onClick={() => setAdding((v) => !v)}><Plus size={15} /> 拆解新视频</button>
    </header>
    {adding ? <section className="tech-add">
      <p>选一条<b>已经剪好的成品</b>。程序只读它：每秒抽一帧、找出每个切点、转写口播，再让模型写成一张风格卡。成品的画面不会进入你的视频。</p>
      <div className={`drop-zone ref-drop${dragging ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void takeFile(f); }}>
        <button type="button" className="drop-pick" disabled={!!upload} onClick={() => picker.current?.click()}>{upload ? `正在上传 ${upload.name} · ${Math.round((upload.done / upload.total) * 100)}%` : file ? "✓ 已选好，点这里换一条" : "把成品视频拖到这里，或点这里选择文件"}</button>
        {file ? <small className="catalog-hint">{file}</small> : <small className="catalog-hint">mp4 / mov / m4v / webm。视频会复制到本项目的 library/references/_uploads，只用来分析。</small>}
        <input ref={picker} type="file" accept="video/*,.mov" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); e.target.value = ""; }} />
      </div>
      <details><summary>或者填本机文件的完整路径（不复制，直接读）</summary>
        <label>视频文件的完整路径<input value={file} onChange={(e) => setFile(e.target.value)} placeholder="F:\TiktokOne订单\…\00_参考成品\xxx.mp4" spellCheck={false} /></label></details>
      <label>名称（可选，之后可改）<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：kika-UGC快节奏" /></label>
      <div className="catalog-actions"><button className="primary" disabled={!file.trim() || !!upload} onClick={add}>开始拆解（约 1–2 分钟）</button><button disabled={!!upload} onClick={() => setAdding(false)}>取消</button></div>
    </section> : null}
    {message ? <p className="notice settings-bad" role="status">{message}</p> : null}
    <div className="tech-layout">
      <aside className="tech-list">
        <div className="sc-filters" aria-label="筛选" title="产品类型：参考视频卖的是 App 还是实物。视频形式：单人口播、反应型、对比型、清单型、剧情型。节奏：按平均镜头时长，快节奏不到 2 秒一换，中速 2–3 秒，舒缓更长。">
          <select value={filter.productType} onChange={(e) => setFilter({ ...filter, productType: e.target.value })}><option value="">产品类型：全部</option><option value="app">App（软件）</option><option value="physical">实物商品</option></select>
          <select value={filter.format} onChange={(e) => setFilter({ ...filter, format: e.target.value })}><option value="">视频形式：全部</option><option value="single_creator_talking">单人口播</option><option value="reaction">反应型</option><option value="comparison">对比型</option><option value="list">清单型</option><option value="story">剧情型</option></select>
          <select value={filter.pacing} onChange={(e) => setFilter({ ...filter, pacing: e.target.value })}><option value="">节奏：全部</option>{Object.entries(PACING).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        </div>
        {list.runs.map((r) => <div key={r.id} className={`sc-run ${r.state}`}><b>{r.title}</b><span>{r.state === "running" ? r.steps.find((s) => s.state === "running")?.name ?? "准备中…" : r.error}</span>{r.state === "failed" ? <button className="sc-run-x" title="关掉这条失败记录" onClick={() => styleApi.dismissRun(r.id).then(() => loadList()).catch((e) => setMessage(e.message))}>×</button> : null}</div>)}
        {list.cards.length ? list.cards.filter((c) => (!filter.productType || c.meta?.productType === filter.productType) && (!filter.format || c.meta?.format === filter.format) && (!filter.pacing || c.pacing === filter.pacing)).map((c) => <button key={c.id} className={`sc-item${selected === c.id ? " active" : ""}`} onClick={() => setSelected(c.id)}>
          <span className="sc-item-top"><b>{c.name}</b><i className={`sc-chip ${c.status}`}>{c.status === "confirmed" ? "已确认" : "草稿"}</i></span>
          <span className="sc-item-chips">{c.version === 2 ? <><i className="sc-chip">{PACING[c.pacing ?? ""] ?? "—"}</i><i className="sc-chip">{HOOK[c.hookTreatment ?? ""] ?? "—"}</i></> : <i className="sc-chip warn">旧格式</i>}<i className="sc-chip">{c.layout === "pip" ? "画中画" : c.layout === "mixed" ? "混合插画" : "全屏插画"}</i>{c.source.durationMs ? <i className="sc-chip outline">{sec(c.source.durationMs)}s</i> : null}</span>
        </button>) : !list.runs.length ? <p className="catalog-hint">{list.cards.length ? "没有符合筛选条件的卡，把上面的筛选改回「全部」。" : "风格库还是空的。点右上角「拆解新视频」，选一条剪得好的成品。"}</p> : null}
        {list.cards.length && !list.cards.some((c) => (!filter.productType || c.meta?.productType === filter.productType) && (!filter.format || c.meta?.format === filter.format) && (!filter.pacing || c.pacing === filter.pacing)) ? <p className="catalog-hint">没有符合筛选条件的卡（旧格式的卡没有这些标签，筛选时不会出现）。把上面的筛选改回「全部」。</p> : null}
        {insights?.toBuild.length ? <section className="sc-tobuild"><h4>待开发的效果</h4><p className="catalog-hint">已确认的卡里用到、但引擎还没做好的技巧，用到的卡越多越优先。</p><ol>{insights.toBuild.map((t) => <li key={t.key}><b>{t.name}</b><span>{t.count} 张卡{t.effectId ? ` · ${t.effectId}` : ""}</span></li>)}</ol></section> : null}
      </aside>
      <main className="tech-detail">{detail ? ("schemaVersion" in detail.card ? <CardEditorV2 key={detail.card.id} detail={detail} onChanged={changed} onDeleted={() => { setSelected(null); loadList(); }} onError={setMessage} /> : <CardEditor key={detail.card.id} detail={detail as StyleDetail & { card: StyleCard }} onChanged={changed} onDeleted={() => { setSelected(null); loadList(); }} onError={setMessage} />) : <p className="catalog-hint">选择左边的风格卡，或拆解一条新视频。</p>}</main>
    </div>
  </div>;
};

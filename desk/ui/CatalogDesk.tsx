import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, RotateCcw, Sparkles } from "lucide-react";
import { catalogApi, type Catalog, type CatalogItem } from "./api.ts";

// 素材分类：入库之后、出方案之前，人工确认每个素材属于哪一类、它是什么。
// AI 只写草稿（ai），人工修改写在 human，重新描述不会覆盖人工修改。

type Props = { onTechniques?: () => void; onNext?: () => void; nav?: React.ReactNode; projectId: string; onHome: () => void; onPickProject: (id: string) => void; projects: { id: string; order: string; total: number; confirmed: number }[] };
type Filter = "all" | "todo" | string;

const wordKey = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
const wordsOf = (text: string) => text.split(/\s+/).map(wordKey).filter(Boolean);

// 对照脚本：发给达人的文本放在旁边。脚本里达人没读到的词标橙色，达人多说的词在下面列出。只是帮人对照，不会改任何内容。
const ScriptCompare: React.FC<{ reference: { name: string; text: string }[]; spoken: string }> = ({ reference, spoken }) => {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const ref = reference[Math.min(pick, reference.length - 1)];
  const said = useMemo(() => new Set(wordsOf(spoken)), [spoken]);
  const scriptSet = useMemo(() => new Set(wordsOf(ref.text)), [ref]);
  const extra = useMemo(() => [...new Set(wordsOf(spoken).filter((w) => !scriptSet.has(w)))], [spoken, scriptSet]);
  return <div className="script-compare">
    <button type="button" onClick={() => setOpen((v) => !v)}>{open ? "收起脚本对照" : "对照给达人的脚本"}</button>
    {open ? <div className="script-compare-body">
      {reference.length > 1 ? <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>{reference.map((r, i) => <option key={r.name} value={i}>{r.name}</option>)}</select> : <small>{ref.name}</small>}
      <p className="script-text">{ref.text.split(/(\s+)/).map((tok, i) => { const k = wordKey(tok); return k && !said.has(k) ? <mark key={i} title="脚本里有，这条口播没读到">{tok}</mark> : <span key={i}>{tok}</span>; })}</p>
      <p className="catalog-hint">{extra.length ? <>达人多说或说法不同的词：{extra.slice(0, 40).join("、")}{extra.length > 40 ? "…" : ""}</> : "这条口播里的词全都在脚本里。"} 橙色是脚本里有、这条没读到的词（一份脚本分成几条口播时，没读到的词很多是正常的）。</p>
    </div> : null}
  </div>;
};

const Card: React.FC<{ catalog: Catalog; item: CatalogItem; onSaved: (item: CatalogItem) => void; onDescribe: (id: string) => Promise<void>; busy: boolean; onError: (message: string) => void }> = ({ catalog, item, onSaved, onDescribe, busy, onError }) => {
  const [description, setDescription] = useState(item.description);
  const [tags, setTags] = useState(item.tags.join("，"));
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setDescription(item.description); setTags(item.tags.join("，")); }, [item.description, item.tags]);
  const tagList = (value: string) => value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
  const dirty = description !== item.description || tagList(tags).join("|") !== item.tags.join("|");
  const run = async (work: () => Promise<CatalogItem>) => { try { onSaved(await work()); } catch (error) { onError((error as Error).message); } };
  const save = () => dirty ? run(() => catalogApi.save(catalog.id, item.id, { description, tags: tagList(tags) })) : Promise.resolve();
  const isText = item.type === "text";
  const hasHuman = item.human?.description !== undefined || item.human?.category !== undefined || item.human?.tags !== undefined;
  const source = item.descriptionSource === "human" ? <span className="catalog-badge human">已人工修改</span>
    : item.descriptionSource === "transcript" ? <span className="catalog-badge ai">Whisper 转录，待校对</span>
    : item.descriptionSource === "ai" ? <span className="catalog-badge ai">AI 草稿{item.ai?.provider ? ` · ${item.ai.provider}` : ""}</span> : <span className="catalog-badge none">未描述</span>;
  return <article className={`catalog-card${item.confirmed ? " confirmed" : ""}`}>
    <div className="catalog-media">
      {item.type === "video" ? (playing
        ? <video src={catalogApi.mediaUrl(catalog.id, item.id)} controls autoPlay playsInline onEnded={() => setPlaying(false)} />
        : <button className="catalog-poster" onClick={() => setPlaying(true)} aria-label={`播放 ${item.title}`}><div className="catalog-strip">{[0, 1, 2, 3].map((n) => <img key={n} loading="lazy" src={catalogApi.frameUrl(catalog.id, item.id, n)} alt="" />)}</div><span>▶ 播放</span></button>)
        : item.type === "image" ? <img className="catalog-image" src={catalogApi.mediaUrl(catalog.id, item.id)} alt={item.title} />
        : playing
          ? <video src={catalogApi.mediaUrl(catalog.id, item.id)} controls autoPlay playsInline onEnded={() => setPlaying(false)} />
          : <button className="catalog-listen" onClick={() => setPlaying(true)}>▶ 听对应口播（{item.context.assetId}）</button>}
    </div>
    <div className="catalog-body">
      <div className="catalog-title"><b title={item.title}>{item.title}</b><code>{item.id}</code></div>
      <div className="catalog-facts">{item.facts.map((fact) => <span key={fact}>{fact}</span>)}</div>
      <label>分类<select value={item.category} onChange={(event) => run(() => catalogApi.save(catalog.id, item.id, { category: event.target.value }))}>{catalog.categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.label}</option>)}</select></label>
      <label><span className="catalog-label-row">{isText ? "文案（一行一句，可直接校对）" : "描述"} {source}</span><textarea rows={isText ? Math.min(12, description.split("\n").length + 1) : 4} value={description} placeholder="还没有描述，点“AI 描述”或直接写" onChange={(event) => setDescription(event.target.value)} onBlur={save} /></label>
      {isText && catalog.reference?.length ? <ScriptCompare reference={catalog.reference} spoken={description} /> : null}
      {isText && item.textCheck ? (item.textCheck.wordCountFrom !== item.textCheck.wordCountTo
        ? <p className="textcheck bad">词数从 {item.textCheck.wordCountFrom} 变成了 {item.textCheck.wordCountTo}。字幕时间按词对齐，只能改拼写，不能增删词。点「还原」回到转录原文再改。</p>
        : item.textCheck.changes.length ? <div className="textcheck"><span>与转录相比改了 {item.textCheck.changes.length} 个词：</span>{item.textCheck.changes.map((c) => <span key={c.index} className={`change${c.big ? " big" : ""}`} title={c.big ? "和原词差别很大，像是误改（剪切/粘贴/误输入）" : "拼写修正"}>{c.from} → {c.to}</span>)}</div> : <p className="textcheck ok">与转录一致，没有改动。</p>) : null}
      {isText ? null : <label>标签（逗号分隔）<input value={tags} onChange={(event) => setTags(event.target.value)} onBlur={save} /></label>}
      <div className="catalog-actions">
        {isText ? null : <button disabled={busy} onClick={() => onDescribe(item.id)} title="重新生成 AI 草稿；你已修改的内容不会被覆盖"><Sparkles size={14} /> AI 描述</button>}
        {hasHuman ? <button onClick={() => run(() => catalogApi.save(catalog.id, item.id, { category: null, description: null, tags: null }))} title={isText ? "丢掉校对，回到转录原文" : "丢掉人工修改，回到 AI 草稿"}><RotateCcw size={14} /> 还原</button> : null}
        <button className={item.confirmed ? "confirm-on" : "confirm-off"} onClick={async () => { await save(); await run(() => catalogApi.confirm(catalog.id, item.id, !item.confirmed)); }}><Check size={14} /> {item.confirmed ? "已确认" : "确认"}</button>
      </div>
    </div>
  </article>;
};

export const CatalogDesk: React.FC<Props> = ({ onTechniques, onNext, nav, projectId, onHome, onPickProject, projects }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => catalogApi.get(projectId).then(setCatalog).catch((error) => setMessage(error.message)), [projectId]);
  useEffect(() => { setCatalog(null); load(); }, [load]);
  const replace = useCallback((item: CatalogItem) => setCatalog((current) => current && { ...current, items: current.items.map((entry) => entry.id === item.id ? item : entry) }), []);
  const counts = useMemo(() => Object.fromEntries((catalog?.categories ?? []).map((cat) => [cat.id, catalog!.items.filter((i) => i.counted && i.category === cat.id).length])), [catalog]);
  if (!catalog) return <div className="loading">{message || "加载中…"}</div>;
  const counted = catalog.items.filter((i) => i.counted);
  const confirmed = counted.filter((i) => i.confirmed).length;
  const visible = catalog.items.filter((i) => filter === "all" ? true : filter === "todo" ? !i.confirmed : i.category === filter);
  const pending = visible.filter((i) => !i.confirmed);
  const confirmVisible = async () => {
    setBusy(true);
    try { const result = await catalogApi.confirmMany(projectId, pending.map((i) => i.id), true); setCatalog(result.catalog); setMessage(`已确认 ${result.changed} 项`); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  const describe = async (ids?: string[], force = false) => {
    setBusy(true); setMessage("AI 正在描述…");
    try {
      const result = await catalogApi.describe(projectId, ids, force);
      setCatalog(result.catalog);
      const failed = Object.keys(result.errors).length;
      setMessage(`AI 已描述 ${result.described} 项${result.skipped ? `，跳过已有草稿 ${result.skipped} 项` : ""}${failed ? `，${failed} 项失败：${Object.values(result.errors)[0]}` : ""}`);
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  const activeCat = catalog.categories.find((cat) => cat.id === filter);
  return <div className="catalog-page">
    {nav ? <header className="catalog-header catalog-navbar">{nav}<span className="spacer" />
      <div className="catalog-progress"><b>{confirmed} / {counted.length}</b><span>已确认</span></div>
      {onTechniques ? <button onClick={onTechniques}>风格库</button> : null}
      <button className="primary" disabled={busy} onClick={() => describe()}><Sparkles size={15} /> AI 描述未描述的素材</button>
    </header> : <header className="catalog-header">
      <button onClick={onHome}><ArrowLeft size={15} /> 返回</button>
      <div><span className="eyebrow">ASSET CATALOG</span><h1>素材分类</h1></div>
      {projects.length > 1 ? <select value={projectId} onChange={(event) => onPickProject(event.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.order}</option>)}</select> : <span className="catalog-order">{catalog.order}</span>}
      <div className="catalog-progress"><b>{confirmed} / {counted.length}</b><span>已确认</span></div>
      {onTechniques ? <button onClick={onTechniques}>风格库</button> : null}
      <button className="primary" disabled={busy} onClick={() => describe()}><Sparkles size={15} /> AI 描述未描述的素材</button>
    </header>}
    <section className="next-step">
      <div><span className="eyebrow">第 1 步 · 素材</span><h2>{counted.length - confirmed ? `还有 ${counted.length - confirmed} 项要确认（素材分类、文案校对）` : "素材和文案都确认好了"}</h2></div>
      {onNext ? <button className="primary" disabled={counted.length - confirmed > 0} title={counted.length - confirmed > 0 ? "先确认完全部素材和文案" : undefined} onClick={onNext}>去「口播清理」→</button> : null}
    </section>
    <p className="catalog-provider">描述来源：<b>{catalog.provider.name}</b>{catalog.provider.note ? ` — ${catalog.provider.note}` : ""} · AI 只写草稿，你改过的内容永远优先。</p>
    <nav className="catalog-tabs" aria-label="分类筛选">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <small>{counted.length}</small></button>
      {catalog.categories.map((cat) => <button key={cat.id} className={filter === cat.id ? "active" : ""} onClick={() => setFilter(cat.id)}>{cat.label} <small>{counts[cat.id]}</small></button>)}
      <button className={filter === "todo" ? "active" : ""} onClick={() => setFilter("todo")}>待确认 <small>{counted.length - confirmed}</small></button>
    </nav>
    {activeCat ? <p className="catalog-hint">{activeCat.label}：{activeCat.hint}</p> : null}
    {message ? <p className="notice" role="status">{message}</p> : null}
    {pending.length ? <div className="catalog-bulk"><button disabled={busy} onClick={confirmVisible}><Check size={14} /> 确认当前列表全部（{pending.length}）</button><span>确认前先扫一遍；批量确认不会改动分类和描述。</span></div> : null}
    {!visible.length ? <div className="catalog-empty">{filter === "screen" ? "这一类现在是空的：品牌给的素材默认归在“官方素材”。你自己录的游戏/软件录屏入库后会出现在这里，也可以把素材的分类改成“游戏录屏”。" : "这里没有素材"}</div> : null}
    <div className="catalog-grid">{visible.map((item) => <Card key={item.id} catalog={catalog} item={item} onSaved={replace} onDescribe={(id) => describe([id], true)} busy={busy} onError={setMessage} />)}</div>
  </div>;
};

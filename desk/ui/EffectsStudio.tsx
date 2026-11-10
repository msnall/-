import { useEffect, useMemo, useState } from "react";
import { Search, Star, Clock3, Play, Check, X, ArrowLeftRight, Layers3 } from "lucide-react";
import type { Card } from "../../src/engine/library.ts";
import { roleMatches } from "../../src/engine/beat-roles.ts";
import type { Assets, Beats, Library, StoryboardOption } from "./api.ts";
import { storyboardApi } from "./api.ts";

export type EffectChoice = { kind: "card"; id: string } | { kind: "transition"; id: "cut" | "fade-black" } | { kind: "style"; id: string };
export type EffectEntry = { choice: EffectChoice; name: string; category: string; description: string; status: "approved" | "testing" | "needs-development" | "deprecated"; component: string; card?: Card };
export const choiceKey = (choice: EffectChoice) => `${choice.kind}:${choice.id}`;
const CARD_CATEGORY: Record<string, string> = { hook: "钩子与痛点", caption: "字幕与标题", rhythm: "镜头运动", benefit: "产品展示", proof: "产品展示", cta: "钩子与痛点", transition: "转场", audio: "声音" }; // eslint-disable-line @remotion/non-pure-animation
export const CATEGORIES = ["全部", "字幕与标题", "动态文字", "钩子与痛点", "产品展示", "转场", "镜头运动", "调色", "画中画", "分屏", "声音"];
const COMPONENTS: Record<string, string> = { "hook-big-text@1": "title-card@1", "product-pip@1": "image-card@1", "product-fade@1": "image-card@1", "proof-card@1": "image-card@1", "keyword-punch@1": "camera.punchIns", "cold-open@1": "segments reorder" };

export function effectEntries(library: Library): EffectEntry[] {
  const cards = Object.values(library.cards).map((card): EffectEntry => ({
    choice: { kind: "card", id: card.id }, name: card.name,
    category: card.id === "product-pip@1" ? "画中画" : card.id === "hook-big-text@1" ? "动态文字" : CARD_CATEGORY[card.category] ?? "产品展示",
    description: card.description, status: card.status === "ready" && COMPONENTS[card.id] ? "approved" : card.status === "ready" ? "testing" : "needs-development",
    component: COMPONENTS[card.id] ?? (card.blockedBy.join("、") || "尚未实现"), card,
  }));
  const transitions: EffectEntry[] = [
    { choice: { kind: "transition", id: "cut" }, name: "硬切", category: "转场", description: "在相邻片段边界直接切换。", status: "approved", component: "segment boundary" },
    { choice: { kind: "transition", id: "fade-black" }, name: "黑场淡入淡出", category: "转场", description: "使用 fade-through-black@1，在片段边界短暂过黑。", status: "approved", component: "fade-through-black@1" },
  ];
  const styles: EffectEntry[] = Object.values(library.styles).map((style) => ({ choice: { kind: "style", id: style.id }, name: style.name, category: "调色", description: `${style.description} · 整套风格会同时调整字幕、排版和画面色调。`, status: "approved", component: "style pack: captions + layout.grade" }));
  return [...transitions, ...cards, ...styles];
}

export function compatibility(entry: EffectEntry, beat: Beats["beats"][number] | null, option: StoryboardOption | null, assets: Assets | null): string | null {
  if (entry.status !== "approved") return "尚未具备可渲染实现";
  if (!option || !beat) return "请先选择一个段落";
  const row = option.rows.find((item) => item.beat === beat.id);
  if (!row?.keep) return "该段落已剪掉";
  if (entry.choice.kind === "style") return null;
  if (entry.choice.kind === "transition") { const kept = option.rows.filter((item) => item.keep); return kept[kept.length - 1]?.beat === beat.id ? "最后一段没有后续转场" : null; }
  const card = entry.card!;
  if (card.scope !== "beat") return "该技巧尚无逐段操作入口";
  if (!roleMatches(card.when.roles, beat.role)) return "不适用于当前段落角色";
  if (card.when.position === "opening" && card.id !== "cold-open@1" && option.rows.filter((item) => item.keep)[0]?.beat !== beat.id) return "仅适用于开头段落";
  for (const need of card.needs) if (!assets?.items.some((item) => item.kind === need.kind && item.status === "available" && item.file)) return `缺少已确认素材：${need.label}`;
  return null;
}

type ShelfProps = { library: Library; projectId: string; footageId: string; startMs: number; selected: EffectChoice | null; beat: Beats["beats"][number] | null; option: StoryboardOption | null; assets: Assets | null; onSelect: (choice: EffectChoice) => void };
export const EffectShelf: React.FC<ShelfProps> = ({ library, projectId, footageId, startMs, selected, beat, option, assets, onSelect }) => {
  const entries = useMemo(() => effectEntries(library), [library]);
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [favorites, setFavorites] = useState<string[]>(() => storedList("effects:favorites"));
  const [recent, setRecent] = useState<string[]>(() => storedList("effects:recent"));
  useEffect(() => { localStorage.setItem("effects:favorites", JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { localStorage.setItem("effects:recent", JSON.stringify(recent)); }, [recent]);
  const selectedKey = selected ? choiceKey(selected) : null;
  const filtered = entries.filter((entry) => {
    const key = choiceKey(entry.choice);
    if (category === "收藏" && !favorites.includes(key)) return false;
    if (category === "最近" && !recent.includes(key)) return false;
    if (category !== "全部" && category !== "收藏" && category !== "最近" && entry.category !== category) return false;
    if (filter === "available" && compatibility(entry, beat, option, assets)) return false;
    if (["approved", "testing", "needs-development", "deprecated"].includes(filter) && entry.status !== filter) return false;
    return `${entry.name} ${entry.description} ${entry.category}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const select = (entry: EffectEntry) => { onSelect(entry.choice); setRecent((items) => [choiceKey(entry.choice), ...items.filter((item) => item !== choiceKey(entry.choice))].slice(0, 8)); };
  return <section className="effect-shelf"><div className="effect-shelf-title"><span className="eyebrow">VISUAL EFFECTS</span><h2>视觉效果库</h2><p>选择效果后，在“参数”中调整；中间播放器显示实际视频效果。</p></div>
    <label className="effect-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索效果" aria-label="搜索效果" /></label>
    <div className="effect-quick"><button className={category === "收藏" ? "on" : ""} onClick={() => setCategory("收藏")}><Star size={13} /> 收藏</button><button className={category === "最近" ? "on" : ""} onClick={() => setCategory("最近")}><Clock3 size={13} /> 最近</button></div>
    <div className="effect-categories" aria-label="效果分类">{CATEGORIES.map((name) => { const count = entries.filter((item) => item.category === name && item.status === "approved").length; return <button key={name} className={category === name ? "on" : ""} onClick={() => setCategory(name)}>{name}{name !== "全部" ? <small>{count ? count : "待开发"}</small> : null}</button>; })}</div>
    <div className="effect-filters"><button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部</button><button className={filter === "available" ? "on" : ""} onClick={() => setFilter("available")}>当前可用</button><select aria-label="能力状态筛选" value={["approved", "testing", "needs-development", "deprecated"].includes(filter) ? filter : "all"} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="approved">已支持</option><option value="testing">测试中</option><option value="needs-development">待开发</option><option value="deprecated">已停用</option></select></div>
    <div className="effect-list">{filtered.length ? filtered.map((entry) => { const key = choiceKey(entry.choice); const issue = compatibility(entry, beat, option, assets); return <div key={key} className={`effect-item${selectedKey === key ? " selected" : ""}`}><button className="effect-item-main" onClick={() => select(entry)}><div className="effect-thumb">{footageId && beat ? <img loading="lazy" src={storyboardApi.thumbAt(projectId, footageId, startMs)} alt="当前原片画面" /> : <Layers3 size={24} />}<span>{entry.status === "approved" ? <Play size={13} /> : "待开发"}</span></div><div className="effect-item-copy"><b>{entry.name}</b><small>{entry.category}</small><span className={`effect-availability${issue ? " unavailable" : ""}`}>{entry.status !== "approved" ? "需要开发" : issue ?? "可用 · 点击真实预览"}</span></div></button><button className={`effect-star${favorites.includes(key) ? " active" : ""}`} title={favorites.includes(key) ? "取消收藏" : "收藏"} aria-label={`${favorites.includes(key) ? "取消收藏" : "收藏"}${entry.name}`} onClick={() => setFavorites((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key])}><Star size={15} fill={favorites.includes(key) ? "currentColor" : "none"} /></button></div>; }) : <p className="muted effect-empty">没有匹配的效果</p>}</div>
  </section>;
};

function storedList(key: string): string[] { try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }

type InspectorProps = { entry: EffectEntry | null; beat: Beats["beats"][number] | null; option: StoryboardOption | null; assets: Assets | null; words: { index: number; text: string; startMs: number }[]; slots: Record<string, unknown>; onSlots: (slots: Record<string, unknown>) => void; confirmed: boolean; previewStatus: string; previewProblems: string[]; canApply: boolean; onApply: () => void; replaceable: boolean; replaceMode: boolean; onReplaceMode: (value: boolean) => void; applied: { name: string; onRemove: () => void }[]; onClearTransition: () => void; transitionActive: boolean; styleName: string | null };
export const EffectInspector: React.FC<InspectorProps> = ({ entry, beat, option, assets, words, slots, onSlots, confirmed, previewStatus, previewProblems, canApply, onApply, replaceable, replaceMode, onReplaceMode, applied, onClearTransition, transitionActive, styleName }) => {
  const issue = entry ? compatibility(entry, beat, option, assets) : null;
  return <aside className="effect-inspector"><span className="eyebrow">效果参数</span><h2>{entry?.name ?? "选择一个效果"}</h2><p>{entry?.description ?? "从效果库选择视觉效果，在当前段落上预览。"}</p>
    {entry ? <><div className="effect-info"><span>能力状态</span><b>{entry.status === "approved" ? "已支持" : entry.status === "testing" ? "测试中" : entry.status === "deprecated" ? "已停用" : "需要开发"}</b></div><div className="effect-info"><span>当前段落</span><b>{beat ? `${beat.id} · ${beat.textZh ?? beat.text}` : "未选择"}</b></div><div className="effect-info"><span>预览状态</span><b>{issue ?? previewStatus}</b></div>{entry.choice.kind === "style" ? <p className="effect-scope">风格包整体应用；当前架构不支持将字幕、调色等维度拆开混搭。</p> : null}
      {entry.card && entry.status === "approved" && beat ? <div className="effect-fields"><h3>实际渲染参数</h3>{Object.entries(entry.card.slots).map(([name, slot]) => <label key={name}>{slot.label}{slot.type === "choice" ? <select disabled={confirmed} value={String(slots[name] ?? slot.default ?? "")} onChange={(event) => onSlots({ ...slots, [name]: event.target.value })}>{slot.options?.map((value) => <option key={value} value={value}>{value}</option>)}</select> : slot.type === "asset" ? <select disabled={confirmed} value={String(slots[name] ?? "")} onChange={(event) => onSlots({ ...slots, [name]: event.target.value })}><option value="">选择已确认素材</option>{assets?.items.filter((item) => item.kind === entry.card?.needs.find((need) => need.slot === name)?.kind && item.status === "available").map((item) => <option key={item.id} value={item.id}>{item.label ?? item.id}</option>)}</select> : slot.type === "word" ? <select disabled={confirmed} value={String(slots[name] ?? "")} onChange={(event) => onSlots({ ...slots, [name]: Number(event.target.value) })}>{words.filter((word) => beat && word.index >= beat.words[0] && word.index <= beat.words[1]).map((word) => <option key={word.index} value={word.index}>{word.text} · {(word.startMs / 1000).toFixed(1)} 秒</option>)}</select> : <input disabled={confirmed} type={slot.type === "number" ? "number" : "text"} min={slot.min} max={slot.max} value={String(slots[name] ?? "")} onChange={(event) => onSlots({ ...slots, [name]: slot.type === "number" ? Number(event.target.value) : event.target.value })} />}</label>)}</div> : null}
      {replaceable ? <label className="effect-replace"><input type="checkbox" checked={replaceMode} disabled={confirmed} onChange={(event) => onReplaceMode(event.target.checked)} /><ArrowLeftRight size={14} /> 替换当前段落的同类效果</label> : null}
      {previewProblems.length ? <div className="effect-problems">{previewProblems.slice(0, 3).map((problem) => <p key={problem}>{problem}</p>)}</div> : null}<div className="effect-actions"><button className="primary" disabled={!canApply || confirmed} onClick={onApply}><Check size={15} /> {replaceMode && replaceable ? "替换并应用到草稿" : "应用到草稿"}</button></div><details className="technical-details"><summary>渲染能力详情</summary><code>{entry.component}</code></details></> : null}
    <div className="applied-effects"><h3>当前段落已用效果</h3>{applied.length ? applied.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name}</span><button disabled={confirmed} onClick={item.onRemove} aria-label={`移除${item.name}`}><X size={14} /> 移除</button></div>) : <p className="muted">当前段落没有单独添加的效果。</p>}{transitionActive ? <div><span>黑场淡入淡出</span><button disabled={confirmed} onClick={onClearTransition}><X size={14} /> 移除</button></div> : null}{styleName ? <p className="muted">当前风格：{styleName}</p> : null}</div>
  </aside>;
};

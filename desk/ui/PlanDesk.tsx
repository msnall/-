import { useCallback, useEffect, useState } from "react";
import { catalogApi, cleanupApi, directorApi, styleApi, type StyleBrief, type Catalog, type DirectorDraft, type DirectorRun } from "./api.ts";
import { PlanTable } from "./PlanTable.tsx";

// 方案：模型按不同风格各出一套，你比较（每句口播配什么画面、效果怎么放），选一套放进审阅精修。
// 草稿不会动审阅台里的方案；放进去会生成新版本，旧版本随时可以还原。

type Props = { onCleanup: () => void; nav: React.ReactNode; projectId: string; onOpenReview: () => void; onMaterials: () => void; onTechniques: () => void; onSettings: () => void };

export const PlanDesk: React.FC<Props> = ({ onCleanup, nav, projectId, onOpenReview, onMaterials, onTechniques, onSettings }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [run, setRun] = useState<DirectorRun>({ state: "idle" });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [cards, setCards] = useState<StyleBrief[]>([]);
  const [cardId, setCardId] = useState("");
  const [cleaned, setCleaned] = useState<boolean | null>(null);
  const [active, setActive] = useState("");
  const poll = useCallback(() => directorApi.status(projectId).then((status) => { setRun(status); return status; }).catch(() => null), [projectId]);
  useEffect(() => { catalogApi.get(projectId).then(setCatalog).catch((e) => setMessage(e.message)); cleanupApi.get(projectId).then((c) => setCleaned(!!c.confirmedAt)).catch(() => setCleaned(false));
    styleApi.list().then((l) => { const ok = l.cards.filter((c) => c.status === "confirmed"); setCards(ok); setCardId((cur) => cur || ok[0]?.id || ""); }).catch(() => {}); poll(); }, [projectId, poll]);
  useEffect(() => {
    if (run.state !== "running") return;
    const timer = window.setTimeout(poll, 2500);
    return () => window.clearTimeout(timer);
  }, [run, poll]);
  if (!catalog) return <div className="loading">{message || "加载中…"}</div>;
  const counted = catalog.items.filter((i) => i.counted);
  const open = counted.filter((i) => !i.confirmed);
  const apiReady = catalog.provider.name === "api";
  const drafts = run.drafts ?? [];
  const current = drafts.find((d) => d.variant === active) ?? drafts[0];
  const start = async () => { try { setRun(await directorApi.start(projectId, cardId || undefined)); setMessage(""); } catch (error) { setMessage((error as Error).message); } };
  const options = async (variant: string, body: { logo?: boolean; layout?: "full" | "pip" }) => {
    setWorking(true); setMessage("正在按新的效果重新编译这一套…");
    try { setRun(await directorApi.options(projectId, variant, body)); setMessage(""); } catch (error) { setMessage((error as Error).message); } finally { setWorking(false); }
  };
  const apply = async (draft: DirectorDraft) => {
    const live = draft.liveRevision;
    if (live !== null && live > 0 && !window.confirm(`审阅台里已经有方案（版本 ${live}，包含你的修改）。\n\n放进去会生成新版本 ${live + 1}：内容换成「${draft.label}」，你调过的字幕样式、主题和响度设置会保留；版本 ${live} 仍在审阅台的「版本」里，可以随时还原。\n\n继续吗？`)) return;
    setWorking(true); setMessage("正在放进审阅台，并生成预览…");
    try { await directorApi.apply(projectId, draft.variant, live); await poll(); onOpenReview(); } catch (error) { setMessage((error as Error).message); } finally { setWorking(false); }
  };
  const headline = !cleaned ? "先在「口播」把停顿和重说清理一遍" : open.length ? "先回「素材」把素材和文案确认完" : run.state === "running" ? "正在为你出几套方案…" : drafts.length ? "几套方案已生成：比较一下，选一套放进审阅精修" : "素材已确认，可以让模型出方案了";
  return <div className="catalog-page">
    <header className="catalog-header catalog-navbar">{nav}<span className="spacer" /><button onClick={onTechniques}>风格库</button><button onClick={onSettings}>API 设置</button></header>
    <section className="next-step"><div><span className="eyebrow">第 3 步 · 方案</span><h2>{headline}</h2></div>
      <button className="primary" disabled={run.state === "running" || working || open.length > 0 || !apiReady || !cleaned} title={open.length ? "先把所有素材和文案确认完" : !apiReady ? "先保存 API Key" : undefined} onClick={start}>{run.state === "running" ? "生成中…（约 2 分钟）" : drafts.length ? "重新生成全部方案" : "生成方案"}</button></section>
    <section className="plan-checks">
      <div className={cleaned ? "ok" : "bad"}><b>{cleaned ? "✓" : "✕"}</b> 口播已清理并确认{cleaned ? "" : <button onClick={onCleanup}>去清理</button>}</div>
      <div className={open.length ? "bad" : "ok"}><b>{open.length ? "✕" : "✓"}</b> 素材和文案已确认 {counted.length - open.length} / {counted.length}{open.length ? <button onClick={onMaterials}>去确认</button> : null}</div>
      <div className={apiReady ? "ok" : "bad"}><b>{apiReady ? "✓" : "✕"}</b> 模型：{apiReady ? catalog.provider.model : "还没有保存 API Key"}{apiReady ? null : <button onClick={onSettings}>去设置</button>}</div>
      <div className={cards.length ? "ok" : "dim"}><b>{cards.length ? "✓" : "○"}</b> 风格卡：{cards.length ? <select value={cardId} onChange={(e) => setCardId(e.target.value)}><option value="">不用风格卡（只出全屏插画和极简口播两套）</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : "风格库里还没有已确认的卡（不用也能出方案）"}<button onClick={onTechniques}>{cards.length ? "打开风格库" : "去拆解视频"}</button></div>
    </section>
    {message ? <p className="notice settings-bad" role="status">{message}</p> : null}
    {run.steps?.length && run.state !== "idle" && (run.state === "running" || run.state === "failed") ? <section className="director-panel"><ol className="director-steps">{run.steps.map((step) => <li key={step.key ?? step.name} className={step.state}><span>{step.state === "done" ? "✓" : step.state === "running" ? "…" : step.state === "failed" ? "✕" : "·"}</span>{step.name}</li>)}</ol></section> : null}
    {run.state === "failed" && run.error ? <p className="notice settings-bad">{run.error} <a href={directorApi.logUrl(projectId)} target="_blank" rel="noreferrer">查看日志</a></p> : null}
    {run.note && run.state === "done" ? <p className="notice">{run.note}</p> : null}
    {drafts.length ? <>
      <nav className="plan-tabs" aria-label="方案版本">{drafts.map((d) => <button key={d.variant} className={d.variant === current?.variant ? "active" : ""} onClick={() => setActive(d.variant)}><b>{d.label}</b><span>{d.stats.shots ? `${d.stats.shots} 个镜头` : "全程达人"} · 插画占 {Math.round(d.stats.fullShare * 100)}%{run.applied?.variant === d.variant && d.liveRevision === run.applied.revision ? " · 已在审阅台" : ""}</span></button>)}</nav>
      {current ? <PlanTable key={current.variant} projectId={projectId} draft={current} busy={working || run.state === "running"} applied={run.applied?.variant === current.variant && current.liveRevision === run.applied.revision} onSaved={() => { poll(); }} onOptions={(body) => options(current.variant, body)} onApply={() => apply(current)} /> : null}
    </> : null}
  </div>;
};

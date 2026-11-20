import { useCallback, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { catalogApi, cleanupApi, type Cleanup, type CleanupClip, type CleanupEdit } from "./api.ts";

// 口播清理：检测停顿、语气词、重说、口误；你核对每一处，再确认。确认后，后面的方案才按清理过的口播来剪。

const TYPE: Record<CleanupEdit["type"], string> = { pause: "停顿", filler: "语气词", stutter: "重复字", retake: "重说", slip: "口误" };
const SOURCE: Record<CleanupEdit["source"], string> = { auto: "规则检测", model: "AI 复核", user: "你标的" };
const sec = (ms: number) => (ms / 1000).toFixed(2);

type Props = { nav: React.ReactNode; projectId: string; onNext: () => void; onSettings: () => void };

const ClipView: React.FC<{ projectId: string; clipId: string; clip: CleanupClip; onData: (c: Cleanup) => void; onError: (m: string) => void; busy: boolean }> = ({ projectId, clipId, clip, onData, onError, busy }) => {
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const deleted = (i: number) => clip.edits.some((e) => e.decision === "delete" && e.wordFrom !== undefined && i >= e.wordFrom && i <= (e.wordTo ?? e.wordFrom));
  const act = (p: Promise<Cleanup>) => p.then(onData).catch((e) => onError(e.message));
  const play = (fromMs: number, toMs: number) => {
    const v = video.current; if (!v) return;
    window.clearTimeout(timer.current);
    v.currentTime = Math.max(0, fromMs - 400) / 1000; v.play().catch(() => {});
    timer.current = window.setTimeout(() => v.pause(), toMs - fromMs + 900);
  };
  const removed = clip.edits.filter((e) => e.decision === "delete").reduce((s, e) => s + (Math.min(e.toMs, clip.durationMs) - Math.max(e.fromMs, 0)), 0);
  // pause chips sit before the word that follows the deleted stretch; the first/last ones sit at the ends
  const pausesBefore = (i: number) => clip.edits.filter((e) => e.type === "pause" && (e.part === "tail" ? i === clip.words.length : (clip.words[i]?.startMs ?? Infinity) >= e.toMs - 1 && (i === 0 || clip.words[i - 1].endMs <= e.toMs + 1)));
  const chip = (e: CleanupEdit) => <button key={e.id} className={`cl-pause ${e.decision}`} title={`${e.reason}\n点一下切换：${e.decision === "delete" ? "改为保留" : "改为删除"}`} disabled={busy} onClick={() => act(cleanupApi.decide(projectId, clipId, e.id, e.decision === "delete" ? "keep" : "delete"))}>⏸ {((e.toMs - e.fromMs) / 1000).toFixed(2)}s {e.decision === "delete" ? "删" : "留"}</button>;
  return <section className="cl-clip">
    <header><b>{clip.name}</b><span>{(clip.durationMs / 1000).toFixed(1)} 秒 → <b>{((clip.durationMs - removed) / 1000).toFixed(1)} 秒</b>（删掉 {(removed / 1000).toFixed(1)} 秒）</span></header>
    <video ref={video} className="cl-video" src={catalogApi.mediaUrl(projectId, clipId)} controls preload="metadata" />
    <p className="catalog-hint">下面是这条口播的文字。<span className="cl-pause delete">⏸ 删</span> 是要剪掉的停顿，红色划线的字是要删的词；点一下就切换，点任意一个词可以把它标成口误。</p>
    <div className="cl-text">
      {clip.words.map((w) => <span key={w.i}>
        {pausesBefore(w.i).map(chip)}
        <button className={`cl-word${deleted(w.i) ? " cut" : ""}`} disabled={busy} title={`${sec(w.startMs)}s`} onClick={() => act(cleanupApi.word(projectId, clipId, w.i, !deleted(w.i)))}>{w.text}</button>{" "}
      </span>)}
      {pausesBefore(clip.words.length).map(chip)}
    </div>
    <ol className="cl-list">{clip.edits.map((e) => <li key={e.id} className={e.decision}>
      <span className={`cl-type ${e.type}`}>{TYPE[e.type]}</span>
      <span className="cl-time">{sec(e.fromMs)}–{sec(e.toMs)}s</span>
      <span className="cl-reason">{e.reason}</span>
      <i>{SOURCE[e.source]}</i>
      <button title="听这一处" onClick={() => play(e.fromMs, e.toMs)}><Play size={13} /></button>
      <label className="cl-switch"><input type="checkbox" checked={e.decision === "delete"} disabled={busy} onChange={(ev) => act(cleanupApi.decide(projectId, clipId, e.id, ev.target.checked ? "delete" : "keep"))} />删掉</label>
    </li>)}{!clip.edits.length ? <li className="keep">这条口播很干净，没有要处理的地方。</li> : null}</ol>
  </section>;
};

export const CleanupDesk: React.FC<Props> = ({ nav, projectId, onNext, onSettings }) => {
  const [data, setData] = useState<Cleanup | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(() => cleanupApi.get(projectId).then(setData).catch((e) => setMessage(e.message)), [projectId]);
  useEffect(() => { load(); }, [load]);
  const run = async (label: string, task: () => Promise<Cleanup>, done?: string) => {
    setBusy(label); setMessage("");
    try { setData(await task()); if (done) setMessage(done); } catch (e) { setMessage((e as Error).message); } finally { setBusy(""); }
  };
  if (!data) return <div className="loading">{message || "加载中…"}</div>;
  const s = data.stats;
  const headline = !data.exists ? "先检测一遍：找出停顿、语气词、重说和口误" : data.confirmedAt ? `已确认：口播从 ${(s!.beforeMs / 1000).toFixed(1)} 秒缩到 ${(s!.afterMs / 1000).toFixed(1)} 秒` : `核对每一处，再确认（现在会删掉 ${s!.cuts} 处，${(s!.beforeMs / 1000).toFixed(1)} 秒 → ${(s!.afterMs / 1000).toFixed(1)} 秒）`;
  return <div className="catalog-page">
    <header className="catalog-header catalog-navbar">{nav}<span className="spacer" /><button onClick={onSettings}>API 设置</button></header>
    <section className="next-step"><div><span className="eyebrow">第 2 步 · 口播清理</span><h2>{headline}</h2></div>
      <span className="cl-actions">
        <button disabled={!!busy} onClick={() => run("detect", () => cleanupApi.detect(projectId), "检测完成（你之前的取舍会保留）")}>{busy === "detect" ? "检测中…" : data.exists ? "重新检测" : "开始检测"}</button>
        {data.exists ? <button disabled={!!busy} title="让模型再读一遍，找出规则看不出来的口误和重说" onClick={() => run("review", () => cleanupApi.detect(projectId, true), "AI 复核完成：新增的标了「AI 复核」，请你看一眼")}>{busy === "review" ? "复核中…" : "AI 复核口误和重说"}</button> : null}
        {data.exists && !data.confirmedAt ? <button className="primary" disabled={!!busy} onClick={() => run("confirm", () => cleanupApi.confirm(projectId), "已确认")}>确认清理</button> : null}
        {data.confirmedAt ? <button className="primary" onClick={onNext}>去「方案」→</button> : null}
      </span></section>
    {message ? <p className="notice" role="status">{message}</p> : null}
    {data.exists ? <>
      <p className="catalog-hint">停顿删掉后会留 0.1 秒换气；开头和结尾的静音一起去掉。字幕和所有后面的步骤都按清理后的口播走。改动之后需要重新确认。{data.model ? ` AI 复核：${data.model}。` : ""}</p>
      {Object.entries(data.clips ?? {}).map(([id, clip]) => <ClipView key={id} projectId={projectId} clipId={id} clip={clip} onData={setData} onError={setMessage} busy={!!busy} />)}
    </> : <p className="catalog-empty">还没有检测。点右上角的「开始检测」，约 10 秒。</p>}
  </div>;
};

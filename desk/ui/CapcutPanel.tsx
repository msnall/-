import { useCallback, useEffect, useState } from "react";
import { capcutApi, type CapcutStatus } from "./api.ts";

// 剪映草稿：把当前方案铺成剪映（JianYing 专业版）草稿，切点、字幕、插画/画中画、关键帧、音效都已摆好；在剪映里微调后导出。

const when = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export const CapcutPanel: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [status, setStatus] = useState<CapcutStatus | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(() => capcutApi.status(projectId).then((s) => { setStatus(s); setName((cur) => cur || `${projectId} r${s.planRevision ?? 0}`); }).catch((e) => setMessage(e.message)), [projectId]);
  useEffect(() => { load(); }, [load]);
  if (!status) return <section className="surface capcut"><h2>剪映草稿</h2><p>{message || "加载中…"}</p></section>;
  const work = async (label: string, task: () => Promise<unknown>, done: string) => {
    setBusy(label); setMessage("");
    try { await task(); setMessage(done); await load(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(null); }
  };
  const ready = status.pythonReady && status.planRevision !== null;
  return <section className="surface capcut">
    <h2>剪映草稿</h2>
    <p>把当前方案铺成<b>剪映专业版</b>草稿：每个切点、字幕、插画和画中画的位置、推近关键帧、音效都已摆好，打开剪映只需要几分钟微调，再在剪映里导出。</p>
    <ul className="capcut-status">
      <li className={status.planRevision !== null ? "ok" : "bad"}>{status.planRevision !== null ? `当前方案：版本 ${status.planRevision}` : "还没有方案：先在「② 方案」选一套放进审阅精修"}</li>
      <li className={status.jianyingRoot ? "ok" : "bad"}>{status.jianyingRoot ? `剪映草稿箱：${status.jianyingRoot}` : "没有找到剪映专业版的草稿文件夹（需要先打开过一次剪映）"}</li>
      <li className={status.pythonReady ? "ok" : "bad"}>{status.pythonReady ? "导出组件已就绪（pyJianYingDraft 0.3.1）" : "缺少导出组件：见 docs/capcut-export.md 的一次性安装"}</li>
    </ul>
    <div className="capcut-make"><label>草稿名称<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
      <button className="primary" disabled={!ready || !!busy || !name.trim()} onClick={() => work("build", () => capcutApi.build(projectId, name.trim()), "草稿已生成")}>{busy === "build" ? "正在生成…" : "生成剪映草稿"}</button></div>
    {message ? <p className="notice" role="status">{message}</p> : null}
    {status.drafts.map((d) => <article key={d.name} className="capcut-draft">
      <div className="capcut-draft-head"><b>{d.name}</b><span>方案版本 {d.planRevision ?? "?"} · {when(d.builtAt)}{d.durationUs ? ` · ${(d.durationUs / 1e6).toFixed(1)} 秒` : ""}{d.planRevision !== null && d.planRevision !== status.planRevision ? " · 方案之后又改过，建议重新生成" : ""}</span></div>
      <div className="capcut-tracks">{d.tracks.map((t) => <span key={t.name} className="tech-chip">{t.name} · {t.segments} 段</span>)}</div>
      {d.skipped.length ? <p className="capcut-skipped">没有带进剪映的：{d.skipped.join("；")}</p> : null}
      <div className="catalog-actions">
        <button className="primary" disabled={!status.jianyingRoot || d.installed || !!busy} title={d.installed ? "剪映草稿箱里已经有这份" : undefined}
          onClick={() => { if (status.jianyingRunning && !window.confirm("剪映正在运行。放进草稿箱后，需要关闭并重新打开剪映才会在草稿列表里看到。继续吗？")) return; work(`install:${d.name}`, () => capcutApi.install(projectId, d.name), status.jianyingRunning ? "已放进剪映草稿箱。请重启剪映，在草稿列表里打开。" : "已放进剪映草稿箱。打开剪映，在草稿列表里找到它。"); }}>{d.installed ? "已在剪映草稿箱" : busy === `install:${d.name}` ? "正在放进…" : "放进剪映草稿箱"}</button>
        <button disabled={!!busy} onClick={() => capcutApi.reveal(projectId, d.name).catch((e) => setMessage(e.message))}>打开草稿文件夹</button>
      </div>
    </article>)}
    <details className="capcut-notes"><summary>需要知道的事</summary><ul>
      <li>草稿里的视频、录屏、音效都是<b>指向本机文件的链接</b>，不是复制。不要移动或改名 <code>F:\VideoAutomation\public</code> 里的素材，否则剪映会提示"素材丢失"。</li>
      <li>画面效果是按位置和大小近似还原的；字幕样式（字号、背景）可能要在剪映里微调，字幕里单个词的强调色没有带过去。</li>
      <li>音效是自制的合成音（<code>library/sfx</code>）：每个插画出现处一个 whoosh，品牌图标出现处一个 pop；有授权音效时，直接在剪映里替换。</li>
      <li>响度没有做标准化，导出前在剪映里看一下音量。</li>
      <li>已放进草稿箱的草稿不会被覆盖；改了方案要重新生成时，换一个名称。</li>
    </ul></details>
  </section>;
};

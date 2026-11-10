import { useCallback, useEffect, useState } from "react";
import { api, listen, type ExportRecord, type ExportSettings, type Job } from "./api.ts";
import { copyText } from "./clipboard.ts";

const stages = [
  ["preparing", "准备项目"], ["rendering", "生成视频"], ["processing", "处理音视频"],
  ["quality-check", "自动检查画面与声音"], ["finalizing", "整理导出文件"],
] as const;
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const size = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
const duration = (value: number) => `${value.toFixed(1)} 秒`;
const validName = (value: string) => value.length > 0 && value.length <= 120 && /\.mp4$/i.test(value) && !/[<>:"/\\|?*]/.test(value) && ![...value].some((letter) => letter.charCodeAt(0) < 32) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);

export const ExportDesk: React.FC<{ projectId: string; nav: React.ReactNode; onNext?: () => void | Promise<void> }> = ({ projectId, nav, onNext }) => {
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [filename, setFilename] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    const [s, j, e] = await Promise.all([api.exportSettings(projectId), api.jobs(projectId), api.exports(projectId)]);
    setSettings(s); setJobs(j.filter((item) => item.type === "render")); setExports(e);
    setFilename((current) => current || s.filename || "");
  }, [projectId]);
  useEffect(() => { load().catch((error) => setMessage(error.message)); return listen((type, data) => {
    if (type === "job" && (data as Job).project === projectId) load().catch(() => {});
  }); }, [load, projectId]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const active = jobs.find((job) => job.state === "running" || job.state === "queued");
  const latest = jobs[0];
  const selected = exports.find((item) => item.id === latest?.exportId) ?? exports[0];
  const phaseIndex = stages.findIndex(([key]) => key === active?.phase);
  const start = async () => {
    if (!settings?.approved || !validName(filename) || busy || active) return;
    setBusy(true); setMessage("");
    try { await api.startJob(projectId, "render", { filename, planHash: settings.planHash }); await load(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (path: string) => {
    if (await copyText(path)) setMessage("文件路径已复制到剪贴板。");
    else setMessage(`复制失败，请手动复制：${path}`);
  };
  const nextCombination = async () => {
    if (!onNext || busy || active) return;
    setBusy(true); setMessage("");
    try { await onNext(); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const reveal = async (record: ExportRecord) => {
    try { await api.revealExport(projectId, record.id); setMessage("已请求在文件夹中选中视频。"); }
    catch (error) { setMessage(`无法打开文件夹：${(error as Error).message}。可复制文件路径。`); }
  };
  const actions = (record: ExportRecord) => <div className="export-actions">
    <a className="primary" href={api.exportUrl(projectId, record.id, "download")}>下载视频</a>
    <button onClick={() => reveal(record)}>打开输出文件夹</button>
    <button onClick={() => copy(record.absolutePath)}>复制文件路径</button>
  </div>;
  return <div className="export-page"><header>{nav}</header><main className="export-content">
    <div className="export-heading"><div><span className="eyebrow">EXPORT CENTER</span><h1>导出中心</h1><p>{settings?.projectName ?? projectId} · 分镜 {settings?.storyboardRound ?? "旧版方案"} · 剪辑方案第 {settings?.revision ?? "—"} 版</p></div><span className={`export-approval ${settings?.approved ? "ok" : "blocked"}`}>{settings?.approved ? "✓ 分镜已确认" : "分镜待确认"}</span></div>
    {settings && !settings.approved ? <div className="export-alert">{settings.reason} 当前无法开始导出。</div> : null}
    {message ? <div className="export-alert" role="status">{message}</div> : null}
    <div className="export-grid"><section className="surface export-settings"><h2>导出设置</h2><p>视频将使用当前已确认的方案生成。</p>
      <label htmlFor="export-filename">文件名</label><input id="export-filename" value={filename} onChange={(event) => setFilename(event.target.value)} aria-invalid={!validName(filename)} />
      {!validName(filename) ? <small className="export-error">请输入合法的 MP4 文件名，不能包含路径或系统保留字符。</small> : null}
      <dl><div><dt>画面比例</dt><dd>{settings?.width && settings?.height ? `${settings.width > settings.height ? "横版" : settings.width < settings.height ? "竖版" : "方形"} · ${settings.aspectRatio}` : "—"}</dd></div><div><dt>分辨率</dt><dd>{settings ? `${settings.width} × ${settings.height}` : "—"}</dd></div><div><dt>帧率</dt><dd>{settings?.fps ?? "—"} fps</dd></div><div><dt>格式 / 编码</dt><dd>{settings?.format ?? "—"} · {settings?.codec ?? "—"}</dd></div><div><dt>音频</dt><dd>{settings?.audio ?? "—"}</dd></div><div><dt>保存位置</dt><dd className="export-path">{settings?.outputDirectory ?? "—"}</dd></div></dl>
      <button className="primary export-start" disabled={!settings?.approved || !validName(filename) || !!active || busy} onClick={start}>{active ? "正在导出…" : "开始导出视频"}</button>
      <p className="export-hint">导出完成后可在本页预览、下载，或打开保存位置。再次导出会保留旧文件。</p>
    </section><section className="surface export-result"><h2>{selected ? latest?.state === "failed" ? "最近一次成功导出" : "已完成的导出" : "视频与进度"}</h2>
      {selected ? <><div className="export-video"><video controls preload="metadata" poster={api.exportUrl(projectId, selected.id, "thumbnail")} src={api.exportUrl(projectId, selected.id, "video")} /></div><div className="export-success"><strong>✓ 导出完成 · 自动检查通过</strong><span>{selected.filename}</span></div><dl className="export-metadata"><div><dt>时长</dt><dd>{duration(selected.video.durationSeconds)}</dd></div><div><dt>分辨率</dt><dd>{selected.video.width} × {selected.video.height}</dd></div><div><dt>帧率</dt><dd>{selected.video.fps}</dd></div><div><dt>文件大小</dt><dd>{size(selected.fileSize)}</dd></div></dl>{actions(selected)}</> : <div className="export-empty"><span>▶</span><p>导出完成后，可在这里预览并下载视频。</p></div>}
      {active || latest?.state === "failed" ? <div className="export-progress"><h3>{active?.state === "queued" ? "等待导出" : latest?.state === "failed" ? "导出失败 · 需要重试" : "正在导出"}</h3><p>{active?.startedAt ? `已用时 ${Math.floor((now - new Date(active.startedAt).getTime()) / 1000)} 秒` : latest?.state === "failed" ? "本次导出未通过自动检查，历史成片仍可下载。" : "任务已排队"}</p>{active?.phase === "rendering" && active.renderProgress ? <p className="export-frame-progress">已生成 {active.renderProgress.frames} / {active.renderProgress.total} 帧 · {active.renderProgress.percent}%</p> : null}<ol>{stages.map(([key, label], index) => <li className={active && index < phaseIndex ? "done" : active?.phase === key ? "current" : ""} key={key}><span>{active && index < phaseIndex ? "✓" : index + 1}</span>{label}</li>)}</ol>{latest?.state === "failed" ? <><p className="export-error">{latest.error}</p><button onClick={start} disabled={!settings?.approved || !validName(filename)}>重试导出</button></> : null}{latest ? <details><summary>查看技术日志</summary><a href={`/api/projects/${encodeURIComponent(projectId)}/jobs/${latest.id}/log`} target="_blank" rel="noreferrer">打开任务日志</a></details> : null}</div> : null}
    </section></div>
    <section className="surface export-history"><h2>导出历史</h2>{exports.length ? <div className="export-history-list">{exports.map((record) => <article key={record.id}><img src={api.exportUrl(projectId, record.id, "thumbnail")} alt="导出视频缩略图" /><div><strong>{record.filename}</strong><p>{date(record.renderedAt)} · {settings?.projectName ?? projectId} · 分镜 {record.storyboardRevision ?? "旧版"} · {duration(record.video.durationSeconds)} · {size(record.fileSize)} · 检查通过</p></div><a href={api.exportUrl(projectId, record.id, "download")}>下载</a><button onClick={() => reveal(record)}>打开文件夹</button></article>)}</div> : <p>还没有成功导出的视频。</p>}</section>
    {onNext ? <section className="surface"><h2>制作下一条</h2><p>复用口播、达人、素材库和上一条的视觉设置，创建新的镜头组合。</p><button className="primary" disabled={!!active || busy} onClick={nextCombination}>返回内容与素材，制作下一条 →</button></section> : null}
    <details className="surface export-advanced"><summary>高级工具与任务记录</summary><p>预览代理、面部识别和技术日志属于准备与排查工具，不影响当前导出设置。</p>{jobs.map((job) => <p key={job.id}>{date(job.createdAt)} · {job.state === "done" ? "完成" : job.state === "failed" ? "失败" : job.state === "running" ? "执行中" : "排队中"} · <a href={`/api/projects/${encodeURIComponent(projectId)}/jobs/${job.id}/log`} target="_blank" rel="noreferrer">日志</a></p>)}</details>
  </main></div>;
};

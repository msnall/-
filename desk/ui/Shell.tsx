import { useCallback, useEffect, useState } from "react";
import { api, createMixApi, listen, storyboardApi, type Job, type Overview } from "./api.ts";
import { App } from "./App.tsx";
import { ExportDesk } from "./ExportDesk.tsx";
import { AssetDesk } from "./AssetDesk.tsx";
import { HomeDesk } from "./HomeDesk.tsx";
import { MixDesk } from "./MixDesk.tsx";
import { StoryboardDesk } from "./StoryboardDesk.tsx";
import { WorkspaceNav, type WorkspaceView } from "./WorkspaceUI.tsx";

type View = WorkspaceView;
const fromHash = () => new URLSearchParams(location.hash.slice(1));
const viewForStage = (stage: string): View => ({ setup: "setup", "asset-prep": "assets", storyboard: "storyboard", "timeline-review": "review", "render-qc": "render", delivered: "render" })[stage] as View ?? "review";

const SetupDesk: React.FC<{ projectId: string; overview: Overview; nav: React.ReactNode; tick: number; onReady: () => void }> = ({ projectId, overview, nav, tick, onReady }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => { api.jobs(projectId).then(setJobs).catch((error) => setMessage(error.message)); }, [projectId, tick]);
  const proxy = jobs.find((item) => item.type === "proxy");
  const transcribe = jobs.find((item) => item.type === "transcribe");
  const label = (job: Job | undefined, ready: boolean) => ready ? "已完成" : job?.state === "failed" ? "失败 · 需重试" : job?.state === "running" ? "处理中…" : job?.state === "queued" ? "排队中…" : "等待开始";
  const retry = async (type: "proxy" | "transcribe") => {
    try {
      const created = await api.startJob(projectId, type, type === "proxy" ? { force: true, transcribeAfter: !overview.transcriptReady } : { force: true });
      setJobs((current) => [created, ...current]);
      setMessage(type === "proxy" ? "已重新开始生成预览" : "已重新开始转录");
    } catch (error) { setMessage((error as Error).message); }
  };
  const media = overview.media;
  const steps = [
    { name: "上传视频", status: "已完成", detail: media?.originalName ?? "原片已保存" },
    { name: "媒体检测", status: "已完成", detail: media ? `${media.width} × ${media.height} · ${(media.durationMs / 1000).toFixed(1)} 秒 · ${(media.bytes / 1024 / 1024).toFixed(1)} MB` : "已检测画面与音轨" },
    { name: "生成预览代理", status: label(proxy, overview.previewReady), detail: "用于流畅预览；原片保持完整", job: proxy, kind: "proxy" as const, ready: overview.previewReady },
    { name: "提取音轨与转录", status: label(transcribe, overview.transcriptReady), detail: "字幕和基础分镜使用原片时间", job: transcribe, kind: "transcribe" as const, ready: overview.transcriptReady },
    { name: "准备完成", status: overview.ready ? "已完成" : "等待前序任务", detail: "可进入内容与素材工作区" },
  ];
  return <div className="setup-page"><header>{nav}</header><main className="setup-content"><div className="page-heading"><span className="eyebrow">IMPORT & PREPARATION</span><h1>导入与准备</h1><p>视频通过媒体检测、预览代理和语音转录后即可进入工作区。每一步显示真实任务状态。</p></div>
    <div className="setup-layout"><section className="surface setup-process"><h2>处理流程</h2><ol className="process-list">{steps.map((step, index) => <li key={step.name}><span className={`process-number${step.status === "已完成" ? " complete" : ""}`}>{step.status === "已完成" ? "✓" : index + 1}</span><div><div className="process-head"><b>{step.name}</b><span className={`process-state${step.status.includes("失败") ? " failed" : step.status === "已完成" ? " complete" : ""}`}>{step.status}</span></div><p>{step.detail}</p>{step.kind === "proxy" && !step.ready && step.job?.state !== "running" && step.job?.state !== "queued" ? <button onClick={() => retry("proxy")}>重试代理生成</button> : null}{step.kind === "transcribe" && overview.previewReady && !step.ready && step.job?.state !== "running" && step.job?.state !== "queued" ? <button onClick={() => retry("transcribe")}>重试语音转录</button> : null}{step.job?.state === "failed" ? <div className="process-error">{step.name}失败，请查看日志并重试。<details><summary>查看任务日志与技术信息</summary><p>{step.job.error}</p><a href={`/api/projects/${projectId}/jobs/${step.job.id}/log`} target="_blank" rel="noreferrer">打开详细日志</a></details></div> : null}</div></li>)}</ol>{message ? <p className="notice" role="status">{message}</p> : null}</section>
    <aside className="surface setup-summary"><h2>原始视频</h2><dl><div><dt>文件</dt><dd>{media?.originalName ?? "已保存"}</dd></div><div><dt>时长</dt><dd>{media ? `${(media.durationMs / 1000).toFixed(1)} 秒` : "未记录"}</dd></div><div><dt>分辨率</dt><dd>{media ? `${media.width} × ${media.height}` : "未记录"}</dd></div><div><dt>大小</dt><dd>{media ? `${(media.bytes / 1024 / 1024).toFixed(1)} MB` : "未记录"}</dd></div></dl><p>原片用于转录、分镜和最终渲染；预览使用代理视频。</p><button className="primary" disabled={!overview.ready} onClick={onReady}>进入内容与素材 →</button></aside></div>
  </main></div>;
};

export const Shell: React.FC = () => {
  const initial = fromHash();
  const [projects, setProjects] = useState<Overview[]>([]);
  const [projectId, setProjectId] = useState<string | null>(initial.get("project"));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>((initial.get("view") as View | null) ?? "home");
  const [tick, setTick] = useState(0);
  const list = useCallback(async () => { const items = await storyboardApi.projects(); setProjects(items); return items; }, []);
  useEffect(() => { list().catch(() => {}); }, [list]);
  const refresh = useCallback(async (id: string) => { const data = await storyboardApi.overview(id); setOverview(data); return data; }, []);
  useEffect(() => { if (projectId) refresh(projectId).then((data) => { if (!data.ready) setView("setup"); }).catch(() => setView("home")); }, [projectId, refresh]);
  useEffect(() => { location.hash = view === "home" || view === "mix" ? `view=${view}` : `project=${projectId}&view=${view}`; }, [projectId, view]);
  useEffect(() => {
    let timer: number | undefined;
    return listen((_type, data) => {
      const event = data as { project?: string };
      if (!projectId || event.project !== projectId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { refresh(projectId).then((item) => { if (item.ready && view === "setup") setView("assets"); }).catch(() => {}); list().catch(() => {}); setTick((value) => value + 1); }, 300);
    });
  }, [projectId, refresh, list, view]);

  const open = (id: string) => { const item = projects.find((entry) => entry.id === id); setProjectId(id); setOverview(item ?? null); setView(item?.ready ? viewForStage(item.status.stage) : "setup"); };
  if (view === "home") return <HomeDesk projects={projects} onOpen={open} onRefresh={() => { list().catch(() => {}); }} onCreated={(id) => { list().catch(() => {}); setProjectId(id); setOverview(null); setView("setup"); }} />;
  if (view === "mix") return <MixDesk onHome={() => setView("home")} onCreated={(id) => { list(); setProjectId(id); setOverview(null); setView("assets"); }} />;
  if (!projectId || !overview) return <div className="loading">加载中…</div>;
  const navigate = async (target: View) => {
    if (overview.mode === "mix") await refresh(projectId);
    setView(target);
    if (overview.mode === "mix") createMixApi(projectId).stage(({ assets: "asset-prep", storyboard: "storyboard", review: "timeline-review", render: "render-qc", setup: "setup" } as Record<string, string>)[target] ?? "asset-prep").then(() => { refresh(projectId); list(); }).catch(() => {});
  };
  const nav = <WorkspaceNav overview={overview} view={view} onHome={() => setView("home")} onView={navigate} />;
  if (overview.mode === "mix" && (["assets", "setup"].includes(view) || !overview.editorReady)) return <MixDesk key={projectId} projectId={projectId} nav={nav} view={view === "setup" ? "setup" : "assets"} onHome={() => setView("home")} onView={navigate} onChanged={() => { refresh(projectId); list(); }} />;
  if (view === "setup" || !overview.ready) return <SetupDesk projectId={projectId} overview={overview} nav={nav} tick={tick} onReady={() => setView("assets")} />;
  const reload = () => { refresh(projectId); setTick((value) => value + 1); };
  if (view === "render" && overview.hasPlan) return <ExportDesk key={projectId} projectId={projectId} nav={nav} onNext={overview.mode === "mix" ? async () => { await createMixApi(projectId).next(); await navigate("assets"); } : undefined} />;
  if (view === "review" && overview.hasPlan) return <App key={projectId} projectId={projectId} nav={nav} onOpenExport={() => setView("render")} />;
  if (view === "storyboard") return <StoryboardDesk key={projectId} projectId={projectId} overview={overview} nav={nav} tick={tick} onConfirmed={reload} onOpenReview={() => setView("review")} />;
  return <AssetDesk key={projectId} projectId={projectId} overview={overview} nav={nav} tick={tick} onChanged={reload} onNext={() => setView("storyboard")} />;
};

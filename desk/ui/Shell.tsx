import { useCallback, useEffect, useState } from "react";
import { catalogApi, listen, storyboardApi, type Overview } from "./api.ts";
import { App } from "./App.tsx";
import { ExportDesk } from "./ExportDesk.tsx";
import { CatalogDesk } from "./CatalogDesk.tsx";
import { SettingsDesk } from "./SettingsDesk.tsx";
import { PlanDesk } from "./PlanDesk.tsx";
import { CleanupDesk } from "./CleanupDesk.tsx";
import { StyleLibrary } from "./StyleLibrary.tsx";
import { HomeDesk } from "./HomeDesk.tsx";
import { WorkspaceNav, type WorkspaceView } from "./WorkspaceUI.tsx";

type View = WorkspaceView;
const fromHash = () => new URLSearchParams(location.hash.slice(1));
const viewForStage = (stage: string): View => ({ setup: "setup", "asset-prep": "assets", storyboard: "storyboard", "timeline-review": "review", "render-qc": "render", delivered: "render" })[stage] as View ?? "review";

export const Shell: React.FC = () => {
  const initial = fromHash();
  const [projects, setProjects] = useState<Overview[]>([]);
  const [projectId, setProjectId] = useState<string | null>(initial.get("project"));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>((initial.get("view") as View | null) ?? "home");
  const [catalogs, setCatalogs] = useState<{ id: string; order: string; total: number; confirmed: number }[]>([]);
  const [settingsFrom, setSettingsFrom] = useState<View>("home");
  const [techFrom, setTechFrom] = useState<View>("home");
  const [catalogId, setCatalogId] = useState<string | null>(initial.get("catalog"));
  const list = useCallback(async () => { const items = await storyboardApi.projects(); setProjects(items); return items; }, []);
  useEffect(() => { list().catch(() => {}); }, [list]);
  const refresh = useCallback(async (id: string) => { const data = await storyboardApi.overview(id); setOverview(data); return data; }, []);
  useEffect(() => { if (projectId) refresh(projectId).catch(() => setView("home")); }, [projectId, refresh]);
  useEffect(() => { location.hash = view === "settings" ? "view=settings" : view === "techniques" ? "view=techniques" : view === "catalog" ? `view=catalog${catalogId ? `&catalog=${catalogId}` : ""}` : view === "home" ? "view=home" : `project=${projectId}&view=${view}`; }, [projectId, view, catalogId]);
  useEffect(() => { if (view === "catalog") catalogApi.list().then((items) => { setCatalogs(items); setCatalogId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null); }).catch(() => {}); }, [view]);
  useEffect(() => {
    let timer: number | undefined;
    return listen((_type, data) => {
      const event = data as { project?: string };
      if (!projectId || event.project !== projectId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { refresh(projectId).catch(() => {}); list().catch(() => {}); }, 300);
    });
  }, [projectId, refresh, list, view]);

  const open = (id: string) => { const item = projects.find((entry) => entry.id === id); setProjectId(id); setOverview(item ?? null); setView(item?.hasCatalog ? (item.hasPlan ? viewForStage(item.status.stage) : "materials") : item?.ready ? viewForStage(item.status.stage) : "home"); };
  if (view === "techniques") return <StyleLibrary onBack={() => setView(techFrom)} onSettings={() => { setSettingsFrom("techniques"); setView("settings"); }} />;
  if (view === "settings") return <SettingsDesk onBack={() => setView(settingsFrom === "settings" ? "home" : settingsFrom)} />;
  if (view === "catalog") return catalogId ? <CatalogDesk key={catalogId} projectId={catalogId} projects={catalogs} onHome={() => setView("home")} onPickProject={setCatalogId} onSettings={() => { setSettingsFrom("catalog"); setView("settings"); }} /> : <div className="loading">{catalogs.length ? "加载中…" : "还没有已入库的订单素材（先运行 npm run order:ingest）"}<br /><button onClick={() => setView("home")}>返回</button></div>;
  if (view === "home") return <HomeDesk onImported={(id) => { list().then((items) => { const item = items.find((entry) => entry.id === id) ?? null; setProjectId(id); setOverview(item); setView("materials"); }).catch(() => {}); }} onTechniques={() => { setTechFrom("home"); setView("techniques"); }} projects={projects} onOpen={open} onRefresh={() => { list().catch(() => {}); }} />;
  if (!projectId || !overview) return <div className="loading">加载中…</div>;
  const navigate = (target: View) => setView(target);
  const nav = <WorkspaceNav overview={overview} view={view} onHome={() => setView("home")} onView={navigate} />;
  // TTO 任务项目：导入准备 / 内容与素材 / 分镜与方案 都由「素材分类」一页代替。
  if (overview.hasCatalog && view === "cleanup") return <CleanupDesk key={projectId} nav={nav} projectId={projectId} onNext={() => setView("plan")} onSettings={() => { setSettingsFrom("cleanup"); setView("settings"); }} />;
  if (overview.hasCatalog && view === "plan") return <PlanDesk key={projectId} onCleanup={() => setView("cleanup")} nav={nav} projectId={projectId} onOpenReview={() => { refresh(projectId); setView("review"); }} onMaterials={() => setView("materials")} onTechniques={() => { setTechFrom("plan"); setView("techniques"); }} onSettings={() => { setSettingsFrom("plan"); setView("settings"); }} />;
  if (overview.hasCatalog && ["setup", "assets", "storyboard", "materials"].includes(view)) return <CatalogDesk key={projectId} onNext={() => setView("cleanup")} onTechniques={() => { setTechFrom("materials"); setView("techniques"); }} nav={nav} projectId={projectId} projects={[]} onHome={() => setView("home")} onPickProject={() => {}} onSettings={() => { setSettingsFrom("materials"); setView("settings"); }} />;
  if (view === "render" && overview.hasPlan) return <ExportDesk key={projectId} projectId={projectId} nav={nav} />;
  if (view === "review" && overview.hasPlan) return <App key={projectId} projectId={projectId} nav={nav} onOpenExport={() => setView("render")} />;
  return <div className="loading">这条旧项目没有素材分类，不能在新流程里继续。<br /><button onClick={() => setView("home")}>返回首页</button></div>;
};

import { useCallback, useEffect, useState } from "react";
import { listen, storyboardApi, type Overview } from "./api.ts";
import { App } from "./App.tsx";
import { AssetDesk } from "./AssetDesk.tsx";
import { StoryboardDesk } from "./StoryboardDesk.tsx";

// The page: project picker, the four stages as tabs, and the desk for the
// chosen stage. Asset prep -> storyboard -> timeline review (render/QC is the
// review desk's jobs tab).
type View = "assets" | "storyboard" | "review";

const STAGES: [string, string, View][] = [
  ["asset-prep", "① 素材准备", "assets"],
  ["storyboard", "② 方案选择", "storyboard"],
  ["timeline-review", "③ 时间轴审阅", "review"],
  ["render-qc", "④ 渲染质检", "review"],
];

const viewForStage = (stage: string): View => STAGES.find(([key]) => key === stage)?.[2] ?? "review";
const fromHash = () => new URLSearchParams(location.hash.slice(1));

export const Shell: React.FC = () => {
  const [projects, setProjects] = useState<Overview[]>([]);
  const [projectId, setProjectId] = useState<string | null>(fromHash().get("project"));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View | null>((fromHash().get("view") as View | null) ?? null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.json())
      .then((list: Overview[]) => {
        setProjects(list);
        setProjectId((current) => current ?? list[0]?.id ?? null);
      });
  }, []);

  const refresh = useCallback(async (id: string) => {
    const data = await storyboardApi.overview(id);
    setOverview(data);
    return data;
  }, []);

  useEffect(() => {
    if (!projectId) return;
    refresh(projectId).then((data) => setView((current) => current ?? viewForStage(data.status.stage)));
  }, [projectId, refresh]);

  useEffect(() => {
    if (projectId && view) location.hash = `project=${projectId}&view=${view}`;
  }, [projectId, view]);

  // Files written by Claude or by jobs: refresh the overview and tell the
  // asset/storyboard desks to reload (the review desk listens on its own).
  useEffect(() => {
    let timer: number | undefined;
    return listen((type, data) => {
      const event = data as { project?: string };
      if (!projectId || event.project !== projectId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refresh(projectId).catch(() => {});
        setTick((value) => value + 1);
      }, type === "job" ? 50 : 300);
    });
  }, [projectId, refresh]);

  if (!projectId || !overview || !view) return <div className="loading">加载中…</div>;

  const nav = (
    <>
      <select
        value={projectId}
        onChange={(event) => {
          setOverview(null);
          setView(null);
          setProjectId(event.target.value);
        }}
      >
        {projects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.id}
          </option>
        ))}
      </select>
      <ol className="stepper">
        {STAGES.map(([key, label, target]) => {
          const disabled = target === "review" ? !overview.hasPlan : !overview.hasProject;
          const active = target === view && (target !== "review" || key === "timeline-review");
          return (
            <li key={key}>
              <button
                className={`step ${overview.status.stages[key]?.state ?? "pending"}${overview.status.stage === key ? " current" : ""}${active ? " active" : ""}`}
                disabled={disabled}
                title={disabled ? (target === "review" ? "方案确认后才有 edit-plan" : "这个项目创建于方案流程之前，没有素材和方案文件") : undefined}
                onClick={() => setView(target)}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );

  const reload = () => {
    refresh(projectId);
    setTick((value) => value + 1);
  };
  if (view === "review" && overview.hasPlan) return <App key={`${projectId}-${overview.revision === null ? "x" : "p"}`} projectId={projectId} nav={nav} />;
  if (view === "storyboard") return <StoryboardDesk key={projectId} projectId={projectId} overview={overview} nav={nav} tick={tick} onConfirmed={() => reload()} onOpenReview={() => setView("review")} />;
  return <AssetDesk key={projectId} projectId={projectId} overview={overview} nav={nav} tick={tick} onChanged={reload} onNext={() => setView("storyboard")} />;
};

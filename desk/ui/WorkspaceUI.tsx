import { Clapperboard, FolderOpen, Upload, Layers3, ScanEye, Download, ChevronRight } from "lucide-react";
import type { Overview } from "./api.ts";

export type WorkspaceView = "home" | "mix" | "setup" | "assets" | "storyboard" | "review" | "render";

export const stageName = (stage: string) => ({ setup: "导入准备", "asset-prep": "内容与素材", storyboard: "分镜与方案", "timeline-review": "审阅精修", "render-qc": "导出质检", delivered: "已导出" })[stage] ?? "继续制作";
export const nextAction = (overview: Overview) => !overview.previewReady ? "等待预览视频" : !overview.transcriptReady ? "等待语音转录" : ({ setup: "检查素材", "asset-prep": "检查素材与事实", storyboard: "选择分镜方案", "timeline-review": "审阅视频", "render-qc": "检查导出结果", delivered: "查看项目" })[overview.status.stage] ?? "继续制作";
export const timeAgo = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "时间未记录";

const steps = [
  { view: "setup", label: "导入准备", icon: Upload },
  { view: "assets", label: "内容与素材", icon: FolderOpen },
  { view: "storyboard", label: "分镜与方案", icon: Layers3 },
  { view: "review", label: "审阅精修", icon: ScanEye },
  { view: "render", label: "导出中心", icon: Download },
] as const;

export const WorkspaceNav: React.FC<{ overview: Overview; view: WorkspaceView; onHome: () => void; onView: (view: WorkspaceView) => void }> = ({ overview, view, onHome, onView }) => <>
  <button className="brand-button" onClick={onHome} aria-label="返回视频项目"><Clapperboard size={19} /><span>VIDEO STUDIO</span></button>
  <button className="project-switch" onClick={onHome} title="返回视频项目"><span className="project-switch-name">{overview.title}</span><small>{overview.productName}</small></button>
  <nav className="workspace-nav" aria-label="工作区">{steps.map(({ view: target, label, icon: Icon }, index) => {
    const disabled = target !== "setup" && (!overview.ready || ((target === "review" || target === "render") && (!overview.hasPlan || (overview.mode === "mix" && !overview.mixEditorConfirmed))));
    return <button key={target} className={`workspace-nav-item${target === view ? " active" : ""}`} disabled={disabled} onClick={() => onView(target)} title={disabled ? "前面的步骤尚未完成" : label} aria-current={target === view ? "page" : undefined}><Icon size={15} /><span>{label}</span>{index < steps.length - 1 ? <ChevronRight className="nav-chevron" size={13} /> : null}</button>;
  })}</nav>
  <div className="workspace-status"><span className={`status-dot${overview.ready ? " ready" : ""}`} /><span>{overview.ready ? stageName(overview.status.stage) : "正在准备"}</span></div>
</>;

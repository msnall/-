import type { PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPatch } from "../../scripts/lib/json-patch.mjs";
import { getEffect, type EffectId } from "../../src/engine/effects/catalog.ts";
import {
  checkLayout,
  faceZonesAt,
  facesAtSourceMs,
  outputRectToSource,
  segmentAssets,
  segmentAt,
  sourceMsAt,
  type FaceOverrides,
  type Rect,
} from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import {
  api,
  ApiError,
  listen,
  type Decision,
  type Job,
  type Project,
  type RawPlan,
  type Review,
  type Version,
} from "./api.ts";
import { Inspector } from "./Inspector.tsx";
import { Jobs, Proposals, Versions } from "./Panels.tsx";
import { resolvePreview } from "./preview.ts";
import { Stage, type Selection, type Toggles } from "./Stage.tsx";
import { Timeline } from "./Timeline.tsx";

type SaveState =
  | { kind: "saved" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; problems: string[] }
  | { kind: "error"; message: string };

const STAGES: [string, string][] = [
  ["asset-prep", "素材准备"],
  ["storyboard", "方案选择"],
  ["timeline-review", "时间轴审阅"],
  ["render-qc", "渲染质检"],
];

// The server owns the revision field.
const withoutRevision = (plan: RawPlan): RawPlan => {
  const rest = { ...plan };
  delete rest.revision;
  return rest;
};

const hashProject = () =>
  new URLSearchParams(location.hash.slice(1)).get("project");

export const App: React.FC = () => {
  const [projects, setProjects] = useState<
    { id: string; title: string; revision: number }[]
  >([]);
  const [projectId, setProjectId] = useState<string | null>(hashProject());
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<RawPlan | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [review, setReview] = useState<Review | null>(null);
  const [resolved, setResolved] = useState<{
    preview: RawPlan;
    resolved: ResolvedPlan;
  } | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<
    "inspector" | "proposals" | "versions" | "jobs"
  >("inspector");
  const [toggles, setToggles] = useState<Toggles>({
    safeZones: true,
    faces: true,
    captionBox: true,
  });
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [overrides, setOverrides] = useState<FaceOverrides | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const playerRef = useRef<PlayerRef | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const reviewTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ draft, project, save });
  latest.current = { draft, project, save };

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((current) => (current === message ? null : current)),
      6000,
    );
  };

  // --- Loading.
  useEffect(() => {
    api.projects().then((list) => {
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.id ?? null);
    });
  }, []);

  const loadProject = useCallback(
    async (id: string, { keepDraft = false } = {}) => {
      const data = await api.project(id);
      setProject(data);
      setOverrides(data.faceOverrides);
      if (!keepDraft) {
        setDraft(data.plan);
        setSave({ kind: "saved" });
      }
      const round = data.status.stages["timeline-review"]?.round ?? "r1";
      setReview(await api.review(id, round));
      setVersions(await api.versions(id));
      setJobs(await api.jobs(id));
      return data;
    },
    [],
  );

  useEffect(() => {
    if (!projectId) return;
    location.hash = `project=${projectId}`;
    setSelection(null);
    setPreviewing(null);
    setPeaks(null);
    setFrame(0);
    loadProject(projectId).catch((error) =>
      notify(`加载失败：${error.message}`),
    );
  }, [projectId, loadProject]);

  useEffect(() => {
    if (!projectId || !project) return;
    api
      .waveform(projectId)
      .then((data) => setPeaks(data.peaks))
      .catch(() => setPeaks([]));
  }, [projectId, project?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Files changed by Claude (proposals) or jobs: refresh what is shown.
  useEffect(() => {
    let timer: number | undefined;
    return listen((type, data) => {
      const { project: current, save: saveState } = latest.current;
      if (!current) return;
      const event = data as {
        project?: string;
        file?: string;
        state?: string;
        type?: string;
      };
      if (event.project !== current.id) return;
      if (type === "job") {
        api.jobs(current.id).then(setJobs);
        if (
          event.state === "done" &&
          (event.type === "proxy" || event.type === "faces")
        )
          loadProject(current.id, { keepDraft: saveState.kind !== "saved" });
        if (event.state === "done") notify(`作业完成：${event.type}`);
        if (event.state === "failed")
          notify(`作业失败：${event.type}，见“作业”里的日志`);
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const busy = latest.current.save.kind !== "saved";
        loadProject(current.id, { keepDraft: busy }).catch(() => {});
      }, 300);
    });
  }, [loadProject]);

  // --- What the player shows: the draft, or the draft with a proposal applied.
  const shownPlan = useMemo(() => {
    if (!draft) return null;
    const proposal = previewing
      ? project?.proposals.find((item) => item.id === previewing)
      : null;
    if (!proposal) return draft;
    try {
      return applyPatch(draft, proposal.changes);
    } catch {
      return draft;
    }
  }, [draft, previewing, project?.proposals]);

  useEffect(() => {
    if (!shownPlan) return;
    let cancelled = false;
    resolvePreview(shownPlan)
      .then((result) => {
        if (cancelled) return;
        setResolved(result);
        setResolveError(null);
      })
      .catch((error) => !cancelled && setResolveError(error.message));
    return () => {
      cancelled = true;
    };
  }, [shownPlan]);

  // Player events.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) =>
      setFrame(event.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [resolved !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((target: number) => {
    playerRef.current?.seekTo(target);
    setFrame(target);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, select"))
        return;
      if (event.code === "Space") {
        event.preventDefault();
        playerRef.current?.toggle();
      }
      if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
        event.preventDefault();
        const step =
          (event.shiftKey ? 10 : 1) * (event.code === "ArrowLeft" ? -1 : 1);
        seek(
          Math.max(
            0,
            Math.min(
              (resolved?.resolved.durationInFrames ?? 1) - 1,
              (playerRef.current?.getCurrentFrame() ?? 0) + step,
            ),
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek, resolved]);

  // --- Saving the edit-plan (debounced; If-Match on the server's revision).
  const flushSave = useCallback(async () => {
    const { draft: current, project: server } = latest.current;
    if (!current || !server) return;
    setSave({ kind: "saving" });
    try {
      const result = await api.savePlan(
        server.id,
        withoutRevision(current),
        server.revision,
      );
      setDraft((now) =>
        now === current ? result.plan : { ...now!, revision: result.revision },
      );
      setSave({ kind: "saved" });
      await loadProject(server.id, { keepDraft: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setSave({ kind: "conflict", message: error.message });
      else if (error instanceof ApiError && error.status === 422)
        setSave({ kind: "invalid", problems: error.problems });
      else setSave({ kind: "error", message: (error as Error).message });
    }
  }, [loadProject]);

  const updateDraft = useCallback(
    (change: (plan: RawPlan) => RawPlan, commit: boolean) => {
      setDraft((current) =>
        current ? change(structuredClone(current)) : current,
      );
      setSave({ kind: "dirty" });
      window.clearTimeout(saveTimer.current);
      if (commit) saveTimer.current = window.setTimeout(flushSave, 500);
    },
    [flushSave],
  );

  const setOverlayProp = (
    id: string,
    key: string,
    value: unknown,
    commit = true,
  ) =>
    updateDraft((plan) => {
      const overlay = plan.overlays?.find((item) => item.id === id);
      if (overlay) overlay.props = { ...overlay.props, [key]: value };
      return plan;
    }, commit);

  const setOverlayBox = (id: string, rect: Rect, commit: boolean) => {
    const overlay = resolved?.resolved.overlays.find((item) => item.id === id);
    if (!overlay) return;
    const box = getEffect(overlay.effect as EffectId).box;
    updateDraft((plan) => {
      const raw = plan.overlays?.find((item) => item.id === id);
      if (raw)
        raw.props = {
          ...raw.props,
          [box.x]: rect.x,
          [box.y]: rect.y,
          [box.width]: rect.width,
          [box.height]: rect.height,
        };
      return plan;
    }, commit);
  };

  const setCaptionProp = (key: string, value: unknown, commit = true) =>
    updateDraft((plan) => {
      if (plan.captions) plan.captions = { ...plan.captions, [key]: value };
      return plan;
    }, commit);

  // --- Review (decisions and comments).
  const updateReview = (change: (review: Review) => Review) => {
    if (!review || !project) return;
    const next = change(structuredClone(review));
    next.editPlanRevision = project.revision;
    setReview(next);
    window.clearTimeout(reviewTimer.current);
    reviewTimer.current = window.setTimeout(
      () =>
        api
          .saveReview(project.id, next)
          .catch((error) => notify(`意见保存失败：${error.message}`)),
      300,
    );
  };
  const nextCommentId = (current: Review) => {
    const all = [
      ...current.comments,
      ...current.segments.flatMap((entry) => entry.comments),
    ];
    return `c-${String(all.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0) + 1).padStart(4, "0")}`;
  };
  const addComment = (segment: string | null, text: string) =>
    updateReview((current) => {
      const comment = {
        id: nextCommentId(current),
        text,
        at: { frame },
        createdAt: new Date().toISOString(),
        by: "user" as const,
      };
      const entry = segment
        ? current.segments.find((item) => item.segment === segment)
        : null;
      (entry ? entry.comments : current.comments).push(comment);
      return current;
    });
  const setDecision = (segment: string, decision: Decision) =>
    updateReview((current) => {
      const entry = current.segments.find((item) => item.segment === segment);
      if (entry) entry.decision = decision;
      return current;
    });

  // --- Faces.
  const assetIds = useMemo(
    () => (shownPlan ? segmentAssets(shownPlan) : {}),
    [shownPlan],
  );
  const faceZones = useMemo(
    () =>
      resolved && project?.faces
        ? faceZonesAt(
            resolved.resolved,
            assetIds,
            project.faces,
            overrides,
            frame,
          )
        : [],
    [resolved, project?.faces, overrides, frame, assetIds],
  );
  const warnings = useMemo(
    () =>
      resolved && project
        ? checkLayout(resolved.resolved, {
            assetIds,
            faces: project.faces,
            overrides,
            safeZones: project.safeZones,
          })
        : [],
    [resolved, project, overrides, assetIds],
  );
  const overrideTimer = useRef<number | undefined>(undefined);
  const saveOverrides = (
    segments: FaceOverrides["segments"],
    commit: boolean,
  ) => {
    setOverrides({ version: 1, segments });
    window.clearTimeout(overrideTimer.current);
    if (commit && project)
      overrideTimer.current = window.setTimeout(
        () =>
          api
            .saveFaceOverrides(project.id, segments)
            .catch((error) => notify(`人脸修正保存失败：${error.message}`)),
        300,
      );
  };
  const faceModeOf = (segment: string): "auto" | "manual" | "none" => {
    if (!overrides || !(segment in overrides.segments)) return "auto";
    return overrides.segments[segment] === null ? "none" : "manual";
  };
  const setFaceMode = (segmentId: string, mode: "auto" | "manual" | "none") => {
    const segments = { ...(overrides?.segments ?? {}) };
    if (mode === "auto") delete segments[segmentId];
    if (mode === "none") segments[segmentId] = null;
    if (mode === "manual" && resolved && project?.faces) {
      const segment = resolved.resolved.footage.segments.find(
        (item) => item.id === segmentId,
      )!;
      const track = project.faces.assets[assetIds[segmentId]];
      const local =
        frame >= segment.from && frame < segment.from + segment.durationInFrames
          ? frame
          : segment.from;
      const detected = track
        ? facesAtSourceMs(
            track,
            sourceMsAt(resolved.resolved, segment, local),
          )[0]
        : undefined;
      segments[segmentId] = detected ?? {
        x: 0.35,
        y: 0.2,
        width: 0.3,
        height: 0.2,
      };
      if (local !== frame) seek(local);
    }
    saveOverrides(segments, true);
  };
  const onFaceBox = (rect: Rect, commit: boolean) => {
    if (!resolved || !project?.faces || selection?.kind !== "segment") return;
    const segment = resolved.resolved.footage.segments.find(
      (item) => item.id === selection.id,
    );
    const track = project.faces.assets[assetIds[selection.id]];
    if (!segment || !track) return;
    const source = outputRectToSource(
      rect,
      { width: track.width, height: track.height },
      resolved.resolved,
      segment,
      frame,
    );
    saveOverrides(
      { ...(overrides?.segments ?? {}), [selection.id]: source },
      commit,
    );
  };

  // --- Proposals, versions, jobs.
  const accept = async (pid: string) => {
    if (!project) return;
    if (save.kind !== "saved")
      return notify("先等当前修改保存完成，再采纳提案。");
    try {
      const result = await api.accept(project.id, pid);
      setPreviewing(null);
      await loadProject(project.id);
      notify(
        `已采纳 ${pid}，edit-plan 现在是 r${result.revision}。可在“版本”里回退。`,
      );
    } catch (error) {
      notify(
        `${pid} 未采纳：${(error as ApiError).message}${(error as ApiError).problems?.length ? `\n${(error as ApiError).problems.join("\n")}` : ""}`,
      );
      await loadProject(project.id, { keepDraft: true });
    }
  };
  const reject = async (pid: string, text: string) => {
    if (!project) return;
    await api.reject(project.id, pid, text);
    if (previewing === pid) setPreviewing(null);
    await loadProject(project.id, { keepDraft: save.kind !== "saved" });
  };
  const restore = async (revision: number) => {
    if (
      !project ||
      !window.confirm(
        `把 r${revision} 恢复为新版本 r${project.revision + 1}？当前版本仍保留在历史中。`,
      )
    )
      return;
    try {
      await api.restore(project.id, revision, project.revision);
      await loadProject(project.id);
      notify(`已恢复 r${revision}。`);
    } catch (error) {
      notify(`恢复失败：${(error as Error).message}`);
    }
  };
  const startJob = async (type: string) => {
    if (!project) return;
    try {
      await api.startJob(project.id, type);
      setJobs(await api.jobs(project.id));
      setTab("jobs");
    } catch (error) {
      notify(`无法开始作业：${(error as Error).message}`);
    }
  };
  const submit = async () => {
    if (!project || !review) return;
    window.clearTimeout(reviewTimer.current);
    await api.saveReview(project.id, review);
    setReview(await api.submitReview(project.id, review.round));
    await loadProject(project.id, { keepDraft: true });
    notify(
      "意见已提交。在 Claude 对话里说“看我的意见”，Claude 会读取并生成提案。",
    );
  };

  if (!projectId || !project || !draft)
    return <div className="loading">加载中…</div>;

  const pendingCount = project.proposals.filter(
    (proposal) => proposal.state === "pending",
  ).length;
  const decisions = Object.fromEntries(
    (review?.segments ?? []).map((entry) => [entry.segment, entry.decision]),
  );
  const fps = resolved?.resolved.fps ?? 30;
  const status = project.status;
  const segmentNow = resolved ? segmentAt(resolved.resolved, frame) : undefined;
  const missingProxy = draft.segments.some(
    (segment) => !project.proxies[segment.asset],
  );
  const saveLabel =
    save.kind === "saved"
      ? `已保存 · r${project.revision}`
      : save.kind === "saving"
        ? "保存中…"
        : save.kind === "dirty"
          ? "未保存"
          : save.kind === "conflict"
            ? "版本冲突"
            : save.kind === "invalid"
              ? "修改无效，未保存"
              : "保存失败";

  return (
    <div className="app">
      <header>
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
        <ol className="stepper">
          {STAGES.map(([key, label]) => (
            <li
              key={key}
              className={`${status.stages[key]?.state ?? "pending"}${status.stage === key ? " current" : ""}`}
            >
              {label}
              {key === "timeline-review" && status.stages[key]?.round
                ? ` ${status.stages[key].round}`
                : ""}
            </li>
          ))}
        </ol>
        <span className={`save-state ${save.kind}`}>{saveLabel}</span>
        <span className="spacer" />
        {review?.submittedAt ? (
          <span className="muted small">
            意见已提交{" "}
            {new Date(review.submittedAt).toLocaleTimeString("zh-CN", {
              hour12: false,
            })}
          </span>
        ) : null}
        <button className="primary" onClick={submit}>
          提交意见给 Claude
        </button>
      </header>
      <div className="banner-slot">
        {save.kind === "conflict" ||
        save.kind === "invalid" ||
        save.kind === "error" ||
        resolveError ||
        missingProxy ||
        !project.validation.ok ? (
          <div className="banner">
            {save.kind === "conflict" ? (
              <>
                {save.message}{" "}
                <button onClick={() => loadProject(project.id)}>
                  重新加载（放弃未保存的修改）
                </button>
              </>
            ) : null}
            {save.kind === "invalid" ? (
              <>修改未保存：{save.problems.join("；")}</>
            ) : null}
            {save.kind === "error" ? <>保存失败：{save.message}</> : null}
            {resolveError ? <> 预览无法解析：{resolveError}</> : null}
            {!project.validation.ok ? (
              <>
                {" "}
                当前 edit-plan 校验未通过：
                {project.validation.problems.join("；")}
              </>
            ) : null}
            {missingProxy ? (
              <>
                {" "}
                还没有预览代理。
                <button onClick={() => startJob("proxy")}>生成预览代理</button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <main>
        <aside className="segments">
          <h2>段落</h2>
          {resolved?.resolved.footage.segments.map((segment) => {
            const entry = review?.segments.find(
              (item) => item.segment === segment.id,
            );
            const text = resolved.resolved.captions?.cues
              .filter(
                (cue) =>
                  cue.from >= segment.from &&
                  cue.from < segment.from + segment.durationInFrames,
              )
              .map((cue) =>
                cue.lines
                  .flat()
                  .map((word) => word.text)
                  .join(" "),
              )
              .join(" ");
            const proposals = project.proposals.filter(
              (proposal) =>
                proposal.state === "pending" &&
                proposal.impact?.segments?.includes(segment.id),
            ).length;
            return (
              <div
                key={segment.id}
                className={`segment-card ${entry?.decision ?? "undecided"}${selection?.kind === "segment" && selection.id === segment.id ? " selected" : ""}${segmentNow?.id === segment.id ? " playing" : ""}`}
                onClick={() => {
                  setSelection({ kind: "segment", id: segment.id });
                  setTab("inspector");
                  seek(segment.from);
                }}
              >
                <img src={api.thumbUrl(project.id, segment.id)} alt="" />
                <div>
                  <b>{segment.id}</b>
                  <div className="muted small">
                    {(segment.from / fps).toFixed(1)}–
                    {((segment.from + segment.durationInFrames) / fps).toFixed(
                      1,
                    )}
                    s · {(segment.durationInFrames / fps).toFixed(1)}s
                  </div>
                  <div className="cue-text">{text}</div>
                  <div className="chips">
                    {(["keep", "modify", "drop"] as const).map((decision) => (
                      <button
                        key={decision}
                        className={`chip ${decision}${entry?.decision === decision ? " on" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDecision(
                            segment.id,
                            entry?.decision === decision
                              ? "undecided"
                              : decision,
                          );
                        }}
                      >
                        {decision === "keep"
                          ? "保留"
                          : decision === "modify"
                            ? "修改"
                            : "放弃"}
                      </button>
                    ))}
                    {entry?.comments.length ? (
                      <span className="pill">
                        {entry.comments.length} 条意见
                      </span>
                    ) : null}
                    {proposals ? (
                      <span className="pill state-pending">
                        {proposals} 个提案
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </aside>
        <section className="center">
          <div className="toggles">
            {(
              [
                ["safeZones", "TikTok 安全区"],
                ["faces", "人脸区域"],
                ["captionBox", "字幕框"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={toggles[key]}
                  onChange={(event) =>
                    setToggles({ ...toggles, [key]: event.target.checked })
                  }
                />{" "}
                {label}
              </label>
            ))}
            {!project.faces ? (
              <button
                className="small-button"
                onClick={() => startJob("faces")}
              >
                运行人脸检测
              </button>
            ) : null}
          </div>
          {resolved ? (
            <Stage
              playerRef={playerRef}
              preview={resolved.preview}
              resolved={resolved.resolved}
              frame={frame}
              selection={selection}
              onSelect={(next) => {
                setSelection(next);
                if (next) setTab("inspector");
              }}
              toggles={toggles}
              faceZones={faceZones}
              safeZones={project.safeZones}
              editableFace={
                selection?.kind === "segment" &&
                faceModeOf(selection.id) === "manual" &&
                segmentNow?.id === selection.id
              }
              onOverlayBox={setOverlayBox}
              onCaptionBox={(rect, commit) =>
                setCaptionProp("box", rect, commit)
              }
              onFaceBox={onFaceBox}
              previewing={previewing}
            />
          ) : (
            <div className="stage muted">{resolveError ?? "解析中…"}</div>
          )}
          <div className="transport">
            <button onClick={() => seek(Math.max(0, frame - 1))}>‹</button>
            <button
              className="play"
              onClick={() => playerRef.current?.toggle()}
            >
              {playing ? "暂停" : "播放"}
            </button>
            <button
              onClick={() =>
                seek(
                  Math.min(
                    (resolved?.resolved.durationInFrames ?? 1) - 1,
                    frame + 1,
                  ),
                )
              }
            >
              ›
            </button>
            <span className="timecode">
              {(frame / fps).toFixed(2)}s · 第 {frame} 帧 /{" "}
              {resolved?.resolved.durationInFrames ?? 0}
            </span>
            <span className="muted small">
              空格 播放/暂停 · ←/→ 逐帧（Shift ×10）
            </span>
          </div>
        </section>
        <aside className="side">
          <nav className="tabs">
            {(
              [
                ["inspector", "检查器"],
                [
                  "proposals",
                  `提案${pendingCount ? ` (${pendingCount})` : ""}`,
                ],
                ["versions", "版本"],
                ["jobs", "作业"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "on" : ""}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "inspector" && resolved ? (
              <Inspector
                plan={draft}
                resolved={resolved.resolved}
                selection={selection}
                frame={frame}
                warnings={warnings}
                problems={project.validation.problems}
                review={review}
                faceMode={
                  selection?.kind === "segment"
                    ? faceModeOf(selection.id)
                    : "auto"
                }
                hasFaces={!!project.faces}
                onOverlayProp={(id, key, value) =>
                  setOverlayProp(id, key, value)
                }
                onCaptionProp={(key, value) => setCaptionProp(key, value)}
                onDecision={setDecision}
                onComment={addComment}
                onFaceMode={setFaceMode}
                onSeek={seek}
              />
            ) : null}
            {tab === "proposals" ? (
              <Proposals
                projectId={project.id}
                proposals={project.proposals}
                fps={fps}
                previewing={previewing}
                onPreview={setPreviewing}
                onAccept={accept}
                onReject={reject}
              />
            ) : null}
            {tab === "versions" ? (
              <Versions
                versions={versions}
                current={project.revision}
                onRestore={restore}
              />
            ) : null}
            {tab === "jobs" ? (
              <Jobs projectId={project.id} jobs={jobs} onStart={startJob} />
            ) : null}
          </div>
        </aside>
      </main>
      {resolved ? (
        <Timeline
          resolved={resolved.resolved}
          frame={frame}
          decisions={decisions}
          warnings={warnings}
          peaks={peaks}
          selection={selection}
          onSeek={seek}
          onSelect={(next) => {
            setSelection(next);
            setTab("inspector");
          }}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
};

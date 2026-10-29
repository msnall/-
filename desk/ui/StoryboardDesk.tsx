import type { PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { faceZonesAt, type FaceAnalysis, type FaceOverrides, type Rect, type SafeZones } from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import { storyboardApi, type Beats, type CompileResult, type Library, type OptionWithCompile, type Overview, type RawPlan, type StoryboardSelection } from "./api.ts";
import { resolvePreview } from "./preview.ts";
import { Stage, type Selection } from "./Stage.tsx";

// ② Storyboard: Claude's options side by side (keyframes, beat table, what is
// missing), a live preview of the one you look at, the style menu, dragging
// elements, and confirming one option into edit-plan v1.

const ROUND = "r1";
const ROLE_ZH: Record<string, string> = {
  hook: "钩子", intro: "开场介绍", pain: "痛点", benefit: "卖点", proof: "证明", product: "产品", dose: "用量", offer: "优惠", cta: "行动号召", filler: "过渡",
};

type Props = { projectId: string; overview: Overview; nav: React.ReactNode; tick: number; onConfirmed: () => void; onOpenReview: () => void };

export const StoryboardDesk: React.FC<Props> = ({ projectId, overview, nav, tick, onConfirmed, onOpenReview }) => {
  const [options, setOptions] = useState<OptionWithCompile[]>([]);
  const [selection, setSelection] = useState<StoryboardSelection | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [beats, setBeats] = useState<Beats | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [preview, setPreview] = useState<{ preview: RawPlan; resolved: ResolvedPlan } | null>(null);
  const [context, setContext] = useState<{ faces: FaceAnalysis | null; overrides: FaceOverrides | null; safeZones: SafeZones | null } | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [element, setElement] = useState<Selection>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const playerRef = useRef<PlayerRef | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const [round, lib, assets, layout] = await Promise.all([storyboardApi.round(projectId, ROUND), storyboardApi.library(), storyboardApi.assets(projectId), storyboardApi.layoutContext(projectId)]);
    setOptions(round.options);
    setSelection(round.selection);
    setLibrary(lib);
    setBeats(assets.beats);
    setContext(layout);
    setFocus((current) => current ?? round.selection.option ?? round.options[0]?.id ?? null);
  }, [projectId]);

  useEffect(() => {
    load().catch((error) => setMessage(`加载失败：${error.message}`));
  }, [load, tick]);

  // The selection's style/layout overrides apply to the option it names.
  const effective = useMemo(() => (selection && focus && selection.option === focus ? selection : selection ? { ...selection, option: focus, style: null, layoutOverrides: {} } : null), [selection, focus]);

  useEffect(() => {
    if (!focus || !effective) return;
    let cancelled = false;
    storyboardApi
      .compile(projectId, ROUND, focus, effective)
      .then(async (result) => {
        if (cancelled) return;
        setCompiled(result);
        setPreview(result.plan ? await resolvePreview(result.plan as unknown as RawPlan) : null);
      })
      .catch((error) => !cancelled && setMessage(`编译失败：${error.message}`));
    return () => {
      cancelled = true;
    };
  }, [projectId, focus, effective, tick]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
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
  }, [preview !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (target: number) => {
    playerRef.current?.seekTo(target);
    setFrame(target);
  };

  const confirmed = selection?.state === "confirmed";
  const updateSelection = (change: Partial<StoryboardSelection>, commit = true) => {
    if (!selection || !focus || confirmed) return;
    const base = selection.option === focus ? selection : { ...selection, option: focus, style: null, layoutOverrides: {} };
    const next = { ...base, ...change };
    setSelection(next);
    window.clearTimeout(saveTimer.current);
    if (commit) saveTimer.current = window.setTimeout(() => storyboardApi.saveSelection(projectId, ROUND, next).catch((error) => setMessage(`保存失败：${error.message}`)), 400);
  };

  const onOverlayBox = (overlayId: string, rect: Rect, commit: boolean) => updateSelection({ layoutOverrides: { ...(effective?.layoutOverrides ?? {}), [overlayId]: rect } }, commit);

  const confirm = async () => {
    if (!focus) return;
    setBusy(true);
    try {
      await storyboardApi.saveSelection(projectId, ROUND, { ...(effective ?? {}), option: focus });
      const result = await storyboardApi.confirm(projectId, ROUND);
      setMessage(`已确认 ${focus}，生成 edit-plan r${result.revision}。可以进入时间轴审阅。`);
      await load();
      onConfirmed();
    } catch (error) {
      const problems = (error as { problems?: string[] }).problems ?? [];
      setMessage(`不能确认：${problems.join("；") || (error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const faceZones = useMemo(
    () => (preview && context?.faces ? faceZonesAt(preview.resolved, Object.fromEntries(preview.resolved.footage.segments.map((segment) => [segment.id, "source"])), context.faces, context.overrides, frame) : []),
    [preview, context, frame],
  );

  if (!library || !beats) return <div className="loading">加载中…</div>;
  const option = options.find((item) => item.id === focus);
  const styleId = effective?.style ?? option?.style;
  const beatById = new Map(beats.beats.map((beat) => [beat.id, beat]));
  const fps = preview?.resolved.fps ?? 30;
  const gate = compiled?.gate;

  return (
    <div className="app desk-page">
      <header>
        {nav}
        <span className="spacer" />
        {confirmed ? (
          <>
            <span className="pill state-accepted">已确认 {selection?.option}</span>
            <button className="primary" onClick={onOpenReview}>
              进入时间轴审阅 →
            </button>
          </>
        ) : null}
      </header>
      <div className="banner-slot">{message ? <div className="banner" onClick={() => setMessage(null)}>{message}</div> : null}</div>
      <main className="storyboard-grid">
        <section className="options">
          {options.length ? null : <p className="muted">还没有方案。段落角色确认后，在对话里让 Claude 出方案（storyboard）。</p>}
          {options.map((item) => {
            const styleName = library.styles[item.style]?.name ?? item.style;
            const blocked = item.compile.gate.reasons;
            return (
              <div key={item.id} className={`option-card${focus === item.id ? " focused" : ""}${selection?.option === item.id ? " chosen" : ""}`} onClick={() => setFocus(item.id)}>
                <div className="beat-head">
                  <b>
                    {item.id.replace("option-", "方案 ").toUpperCase()} · {item.title}
                  </b>
                  <span className="pill">{styleName}</span>
                  {selection?.option === item.id ? <span className="pill state-accepted">{confirmed ? "已确认" : "已选"}</span> : null}
                </div>
                <p className="small">{item.summary}</p>
                <div className="keyframes">
                  {item.keyframes.map((keyframe) => (
                    <figure key={keyframe.file}>
                      <img src={storyboardApi.storyboardFileUrl(projectId, keyframe.file)} alt="" />
                      <figcaption>{keyframe.label}</figcaption>
                    </figure>
                  ))}
                  {!item.keyframes.length ? <span className="muted small">关键帧生成中或尚未生成</span> : null}
                </div>
                {item.compile.problems.length ? <div className="warn-text small">编译错误 {item.compile.problems.length} 个</div> : null}
                {blocked.length ? (
                  <ul className="gate small">
                    {blocked.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="ok-line small">✓ 可以确认</div>
                )}
              </div>
            );
          })}
        </section>
        <section className="sb-preview">
          {preview ? (
            <Stage
              playerRef={playerRef}
              preview={preview.preview}
              resolved={preview.resolved}
              frame={frame}
              selection={element}
              onSelect={setElement}
              toggles={{ safeZones: true, faces: true, captionBox: false }}
              faceZones={faceZones}
              safeZones={context?.safeZones ?? null}
              editableFace={false}
              onOverlayBox={onOverlayBox}
              onCaptionBox={() => {}}
              onFaceBox={() => {}}
              previewing={confirmed ? null : focus ? `${focus}（方案预览）` : null}
            />
          ) : (
            <div className="stage muted">{compiled?.problems.length ? "方案有编译错误，见右侧" : "编译中…"}</div>
          )}
          <div className="transport">
            <button className="play" onClick={() => playerRef.current?.toggle()}>
              {playing ? "暂停" : "播放"}
            </button>
            <span className="timecode">
              {(frame / fps).toFixed(2)}s / {((preview?.resolved.durationInFrames ?? 0) / fps).toFixed(1)}s
            </span>
          </div>
        </section>
        <aside className="side">
          <div className="tab-body">
            {option ? (
              <>
                <h3>{option.title}</h3>
                <h4>风格</h4>
                <div className="chips">
                  {Object.values(library.styles).map((style) => (
                    <button key={style.id} className={`chip${styleId === style.id ? " on" : ""}`} disabled={confirmed} title={style.description} onClick={() => updateSelection({ style: style.id === option.style ? null : style.id })}>
                      {style.name}
                    </button>
                  ))}
                </div>
                {Object.keys(effective?.layoutOverrides ?? {}).length ? (
                  <p className="small">
                    已手动调整位置：{Object.keys(effective!.layoutOverrides).join("、")}{" "}
                    {!confirmed ? (
                      <a onClick={() => updateSelection({ layoutOverrides: {} })}>还原</a>
                    ) : null}
                  </p>
                ) : (
                  <p className="muted small">可以在画面上拖动卡片调整位置。</p>
                )}
                <h4>分镜表</h4>
                <table className="beat-table">
                  <tbody>
                    {option.rows.map((row) => {
                      const beat = beatById.get(row.beat);
                      const segment = preview?.resolved.footage.segments.find((item) => item.id.split("-").includes(row.beat));
                      return (
                        <tr key={row.beat} className={row.keep ? "" : "dropped"} onClick={() => segment && seek(segment.from)}>
                          <td>
                            <b>{row.beat}</b>
                            <div className="muted small">{beat ? ROLE_ZH[beat.role] : ""}</div>
                          </td>
                          <td>
                            <div className="small">{beat?.textZh}</div>
                            <div className="small muted en">{beat?.text}</div>
                            {row.keep ? (
                              <>
                                {row.onScreen ? <div className="small on-screen">屏幕：{row.onScreen}</div> : null}
                                {row.cards.length ? (
                                  <div className="chips">
                                    {row.cards.map((use, index) => (
                                      <span key={index} className="pill" title={library.cards[use.card]?.description}>
                                        {library.cards[use.card]?.name ?? use.card}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <div className="small warn-text">剪掉：{row.reason}</div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {compiled?.problems.length ? (
                  <>
                    <h4>编译错误</h4>
                    <ul className="warnings">
                      {compiled.problems.map((problem) => (
                        <li key={problem} className="error">
                          {problem}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h4>检查</h4>
                {compiled?.warnings.length ? (
                  <ul className="warnings">
                    {compiled.warnings.map((warning, index) => (
                      <li key={index} className={warning.kind}>
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ok-line">✓ 没有布局警告</p>
                )}
                <h4>确认前需要</h4>
                {gate?.reasons.length ? (
                  <ul className="gate">
                    {gate.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="ok-line">✓ 全部满足</p>
                )}
                <div className="actions">
                  <button className="primary" disabled={confirmed || busy || !gate?.canConfirm} onClick={confirm}>
                    {confirmed ? "已确认" : busy ? "确认中…" : "确认这个方案"}
                  </button>
                  {!gate?.canConfirm && !confirmed ? <span className="muted small">素材和事实在“① 素材准备”里处理</span> : null}
                </div>
                <p className="muted small">确认后生成 edit-plan v1（{overview.hasPlan ? "作为新版本" : "revision 0"}），进入时间轴审阅。想换卡片或改分镜，请在对话里让 Claude 出新一轮方案。</p>
              </>
            ) : null}
          </div>
        </aside>
      </main>
    </div>
  );
};

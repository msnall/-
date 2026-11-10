import type { PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { faceZonesAt, type FaceAnalysis, type FaceOverrides, type Rect, type SafeZones } from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import { createMixApi, storyboardApi, type Assets, type Beats, type CompileResult, type Library, type OptionWithCompile, type Overview, type RawPlan, type StoryboardOption, type StoryboardSelection } from "./api.ts";
import { roleMatches, simpleRole } from "../../src/engine/beat-roles.ts";
import { resolvePreview } from "./preview.ts";
import { Stage, type Selection } from "./Stage.tsx";
import { EffectInspector, EffectShelf, compatibility, effectEntries, choiceKey, type EffectChoice } from "./EffectsStudio.tsx";
import { VideoSettingsPanel } from "./VideoSettingsPanel.tsx";
import { Layers3, WandSparkles } from "lucide-react";

// ② Storyboard: Claude's options side by side (keyframes, beat table, what is
// missing), a live preview of the one you look at, the style menu, dragging
// elements, and confirming one option into edit-plan v1.

const ROLE_ZH: Record<string, string> = {
  hook: "钩子", intro: "开场介绍", pain: "痛点", benefit: "卖点", proof: "证明", product: "产品", dose: "用量", offer: "优惠", cta: "行动号召", filler: "过渡",
};

type Props = { projectId: string; overview: Overview; nav: React.ReactNode; tick: number; onConfirmed: () => void; onOpenReview: () => void };
type LivePreview = { preview: RawPlan; resolved: ResolvedPlan };
type SceneGroup = { id: string; role: string; beats: Beats["beats"]; startMs: number; endMs: number };
const groupScenes = (beats: Beats["beats"], words: { startMs: number }[], durationMs?: number): SceneGroup[] => {
  const groups: SceneGroup[] = [];
  for (const beat of beats) {
    const startMs = words[beat.words[0]]?.startMs ?? 0;
    const endMs = words[beat.words[1] + 1]?.startMs ?? durationMs ?? startMs + 2500;
    const role = simpleRole(beat.role);
    const previous = groups[groups.length - 1];
    if (previous && previous.role === role && endMs - previous.startMs <= 12000) {
      previous.beats.push(beat);
      previous.endMs = endMs;
    } else groups.push({ id: beat.id, role, beats: [beat], startMs, endMs });
  }
  for (let index = groups.length - 1; index > 0; index--) {
    const group = groups[index];
    const previous = groups[index - 1];
    if (group.beats.length === 1 && group.role === previous.role && group.endMs - previous.startMs <= 16000) {
      previous.beats.push(...group.beats);
      previous.endMs = group.endMs;
      groups.splice(index, 1);
    }
  }
  return groups;
};
const SCENE_SUGGESTIONS: Record<string, string[]> = {
  hook: ["hook-big-text@1", "keyword-punch@1"],
  pain: ["keyword-punch@1", "product-fade@1"],
  benefit: ["product-fade@1", "product-pip@1"],
  proof: ["proof-card@1", "keyword-punch@1"],
  offer: ["keyword-punch@1"],
  cta: ["keyword-punch@1"],
  filler: [],
};
const effectPreviewCache = new Map<string, { result: CompileResult; preview: LivePreview }>();

export const StoryboardDesk: React.FC<Props> = ({ projectId, overview, nav, tick, onConfirmed, onOpenReview }) => {
  const [savedPresets, setSavedPresets] = useState<Awaited<ReturnType<typeof storyboardApi.presets>>>([]);
  const [presetForm, setPresetForm] = useState<{ name: string; sourceRound?: string } | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [round, setRound] = useState("");
  useEffect(() => { storyboardApi.presets(projectId).then(setSavedPresets).catch(() => {}); }, [projectId, tick, round]);
  const [rounds, setRounds] = useState<string[]>([]);
  const [options, setOptions] = useState<OptionWithCompile[]>([]);
  const [selection, setSelection] = useState<StoryboardSelection | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [beats, setBeats] = useState<Beats | null>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [words, setWords] = useState<{ index: number; text: string; startMs: number }[]>([]);
  const [footageId, setFootageId] = useState("");
  const [selectedBeat, setSelectedBeat] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [preview, setPreview] = useState<{ preview: RawPlan; resolved: ResolvedPlan } | null>(null);
  const [context, setContext] = useState<{ faces: FaceAnalysis | null; overrides: FaceOverrides | null; safeZones: SafeZones | null } | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [element, setElement] = useState<Selection>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [studio, setStudio] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"effects" | "content" | "parameters" | "video">(overview.mode === "mix" ? "video" : "effects");
  const [inspectMode, setInspectMode] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [candidate, setCandidate] = useState<EffectChoice | null>(null);
  const [candidateSlots, setCandidateSlots] = useState<Record<string, unknown>>({});
  const [replaceMode, setReplaceMode] = useState(false);
  const [candidatePreview, setCandidatePreview] = useState<LivePreview | null>(null);
  const [sourcePreview, setSourcePreview] = useState<LivePreview | null>(null);
  const [sourcePreviewStatus, setSourcePreviewStatus] = useState("原片预览加载中…");
  const [candidateResult, setCandidateResult] = useState<CompileResult | null>(null);
  const [previewStatus, setPreviewStatus] = useState("选择效果以生成预览");
  const [comparison, setComparison] = useState<"before" | "after">("after");
  const playerRef = useRef<PlayerRef | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const [available, lib, assetData, layout] = await Promise.all([storyboardApi.rounds(projectId), storyboardApi.library(), storyboardApi.assets(projectId), storyboardApi.layoutContext(projectId)]);
    const currentRound = available.includes(round) ? round : available[available.length - 1] ?? "r1";
    const roundData = await storyboardApi.round(projectId, currentRound);
    setRound(currentRound);
    setRounds(available);
    setOptions(roundData.options);
    setSelection(roundData.selection);
    setLibrary(lib);
    setBeats(assetData.beats);
    setAssets(assetData.assets);
    setWords(assetData.words);
    setFootageId(assetData.footage);
    setSelectedBeat((current) => current && assetData.beats?.beats.some((beat) => beat.id === current) ? current : assetData.beats?.beats[0]?.id ?? null);
    setContext(layout);
    setFocus((current) => roundData.options.some((item) => item.id === current) ? current : roundData.selection.option ?? roundData.options[0]?.id ?? null);
  }, [projectId, round]);

  useEffect(() => {
    load().catch((error) => setMessage(`加载失败：${error.message}`));
  }, [load, tick]);

  // The selection's style/layout overrides apply to the option it names.
  const effective = useMemo(() => (selection && focus && selection.option === focus ? selection : selection ? { ...selection, option: focus, style: null, layoutOverrides: {}, draftOption: null, transitions: {} } : null), [selection, focus]);
  const optionBase = effective?.draftOption ?? options.find((item) => item.id === focus) ?? null;
  const previewBeat = beats?.beats.find((beat) => beat.id === selectedBeat) ?? null;
  const entries = useMemo(() => library ? effectEntries(library) : [], [library]);
  const selectedEntry = candidate ? entries.find((entry) => choiceKey(entry.choice) === choiceKey(candidate)) ?? null : null;
  const candidateIssue = selectedEntry ? compatibility(selectedEntry, previewBeat, optionBase, assets) : null;
  const selectedRow = optionBase?.rows.find((row) => row.beat === selectedBeat);
  const replaceable = candidate?.kind === "card" && !!optionBase?.rows.find((row) => row.beat === selectedBeat)?.cards.some((use) => library?.cards[use.card]?.category === library?.cards[candidate.id]?.category);

  useEffect(() => {
    if (!candidate || !selectedEntry || candidateIssue || !effective || !focus || !optionBase || !previewBeat || !assets) { setCandidatePreview(null); setCandidateResult(null); return; }
    let cancelled = false;
    const selectionForPreview = structuredClone(effective);
    if (candidate.kind === "card") {
      const draft = structuredClone(optionBase) as StoryboardOption & { compile?: unknown };
      delete draft.compile;
      draft.keyframes = [];
      const row = draft.rows.find((item) => item.beat === previewBeat.id);
      if (row) {
        if (replaceMode) row.cards = row.cards.filter((use) => library?.cards[use.card]?.category !== library?.cards[candidate.id]?.category);
        row.cards.push({ card: candidate.id, slots: candidateSlots, claims: [] });
      }
      selectionForPreview.draftOption = draft;
    } else if (candidate.kind === "transition") selectionForPreview.transitions = { ...selectionForPreview.transitions, [previewBeat.id]: candidate.id };
    else selectionForPreview.style = candidate.id;
    const key = JSON.stringify({ projectId, round, focus, candidate, replaceMode, beat: previewBeat.id, slots: candidateSlots, selection: effective, source: assets.items.map((item) => [item.id, item.sha256, item.status]) });
    const cached = effectPreviewCache.get(key);
    if (cached) { setCandidateResult(cached.result); setCandidatePreview(cached.preview); setPreviewStatus("预览可播放 · 已缓存"); return; }
    setCandidatePreview(null); setCandidateResult(null); setPreviewStatus("正在生成实际效果预览…");
    storyboardApi.compile(projectId, round, focus, selectionForPreview).then(async (result) => {
      if (cancelled) return;
      setCandidateResult(result);
      if (!result.plan) { setPreviewStatus("当前参数无法预览"); return; }
      const resolved = await resolvePreview(result.plan as unknown as RawPlan);
      if (cancelled) return;
      effectPreviewCache.set(key, { result, preview: resolved });
      if (effectPreviewCache.size > 24) effectPreviewCache.delete(effectPreviewCache.keys().next().value!);
      setCandidatePreview(resolved); setPreviewStatus("预览可播放");
    }).catch((error) => { if (!cancelled) setPreviewStatus(`预览失败：${error.message}`); });
    return () => { cancelled = true; };
  }, [projectId, round, focus, candidate, candidateSlots, replaceMode, selectedEntry, candidateIssue, effective, optionBase, previewBeat, assets, library]);

  useEffect(() => {
    if (!focus || !effective) return;
    let cancelled = false;
    storyboardApi
      .compile(projectId, round, focus, effective)
      .then(async (result) => {
        if (cancelled) return;
        setCompiled(result);
        setPreview(result.plan ? await resolvePreview(result.plan as unknown as RawPlan) : null);
      })
      .catch((error) => !cancelled && setMessage(`编译失败：${error.message}`));
    return () => {
      cancelled = true;
    };
  }, [projectId, round, focus, effective, tick]);

  useEffect(() => {
    if (selectedRow?.keep !== false || !previewBeat || !compiled?.plan) { setSourcePreview(null); if (selectedRow?.keep === false && compiled && !compiled.plan) setSourcePreviewStatus("方案编译错误，暂不能预览该段原片"); return; }
    let cancelled = false;
    const startMs = words[previewBeat.words[0]]?.startMs ?? 0;
    const endMs = words[previewBeat.words[1] + 1]?.startMs ?? (words[previewBeat.words[1]]?.startMs ?? startMs) + 500;
    const source = structuredClone(compiled.plan) as RawPlan;
    source.segments = [{ id: `source-${previewBeat.id}`, asset: source.segments[0]?.asset ?? footageId, sourceStartMs: startMs, sourceEndMs: Math.max(startMs + 100, endMs) }];
    source.overlays = [];
    delete source.captions;
    setSourcePreview(null);
    setSourcePreviewStatus("原片预览加载中…");
    resolvePreview(source).then((result) => { if (!cancelled) { setSourcePreview(result); setSourcePreviewStatus("已剪掉 · 正在查看原片"); } }).catch((error) => { if (!cancelled) setSourcePreviewStatus(`原片预览失败：${error.message}`); });
    return () => { cancelled = true; };
  }, [selectedRow?.keep, previewBeat, compiled, words, footageId]);

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

  const switchBeat = (beatId: string) => {
    setSelectedBeat(beatId);
    setCandidate(null);
    setCandidatePreview(null);
    setCandidateResult(null);
    setComparison("after");
  };

  const confirmed = selection?.state === "confirmed";
  const updateSelection = (change: Partial<StoryboardSelection>, commit = true) => {
    if (!selection || !focus || confirmed) return;
    const base = selection.option === focus ? selection : { ...selection, option: focus, style: null, layoutOverrides: {}, draftOption: null, transitions: {} };
    const next = { ...base, ...change };
    setSelection(next);
    window.clearTimeout(saveTimer.current);
    if (commit) saveTimer.current = window.setTimeout(() => storyboardApi.saveSelection(projectId, round, next).catch((error) => setMessage(`保存失败：${error.message}`)), 400);
  };

  const editOption = (change: (draft: StoryboardOption) => void) => {
    const base = effective?.draftOption ?? options.find((item) => item.id === focus);
    if (!base || confirmed) return;
    const draft = structuredClone(base) as StoryboardOption & { compile?: unknown };
    delete draft.compile;
    change(draft);
    draft.keyframes = [];
    updateSelection({ draftOption: draft });
  };

  const addCard = (beatId: string, cardId: string) => {
    const card = library?.cards[cardId];
    const beat = beats?.beats.find((item) => item.id === beatId);
    if (!card || !beat || card.status !== "ready") return;
    const slots: Record<string, unknown> = {};
    for (const [name, slot] of Object.entries(card.slots)) {
      if (slot.default !== undefined) slots[name] = slot.default;
      else if (slot.type === "word") slots[name] = beat.words[0];
      else if (slot.type === "asset") slots[name] = assets?.items.find((item) => item.neededBy.includes(beatId) && item.kind === card.needs.find((need) => need.slot === name)?.kind)?.id ?? assets?.items.find((item) => item.kind === card.needs.find((need) => need.slot === name)?.kind)?.id ?? "";
      else if (slot.type === "text") slots[name] = "";
      else if (slot.type === "number") slots[name] = slot.min ?? 0;
      else if (slot.type === "choice") slots[name] = slot.options?.[0] ?? "";
    }
    editOption((draft) => { draft.rows.find((row) => row.beat === beatId)?.cards.push({ card: cardId, slots, claims: [] }); });
  };

  const chooseEffect = (choice: EffectChoice, beatId = selectedBeat) => {
    const card = choice.kind === "card" ? library?.cards[choice.id] : null;
    const beat = beats?.beats.find((item) => item.id === beatId);
    const slots: Record<string, unknown> = {};
    if (card && beat) for (const [name, slot] of Object.entries(card.slots)) {
      if (slot.default !== undefined) slots[name] = slot.default;
      else if (slot.type === "word") slots[name] = beat.words[0];
      else if (slot.type === "asset") slots[name] = assets?.items.find((item) => item.kind === card.needs.find((need) => need.slot === name)?.kind && item.status === "available")?.id ?? "";
      else if (slot.type === "text") slots[name] = beat.text.split(/[.!?]/)[0].trim().slice(0, 40).toUpperCase();
      else if (slot.type === "number") slots[name] = slot.min ?? 0;
      else if (slot.type === "choice") slots[name] = slot.options?.[0] ?? "";
    }
    const sameCategory = card && optionBase?.rows.find((row) => row.beat === beatId)?.cards.some((use) => library?.cards[use.card]?.category === card.category);
    setReplaceMode(!!sameCategory); setCandidate(choice); setCandidateSlots(slots); setCandidatePreview(null); setCandidateResult(null); setComparison("after");
  };

  const applyEffect = () => {
    if (!candidate || !selectedBeat || !candidatePreview || !candidateResult?.plan || confirmed || candidateIssue) return;
    if (candidate.kind === "card") {
      editOption((draft) => {
        const row = draft.rows.find((item) => item.beat === selectedBeat);
        if (!row) return;
        if (replaceMode) row.cards = row.cards.filter((use) => library?.cards[use.card]?.category !== library?.cards[candidate.id]?.category);
        row.cards.push({ card: candidate.id, slots: candidateSlots, claims: [] });
      });
    } else if (candidate.kind === "transition") updateSelection({ transitions: { ...(effective?.transitions ?? {}), [selectedBeat]: candidate.id } });
    else updateSelection({ style: candidate.id });
    setMessage(`${selectedEntry?.name ?? "效果"}已加入方案草稿，可在播放器检查。`);
    setCandidate(null); setCandidatePreview(null); setCandidateResult(null);
  };

  const onOverlayBox = (overlayId: string, rect: Rect, commit: boolean) => overlayId === "mix-presenter"
    ? updateSelection({ videoSettings: { ...effective?.videoSettings, presenter: { ...effective?.videoSettings?.presenter, box: rect } } }, commit)
    : updateSelection({ layoutOverrides: { ...(effective?.layoutOverrides ?? {}), [overlayId]: rect } }, commit);

  const confirm = async (openReview = false) => {
    if (!focus) return;
    window.clearTimeout(saveTimer.current);
    setBusy(true);
    try {
      await storyboardApi.saveSelection(projectId, round, { ...(effective ?? {}), option: focus });
      const result = await storyboardApi.confirm(projectId, round);
      setMessage(`方案已确认，生成第 ${result.revision} 次修改。可以进入精修预览。`);
      await load();
      onConfirmed();
      if (openReview) onOpenReview();
    } catch (error) {
      const problems = (error as { problems?: string[] }).problems ?? [];
      setMessage(`不能确认：${problems.join("；") || (error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const shownPreview = studio && selectedRow?.keep === false ? sourcePreview : studio && comparison === "after" && candidatePreview ? candidatePreview : preview;
  useEffect(() => {
    if (!studio || !shownPreview || !selectedBeat) return;
    const segment = shownPreview.resolved.footage.segments.find((item) => item.id.split("-").includes(selectedBeat));
    if (!segment) return;
    let target = segment.from;
    if (candidatePreview && comparison === "after" && candidate?.kind === "card") {
      const overlayPrefix = `${candidate.id.split("@")[0]}-${selectedBeat}`;
      const applied = shownPreview.resolved.overlays.find((item) => item.id === overlayPrefix || item.id.startsWith(`${overlayPrefix}-`));
      const punch = segment.camera.punchIns.find((item) => item.zoom > 1);
      target = applied ? applied.from + Math.min(15, Math.floor(applied.durationInFrames / 2)) : punch ? segment.from + punch.from + Math.min(10, Math.floor(punch.durationInFrames / 2)) : segment.from;
    }
    if (candidatePreview && comparison === "after" && candidate?.kind === "transition") {
      const transition = shownPreview.resolved.overlays.find((item) => item.id === `transition-after-${selectedBeat}`);
      target = transition ? transition.from + Math.floor(transition.durationInFrames / 2) : Math.max(segment.from, segment.from + segment.durationInFrames - 12);
    }
    if (candidate?.kind === "style") target = Math.min(segment.from + 15, segment.from + segment.durationInFrames - 1);
    const timer = window.setTimeout(() => { playerRef.current?.seekTo(target); setFrame(target); }, 80);
    return () => window.clearTimeout(timer);
  }, [studio, shownPreview, selectedBeat, candidate, candidatePreview, comparison, preview]);
  const faceZones = useMemo(
    () => (shownPreview && context?.faces ? faceZonesAt(shownPreview.resolved, Object.fromEntries(shownPreview.resolved.footage.segments.map((segment) => [segment.id, "source"])), context.faces, context.overrides, frame) : []),
    [shownPreview, context, frame],
  );

  if (!library || !beats) return <div className="loading">加载中…</div>;
  const option = options.find((item) => item.id === focus);
  const workingOption = effective?.draftOption?.id === focus ? effective.draftOption : option;
  const scenes = groupScenes(beats?.beats ?? [], words, overview.media?.durationMs);
  const styleId = effective?.style ?? option?.style;
  const beatById = new Map(beats.beats.map((beat) => [beat.id, beat]));
  const activeRow = workingOption?.rows.find((row) => row.beat === selectedBeat);
  const activeBeat = selectedBeat ? beatById.get(selectedBeat) : null;
  const availableCards = activeBeat ? Object.values(library.cards).filter((card) => card.scope === "beat" && roleMatches(card.when.roles, activeBeat.role)) : [];
  const fps = preview?.resolved.fps ?? 30;
  const gate = compiled?.gate;
  const timeLabel = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")}`;
  const selectedStyleName = styleId ? library.styles[styleId]?.name ?? styleId : "未选择";
  const draftChanged = !!effective?.draftOption || (!!effective?.style && effective.style !== option?.style) || Object.values(effective?.transitions ?? {}).some((value) => value !== "cut") || Object.keys(effective?.layoutOverrides ?? {}).length > 0 || !!effective?.videoSettings;

  const presetDialog = presetForm ? <div className="home-modal-backdrop"><form className="home-modal" onSubmit={async (event) => { event.preventDefault(); setPresetBusy(true); window.clearTimeout(saveTimer.current); try { if (!confirmed && effective && focus) await storyboardApi.saveSelection(projectId, round, { ...effective, option: focus }); const next = await storyboardApi.createPreset(projectId, presetForm); setPresetForm(null); setFocus(null); setRound(next.round); setSelectedBeat(null); setCompiled(null); setPreview(null); setStudio(false); onConfirmed(); setMessage("新方案草稿已创建，当前镜头组合保持不变。"); } catch (error) { setMessage((error as Error).message); } finally { setPresetBusy(false); } }}><h2>{presetForm.sourceRound ? "复用已定方案" : "创建新方案"}</h2><p>{presetForm.sourceRound ? "将所选方案的效果和字幕、达人设置应用到当前镜头组合，另存为新草稿。" : "使用当前镜头组合，从基础设置开始设计效果。"}</p><label>方案名称<input required maxLength={80} value={presetForm.name} onChange={(event) => setPresetForm({ ...presetForm, name: event.target.value })} /></label><div className="home-confirm-actions"><button type="button" disabled={presetBusy} onClick={() => setPresetForm(null)}>取消</button><button className="primary" disabled={presetBusy}>{presetBusy ? "正在创建…" : "创建方案"}</button></div></form></div> : null;
  if (!studio) return <div className="app desk-page plan-picker-page">
    <header>{nav}<span className="spacer" /><span className="pill state-accepted">第一步 · 选择方案</span><button onClick={() => setStudio(true)}>第二步 · 调整效果 →</button></header>
    {presetDialog}<div className="banner-slot">{message ? <div className="banner" onClick={() => setMessage(null)}>{message}</div> : null}</div>
    <div className="plan-picker-heading"><div><span className="eyebrow">STORYBOARD PLANS</span><h1>选择剪辑方案</h1><p>先看完整视频效果。满意即可进入审阅精修，也可以继续调整每个场景。</p></div>{rounds.length > 1 ? <select aria-label="方案轮次" value={round} onChange={(event) => { setFocus(null); setRound(event.target.value); setSelectedBeat(null); setCompiled(null); setPreview(null); }}>{rounds.map((item) => <option key={item} value={item}>方案第 {item.slice(1)} 轮</option>)}</select> : null}<button className="primary" onClick={() => setPresetForm({ name: "自定义方案" })}>+ 创建新方案</button></div>
    <main className="plan-picker-grid"><section className="plan-picker-list" aria-label="可选方案"><h2>本项目方案</h2>{options.map((item) => <button key={item.id} className={`plan-picker-card${focus === item.id ? " on" : ""}`} onClick={() => { setFocus(item.id); setCandidate(null); setCompiled(null); setPreview(null); }}><b>{item.title}</b><span>{library.styles[item.style]?.name ?? item.style} · {item.rows.filter((row) => row.keep).length} 段保留</span><p>{item.summary}</p><small>{item.compile.problems.length ? `${item.compile.problems.length} 个编译问题` : item.compile.gate.canConfirm ? "可确认" : "需完成确认条件"}</small></button>)}{!options.length ? <p className="muted">暂无方案，请先完成段落分类。</p> : null}<h2 className="saved-presets-heading">已定方案（本项目）</h2><p className="small muted">复用效果与字幕、达人设置，使用本次镜头组合。</p>{savedPresets.length ? savedPresets.map((item) => <button key={item.round} className="plan-picker-card saved-preset-card" onClick={() => setPresetForm({ name: (item.name + " · 复用").slice(0, 80), sourceRound: item.round })}><b>{item.name}</b><span>{library.styles[item.style]?.name ?? item.style} · 第 {item.round.slice(1)} 轮</span><small>复用到当前组合 →</small></button>) : <p className="muted small">确认一套方案后，会出现在这里供下次复用。</p>}<button className="primary" onClick={() => setPresetForm({ name: "自定义方案" })}>+ 创建新方案</button></section>
    <section className="plan-picker-preview"><div className="plan-picker-preview-head"><b>{option?.title ?? "选择方案"} · 整片预览</b><span>{preview ? `${(preview.resolved.durationInFrames / preview.resolved.fps).toFixed(1)} 秒` : "准备预览中"}</span></div>{preview ? <Stage playerRef={playerRef} preview={preview.preview} resolved={preview.resolved} frame={frame} selection={null} onSelect={() => {}} toggles={{ safeZones: false, faces: false, captionBox: false }} faceZones={faceZones} safeZones={context?.safeZones ?? null} editableFace={false} onOverlayBox={() => {}} onCaptionBox={() => {}} onFaceBox={() => {}} previewing={null} inspection={false} zoom={1} /> : <div className="stage muted">{compiled?.problems[0] ?? "正在生成整片预览…"}</div>}<div className="transport"><button className="play" disabled={!preview} onClick={() => playerRef.current?.toggle()}>{playing ? "暂停" : "播放"}</button><span className="timecode">{(frame / fps).toFixed(2)}s / {preview ? (preview.resolved.durationInFrames / fps).toFixed(1) : "—"}s</span></div></section>
    <aside className="plan-picker-details"><h2>方案说明</h2><h3>{option?.title ?? "未选择"}</h3><p>{option?.summary ?? "请选择一个方案查看说明。"}</p><dl><dt>视觉风格</dt><dd>{selectedStyleName}</dd><dt>方案状态</dt><dd>{confirmed && selection?.option === focus ? "已确认" : draftChanged ? "已修改的草稿" : "待确认"}</dd><dt>视频段落</dt><dd>{workingOption?.rows.filter((row) => row.keep).length ?? 0} 段保留</dd></dl><h3>确认前检查</h3>{compiled?.problems.length ? <ul className="gate">{compiled.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : gate?.reasons.length ? <ul className="gate">{gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : gate ? <p className="ok-line">✓ 全部满足，可以进入审阅</p> : <p className="muted">正在检查方案…</p>}<div className="plan-picker-actions"><button className="primary" disabled={!focus || busy || !gate?.canConfirm || (confirmed && selection?.option !== focus)} onClick={() => confirmed && selection?.option === focus ? onOpenReview() : confirm(true)}>{busy ? "确认中…" : confirmed && selection?.option === focus ? "直接进入审阅精修 →" : "采用方案并进入审阅 →"}</button><button disabled={!focus} onClick={() => setStudio(true)}>进入效果调整 →</button>{confirmed && selection?.option !== focus ? <p className="muted small">本轮已有确认方案；要更换方案，请先创建新轮次。</p> : null}</div></aside></main>
  </div>;

  return (
    <div className={`app desk-page${studio ? " studio-layout" : ""}`}>
      <header>
        {nav}
        <div className="studio-switch" role="group" aria-label="分镜步骤"><button onClick={() => setStudio(false)}><Layers3 size={15} /> ← 选择方案</button><button className="on" onClick={() => setStudio(true)}><WandSparkles size={15} /> 调整效果</button></div>
        {rounds.length > 1 ? <select aria-label="方案轮次" value={round} onChange={(event) => { setFocus(null); setRound(event.target.value); setSelectedBeat(null); setMessage(null); }}>{rounds.map((item) => <option key={item} value={item}>方案第 {item.slice(1)} 轮</option>)}</select> : null}
        <span className="spacer" />
        {confirmed ? (
          <>
            <span className="pill state-accepted">本轮方案已确认</span>
            {rounds[rounds.length - 1] === round ? <button onClick={async () => { try { const next = await storyboardApi.revise(projectId, round); setFocus(null); setRound(next.round); setSelectedBeat(null); setMessage(`方案第 ${next.round.slice(1)} 轮草稿已创建，可自由调整技巧。`); } catch (error) { setMessage((error as Error).message); } }}>创建自定义方案 →</button> : null}
            <button className="primary" onClick={onOpenReview}>
              进入精修预览 →
            </button>
          </>
        ) : null}
      </header>
      <div className="banner-slot">{message ? <div className="banner" onClick={() => setMessage(null)}>{message}</div> : null}</div>
      {studio ? <section className="studio-plan-header" aria-label="当前剪辑方案">
        <div className="studio-plan-identity"><span className="eyebrow">当前方案 · {round.toUpperCase()}</span><select aria-label="选择方案" value={focus ?? ""} onChange={(event) => { setFocus(event.target.value); switchBeat(options.find((item) => item.id === event.target.value)?.rows[0]?.beat ?? ""); }}><option value="" disabled>选择方案</option>{options.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <div className="studio-plan-summary"><div><span className="pill">风格：{selectedStyleName}</span><span className={`pill${confirmed ? " state-accepted" : ""}`}>{confirmed ? "已确认" : "草稿"}</span>{draftChanged ? <span className="pill">已修改</span> : null}</div><p>{workingOption?.summary ?? "还没有分镜方案"}</p></div>
        <details className="studio-plan-details"><summary>完整说明</summary><p>{workingOption?.summary}</p>{gate?.reasons.length ? <ul className="gate">{gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p className="ok-line">✓ 可以确认</p>}</details>
        <div className="studio-plan-actions">{draftChanged ? <button disabled={confirmed} onClick={() => updateSelection({ draftOption: null, style: null, transitions: {}, layoutOverrides: {}, videoSettings: undefined })}>恢复本轮初稿</button> : null}<button className="primary" disabled={confirmed || busy || !gate?.canConfirm} onClick={() => confirm()}>{confirmed ? "已确认" : busy ? "确认中…" : "确认方案"}</button></div>
      </section> : null}
      <main className={`storyboard-grid${studio ? " effects-mode" : ""}`}>
        {studio ? <nav className="studio-scenes" aria-label="场景导航"><div className="studio-scenes-head"><span className="eyebrow">SCENES</span><h2>剪辑场景</h2><small>{scenes.length} 个场景 · {workingOption?.rows.filter((row) => row.keep).length ?? 0} 段口播</small></div><div className="studio-scene-list">{scenes.map((scene, index) => { const first = scene.beats.find((beat) => workingOption?.rows.find((row) => row.beat === beat.id)?.keep) ?? scene.beats[0]; const selected = scene.beats.some((beat) => beat.id === selectedBeat); const suggestions = (SCENE_SUGGESTIONS[scene.role] ?? []).filter((id) => { const entry = entries.find((item) => item.choice.kind === "card" && item.choice.id === id); return entry && !compatibility(entry, first, optionBase, assets); }).slice(0, 2); return <div key={scene.id} className={`studio-scene${selected ? " on" : ""}`}><button className="scene-group-main" onClick={() => switchBeat(first.id)}><span className="studio-scene-top"><b>{String(index + 1).padStart(2, "0")} · {ROLE_ZH[scene.role]}</b><small>{timeLabel(scene.startMs)}–{timeLabel(scene.endMs)}</small></span><span className="studio-scene-copy">{scene.beats.map((beat) => beat.textZh ?? beat.text).join(" ")}</span><span className="studio-scene-flags"><em>{scene.beats.length} 段口播</em>{scene.beats.flatMap((beat) => workingOption?.rows.find((row) => row.beat === beat.id)?.cards ?? []).map((use, cardIndex) => <em key={`${use.card}-${cardIndex}`}>{library.cards[use.card]?.name ?? use.card}</em>)}</span></button>{selected ? <><div className="scene-suggestions"><small>推荐效果</small>{suggestions.length ? suggestions.map((id) => <button key={id} disabled={confirmed} onClick={() => { switchBeat(first.id); chooseEffect({ kind: "card", id }, first.id); }}>{library.cards[id]?.name ?? id} · 预览</button>) : <span className="muted small">保持原片节奏</span>}</div><details className="scene-beats"><summary>展开 {scene.beats.length} 段精修</summary>{scene.beats.map((beat) => <button key={beat.id} className={selectedBeat === beat.id ? "on" : ""} onClick={() => switchBeat(beat.id)}>{beat.id} · {beat.textZh ?? beat.text}</button>)}</details></> : null}</div>; })}</div></nav> : <section className="options">
          {options.length ? null : <p className="muted">还没有方案。先确认段落角色，再创建剪辑方案。</p>}
          {options.map((item) => {
            const styleName = library.styles[item.style]?.name ?? item.style;
            const blocked = item.compile.gate.reasons;
            return (
              <div key={item.id} className={`option-card${focus === item.id ? " focused" : ""}${selection?.option === item.id ? " chosen" : ""}`} onClick={() => { setFocus(item.id); setSelectedBeat(null); }}>
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
        </section>}
        <section className="sb-preview">
          {studio ? <div className="effects-preview-header"><div><span className="eyebrow">{activeRow?.keep === false ? sourcePreviewStatus : "视频预览"}</span><b>{activeBeat ? `${activeBeat.id} · ${ROLE_ZH[activeBeat.role]}` : "选择段落"}</b><select className="studio-narrow-scenes" aria-label="选择段落" value={selectedBeat ?? ""} onChange={(event) => switchBeat(event.target.value)}>{workingOption?.rows.map((row) => { const beat = beatById.get(row.beat); return <option key={row.beat} value={row.beat}>{row.beat} · {ROLE_ZH[beat?.role ?? "filler"]}{row.keep ? "" : "（已剪掉）"}</option>; })}</select></div><div className="effects-preview-tools"><div className="effects-compare" role="group" aria-label="原方案与效果预览"><button className={comparison === "before" ? "on" : ""} onClick={() => setComparison("before")}>原方案</button><button className={comparison === "after" ? "on" : ""} onClick={() => setComparison("after")} disabled={!candidatePreview || activeRow?.keep === false}>应用后</button></div><button className={inspectMode ? "on" : ""} onClick={() => setInspectMode((value) => !value)}>{inspectMode ? "检查画面" : "纯净预览"}</button><select aria-label="预览缩放" value={previewZoom} onChange={(event) => setPreviewZoom(Number(event.target.value))}><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.25}>125%</option></select></div></div> : null}
          {shownPreview ? (
            <Stage
              playerRef={playerRef}
              preview={shownPreview.preview}
              resolved={shownPreview.resolved}
              frame={frame}
              selection={element}
              onSelect={setElement}
              toggles={{ safeZones: true, faces: true, captionBox: false }}
              faceZones={faceZones}
              safeZones={context?.safeZones ?? null}
              editableFace={false}
              onOverlayBox={onOverlayBox}
              onCaptionBox={(box, commit) => updateSelection({ videoSettings: { ...effective?.videoSettings, captions: { ...effective?.videoSettings?.captions, box } } }, commit)}
              onFaceBox={() => {}}
              previewing={studio || confirmed ? null : focus ? `${focus}（方案预览）` : null}
              inspection={!studio || inspectMode}
              zoom={studio ? previewZoom : 1}
            />
          ) : (
            <div className="stage muted">{studio && activeRow?.keep === false ? sourcePreviewStatus : compiled?.problems.length ? <div className="studio-preview-error"><b>当前草稿无法预览</b><p>{compiled.problems[0]}</p>{compiled.problems.length > 1 ? <small>另有 {compiled.problems.length - 1} 个编译问题，可在“完整说明”中查看。</small> : null}</div> : "编译中…"}</div>
          )}
          <div className="transport">
            <button className="play" onClick={() => playerRef.current?.toggle()}>
              {playing ? "暂停" : "播放"}
            </button>
            <span className="timecode">
              {(frame / fps).toFixed(2)}s / {((shownPreview?.resolved.durationInFrames ?? 0) / fps).toFixed(1)}s
            </span>
          </div>
        </section>
        {studio ? <aside className="studio-creative" aria-label="创意检查器"><div className="studio-tabs" role="tablist" aria-label="创意工作区"><button role="tab" aria-selected={inspectorTab === "video"} className={inspectorTab === "video" ? "on" : ""} onClick={() => setInspectorTab("video")}>字幕与达人</button><button role="tab" aria-selected={inspectorTab === "effects"} className={inspectorTab === "effects" ? "on" : ""} onClick={() => setInspectorTab("effects")}>效果库</button><button role="tab" aria-selected={inspectorTab === "content"} className={inspectorTab === "content" ? "on" : ""} onClick={() => setInspectorTab("content")}>分镜内容</button><button role="tab" aria-selected={inspectorTab === "parameters"} className={inspectorTab === "parameters" ? "on" : ""} onClick={() => setInspectorTab("parameters")}>参数</button></div>
          <div className="studio-tab-panel" role="tabpanel" hidden={inspectorTab !== "video"}><VideoSettingsPanel plan={compiled?.plan as unknown as RawPlan ?? null} value={effective?.videoSettings ?? {}} isMix={overview.mode === "mix"} disabled={confirmed || busy} onRefreshPresenter={busy ? undefined : async () => { setBusy(true); setMessage("正在识别达人背景并生成透明图层…"); try { await createMixApi(projectId).refreshPresenter(); window.location.reload(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }} onChange={(videoSettings) => { setCandidate(null); setCandidatePreview(null); setCandidateResult(null); updateSelection({ videoSettings }); if (frame === 0 && videoSettings.captions?.enabled !== false) seek(Math.max(8, Math.ceil((words[0]?.startMs ?? 0) / 1000 * (preview?.resolved.fps ?? 30)) + 3)); }} /></div>
          <div className="studio-tab-panel" role="tabpanel" hidden={inspectorTab !== "effects"}><EffectShelf library={library} projectId={projectId} footageId={footageId} startMs={words[previewBeat?.words[0] ?? 0]?.startMs ?? 0} selected={candidate} beat={previewBeat} option={optionBase} assets={assets} onSelect={chooseEffect} /><div className="studio-library-action"><div><b>{selectedEntry?.name ?? "选择效果以预览"}</b><small>{selectedEntry ? candidateIssue ?? previewStatus : "效果在中间播放器显示"}</small></div><button onClick={() => setInspectorTab("parameters")} disabled={!selectedEntry}>调整参数</button><button className="primary" disabled={!candidatePreview || !candidateResult?.plan || !!candidateIssue || confirmed} onClick={applyEffect}>应用到草稿</button></div></div>
          <div className="studio-tab-panel studio-content" role="tabpanel" hidden={inspectorTab !== "content"}><h2>分镜内容</h2>{activeBeat && activeRow ? <><dl><dt>段落</dt><dd>{activeBeat.id} · {ROLE_ZH[activeBeat.role]}</dd><dt>中文字幕</dt><dd>{activeBeat.textZh ?? "暂无译文"}</dd><dt>英文原文</dt><dd>{activeBeat.text}</dd><dt>画面说明</dt><dd>{activeRow.onScreen || "暂无画面说明"}</dd><dt>关联素材</dt><dd>{assets?.items.filter((item) => item.neededBy.includes(activeBeat.id)).map((item) => `${item.label ?? item.id}（${item.status === "available" ? "已确认" : "待处理"}）`).join("、") || "使用原始视频"}</dd><dt>产品事实</dt><dd>{activeBeat.claims.map((claimId) => { const claim = assets?.claims.find((item) => item.id === claimId); return claim ? `${claim.text}（${claim.status === "verified" ? "已核实" : "未核实"}）` : claimId; }).join("；") || "无"}</dd></dl>{!activeRow.keep ? <p className="warn-text">该段已剪掉：{activeRow.reason}</p> : null}<h3>当前效果</h3><p>{activeRow.cards.map((use) => library.cards[use.card]?.name ?? use.card).join("、") || "尚未添加"}</p></> : <p className="muted">请先选择段落。</p>}</div>
          <div className="studio-tab-panel" role="tabpanel" hidden={inspectorTab !== "parameters"}><EffectInspector entry={selectedEntry} beat={previewBeat} option={optionBase} assets={assets} words={words} slots={candidateSlots} onSlots={setCandidateSlots} confirmed={confirmed} previewStatus={previewStatus} previewProblems={candidateResult?.problems ?? []} canApply={!!candidatePreview && !!candidateResult?.plan && !candidateIssue} onApply={applyEffect} replaceable={!!replaceable} replaceMode={replaceMode} onReplaceMode={setReplaceMode} applied={(activeRow?.cards ?? []).map((use, index) => ({ name: library.cards[use.card]?.name ?? use.card, onRemove: () => editOption((draft) => { draft.rows.find((row) => row.beat === selectedBeat)?.cards.splice(index, 1); }) }))} transitionActive={!!selectedBeat && effective?.transitions?.[selectedBeat] === "fade-black"} onClearTransition={() => selectedBeat && updateSelection({ transitions: { ...(effective?.transitions ?? {}), [selectedBeat]: "cut" } })} styleName={selectedStyleName} /></div>
        </aside> : <aside className="side">
          <div className="tab-body">
            {workingOption ? (
              <>
                <h3>{workingOption.title}</h3>
                <p className="muted small">点击下方段落，在卡片库中挑选技巧。选择后在中间播放器查看实际效果。</p>
                {effective?.draftOption || Object.values(effective?.transitions ?? {}).some((value) => value !== "cut") ? <button disabled={confirmed} onClick={() => updateSelection({ draftOption: null, transitions: {}, layoutOverrides: {} })}>恢复本轮初稿</button> : null}
                <h4>风格</h4>
                <div className="chips">
                  {Object.values(library.styles).map((style) => (
                    <button key={style.id} className={`chip${styleId === style.id ? " on" : ""}`} disabled={confirmed} title={style.description} onClick={() => updateSelection({ style: style.id === workingOption.style ? null : style.id })}>
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
                  {workingOption.rows.map((row) => {
                      const beat = beatById.get(row.beat);
                      const segment = preview?.resolved.footage.segments.find((item) => item.id.split("-").includes(row.beat));
                      return (
                        <tr key={row.beat} className={`${row.keep ? "" : "dropped"}${selectedBeat === row.beat ? " active" : ""}`} onClick={() => { setSelectedBeat(row.beat); if (segment) seek(segment.from); }}>
                          <td>
                            <b>{row.beat}</b>
                            <div className="muted small">{beat ? ROLE_ZH[beat.role] : ""}</div>
                          </td>
                          <td>
                            <div className="small">{beat?.textZh}</div>
                            <div className="small muted en">{beat?.text}</div>
                            {row.keep ? (
                              <>
                                {row.onScreen && !effective?.draftOption ? <div className="small on-screen">屏幕：{row.onScreen}</div> : null}
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
                {activeRow && activeBeat ? (
                  <section className="technique-editor">
                    <div className="beat-head"><h4>编辑 {activeBeat.id} · {ROLE_ZH[activeBeat.role]}</h4><button disabled={confirmed} onClick={() => editOption((draft) => { const row = draft.rows.find((item) => item.beat === activeBeat.id)!; row.keep = !row.keep; row.reason = row.keep ? undefined : "用户在方案台剪掉"; row.cards = row.keep ? row.cards : []; })}>{activeRow.keep ? "剪掉这段" : "恢复这段"}</button></div>
                    {activeRow.keep ? <>
                      <h4>已选技巧</h4>
                      {activeRow.cards.length ? activeRow.cards.map((use, index) => {
                        const card = library.cards[use.card];
                        return <div className="selected-technique" key={`${use.card}-${index}`}>
                          <div className="beat-head"><b>{card?.name ?? use.card}</b><button disabled={confirmed} aria-label={`移除${card?.name ?? use.card}`} onClick={() => editOption((draft) => { draft.rows.find((row) => row.beat === activeBeat.id)!.cards.splice(index, 1); })}>移除</button></div>
                          {card ? Object.entries(card.slots).map(([name, slot]) => <label className="field" key={name}>{slot.label}
                            {slot.type === "choice" ? <select disabled={confirmed} value={String(use.slots[name] ?? slot.default ?? "")} onChange={(event) => editOption((draft) => { draft.rows.find((row) => row.beat === activeBeat.id)!.cards[index].slots[name] = event.target.value; })}>{slot.options?.map((value) => <option key={value} value={value}>{value}</option>)}</select>
                              : slot.type === "asset" ? <select disabled={confirmed} value={String(use.slots[name] ?? "")} onChange={(event) => editOption((draft) => { draft.rows.find((row) => row.beat === activeBeat.id)!.cards[index].slots[name] = event.target.value; })}><option value="">选择素材</option>{assets?.items.filter((item) => item.kind === card.needs.find((need) => need.slot === name)?.kind).map((item) => <option key={item.id} value={item.id}>{item.label ?? item.id} · {item.status}</option>)}</select>
                                : slot.type === "word" ? <select disabled={confirmed} value={String(use.slots[name] ?? "")} onChange={(event) => editOption((draft) => { draft.rows.find((row) => row.beat === activeBeat.id)!.cards[index].slots[name] = Number(event.target.value); })}>{words.filter((word) => word.index >= activeBeat.words[0] && word.index <= activeBeat.words[1]).map((word) => <option key={word.index} value={word.index}>{word.text} · #{word.index}</option>)}</select>
                                  : <input disabled={confirmed} type={slot.type === "number" ? "number" : "text"} min={slot.min} max={slot.max} value={String(use.slots[name] ?? "")} onChange={(event) => editOption((draft) => { draft.rows.find((row) => row.beat === activeBeat.id)!.cards[index].slots[name] = slot.type === "number" ? Number(event.target.value) : event.target.value; })} />}
                          </label>) : null}
                        </div>;
                      }) : <p className="muted small">这一段还没有添加技巧。</p>}
                      <h4>技巧卡片库</h4>
                      <div className="technique-gallery">{availableCards.map((card) => <button key={card.id} className="technique-card" disabled={confirmed || card.status !== "ready"} onClick={() => addCard(activeBeat.id, card.id)} title={card.description}>
                        <span className={`technique-art category-${card.category}`}>
                          {footageId && words[activeBeat.words[0]] ? <img src={storyboardApi.thumbAt(projectId, footageId, words[activeBeat.words[0]].startMs)} alt="" /> : null}
                          <span>{card.name}</span>
                        </span>
                        <b>{card.name}</b><small>{card.status === "ready" ? "添加并预览" : "待开发"}</small>
                      </button>)}</div>
                      <p className="muted small">卡片封面用于识别技巧；具体效果以中间播放器为准。</p>
                      {workingOption.rows.filter((row) => row.keep).slice(-1)[0]?.beat !== activeBeat.id ? <>
                        <h4>接到下一段的转场</h4>
                        <div className="technique-gallery">
                          <button className={`technique-card${(effective?.transitions?.[activeBeat.id] ?? "cut") === "cut" ? " on" : ""}`} disabled={confirmed} onClick={() => updateSelection({ transitions: { ...(effective?.transitions ?? {}), [activeBeat.id]: "cut" } })}><span className="technique-art category-cut">切</span><b>硬切</b><small>直接进入下一段</small></button>
                          <button className={`technique-card${effective?.transitions?.[activeBeat.id] === "fade-black" ? " on" : ""}`} disabled={confirmed} onClick={() => updateSelection({ transitions: { ...(effective?.transitions ?? {}), [activeBeat.id]: "fade-black" } })}><span className="technique-art category-cut">淡</span><b>黑场淡入淡出</b><small>8 帧过渡</small></button>
                          <button className="technique-card" disabled title="快甩转场效果尚未开发"><span className="technique-art category-cut">甩</span><b>快甩转场</b><small>待开发</small></button>
                        </div>
                      </> : null}
                    </> : <p className="muted small">恢复段落后可添加技巧。</p>}
                  </section>
                ) : null}
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
                  <button className="primary" disabled={confirmed || busy || !gate?.canConfirm} onClick={() => confirm()}>
                    {confirmed ? "已确认" : busy ? "确认中…" : "确认这个方案"}
                  </button>
                  {!gate?.canConfirm && !confirmed ? <span className="muted small">素材和事实在“① 素材准备”里处理</span> : null}
                </div>
                <p className="muted small">确认后生成可预览、可渲染的方案{overview.hasPlan ? "新版本" : ""}。已确认方案可创建新轮次继续调整。</p>
              </>
            ) : null}
          </div>
        </aside>}
      </main>
    </div>
  );
};

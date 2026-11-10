import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clapperboard, RefreshCw, Shuffle, Play, Download } from "lucide-react";
import { api, createMixApi, type MixJob, type MixLibrary, type MixVariant } from "./api.ts";

export const MixDesk: React.FC<{ onHome: () => void; projectId?: string; nav?: React.ReactNode; view?: string; onView?: (view: "assets" | "storyboard" | "review" | "render") => void; onChanged?: () => void; onCreated?: (id: string) => void }> = ({ onHome, projectId, nav, view = "storyboard", onView, onChanged, onCreated }) => {
  const mixApi = useMemo(() => createMixApi(projectId), [projectId]);
  const [library, setLibrary] = useState<MixLibrary | null>(null);
  const [variants, setVariants] = useState<MixVariant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<MixJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selected = variants.find((item) => item.id === selectedId) ?? null;
  const selectedJob = [...jobs].reverse().find((job) => job.variantId === selectedId);
  const byId = useMemo(() => Object.fromEntries((library?.assets ?? []).map((asset) => [asset.id, asset])), [library]);
  const load = useCallback(async () => {
    const [data, saved, active] = await Promise.all([mixApi.library(), mixApi.variants(), mixApi.jobs()]);
    setLibrary(data); setVariants(saved); setJobs(active);
    setSelectedId((current) => current && saved.some((variant) => variant.id === current) ? current : saved.find((variant) => variant.preview)?.id ?? saved[0]?.id ?? null);
  }, [mixApi]);
  useEffect(() => { load().catch((cause) => setError((cause as Error).message)); }, [load]);
  useEffect(() => {
    if (!jobs.some((job) => job.state === "queued" || job.state === "running")) return;
    const timer = window.setInterval(() => { Promise.all([mixApi.jobs(), mixApi.variants()]).then(([active, saved]) => { setJobs(active); setVariants(saved); }).catch((cause) => setError((cause as Error).message)); }, 1200);
    return () => window.clearInterval(timer);
  }, [jobs, mixApi]);
  const create = async () => {
    setBusy(true); setError("");
    try { const made = await mixApi.create(3); setVariants((current) => [...made, ...current]); setSelectedId(made[0].id); onChanged?.(); setMessage("已生成 3 套镜头组合，点击生成预览可观看整条视频。"); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const update = async (next: MixVariant) => {
    setBusy(true); setError("");
    try { const saved = await mixApi.save(next); setVariants((current) => current.map((item) => item.id === saved.id ? saved : item)); setMessage("镜头组合已保存；请重新生成预览。"); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const replace = (slot: string, asset: string) => {
    if (!selected) return;
    update({ ...selected, selections: selected.selections.map((item) => item.slot === slot ? { ...item, asset } : item) });
  };
  const shuffleMiddle = () => {
    if (!selected || !library) return;
    const used = new Set<string>(selected.selections.filter((item, index) => index === 0 || index === selected.selections.length - 1 || selected.lockedSlots?.includes(item.slot)).map((item) => item.asset));
    const selections = selected.selections.map((item, index) => {
      if (index === 0 || index === selected.selections.length - 1 || selected.lockedSlots?.includes(item.slot)) return item;
      const group = library.slots[index].group;
      const choices = library.assets.filter((asset) => (asset.group === group || asset.group === "general") && asset.id !== item.asset && !used.has(asset.id));
      const fallback = library.assets.filter((asset) => (asset.group === group || asset.group === "general") && asset.id !== item.asset);
      const pool = choices.length ? choices : fallback;
      const asset = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length]?.id ?? item.asset;
      used.add(asset);
      return { ...item, asset };
    });
    update({ ...selected, selections });
  };
  const render = async (ids: string[], quality: "preview" | "hd" = "preview") => {
    setBusy(true); setError("");
    try { for (const id of ids) { const job = await mixApi.render(id, quality); setJobs((current) => [...current.filter((item) => item.id !== job.id), job]); } setMessage(`${ids.length} 个版本已加入生成队列。`); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const saved = await (selected.approvedRevision === selected.revision ? mixApi.unapprove(selected.id) : mixApi.approve(selected.id)); setVariants((items) => items.map((item) => item.id === saved.id ? saved : item)); setMessage("当前版本已确认，可以进入导出中心。"); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const projectImport = async () => {
    setBusy(true); setError("");
    try { const created = await api.createMixProject({ title: "车锁达人混剪", productName: "BBN 车锁", folder: "F:\\VideoAutomation\\sucai" }); onCreated?.(created.id); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const preparing = view === "setup";
  const openEffects = async () => { if (!selected) return; setBusy(true); setError(""); setMessage("正在准备实拍、达人和字幕图层…"); try { await mixApi.editor(selected.id); onChanged?.(); onView?.("storyboard"); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } };
  return <div className={`mix-page mix-view-${view}`}>
    {nav ? <header className="mix-header">{nav}</header> : <header className="mix-header"><button onClick={onHome}><ArrowLeft size={16} /> 视频项目</button><div><Clapperboard size={19} /><b>模块化混剪</b></div><span>固定口播 · 快速换开头 · 中段自由组合</span></header>}
    <main className="mix-content">
      <div className="mix-intro"><div><span className="eyebrow">PRESENTER MIX</span><h1>{(preparing || view === "assets") ? "内容与素材" : view === "review" ? "审阅精修" : view === "render" ? "导出中心" : "分镜与方案"}</h1><p>混剪 · 固定口播，快速替换开头与中段镜头。</p></div>{!preparing && view !== "render" ? <button className="primary" onClick={create} disabled={busy || !library}>+ 生成 3 个组合</button> : null}</div>
      {error ? <p className="mix-error" role="alert">{error}</p> : null}{message ? <p className="mix-message" role="status">{message}</p> : null}
      {library ? <div className="mix-source"><div><b>固定口播</b><span>{library.voice.name} · {(library.voice.durationMs / 1000).toFixed(1)} 秒 · {library.voice.captionsReady ? "机器字幕待校对" : "暂无字幕"}</span></div><div><b>达人画面</b><span>{library.actor.name} · {library.actor.keyMode === "green" ? "绿幕自动抠像" : library.actor.keyMode === "alpha" ? "透明背景" : library.actor.keyMode === "black" ? "黑底抠像" : "保留原背景"} · 时长不足时循环</span></div><div><b>可替换素材</b><span>{library.assets.filter((asset) => asset.group === "wrong").length} 条错误示范 · {library.assets.filter((asset) => asset.group === "detail").length} 条细节展示</span></div></div> : null}

      {!projectId && onCreated ? <button className="primary" disabled={busy} onClick={projectImport}>将素材创建为正式项目 →</button> : null}
      {preparing && library ? <section className="mix-asset-panel"><h2>项目素材已导入</h2>{projectId ? <label>达人文件<select value={library.actor.name} disabled={busy} onChange={async (event) => { setBusy(true); setError(""); try { await mixApi.source(event.target.value); await load(); setMessage("达人文件已更换，请重新生成预览。"); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>{library.actorOptions.map((name) => <option key={name}>{name}</option>)}</select></label> : null}<p>口播与达人画面已单独保存。下面的实拍镜头用于生成不同组合。</p><div className="mix-asset-grid">{library.assets.map((asset) => <article key={asset.id}><img src={mixApi.thumb(asset.id)} alt="" /><b>{asset.name}</b><small>{asset.group === "wrong" ? "错误示范" : asset.group === "general" ? "素材" : "细节展示"} · {(asset.durationMs / 1000).toFixed(1)} 秒</small></article>)}</div><button className="primary" onClick={() => onView?.("assets")}>进入内容与素材组镜头 →</button></section> : null}
      {!preparing && view === "storyboard" ? <section className="mix-style-card"><b>✓ 混剪</b><p>实拍铺满画面 · 达人侧边讲解 · 同一口播生成多个镜头组合</p><span>已选择此风格</span>{projectId ? <button disabled={!variants.length} onClick={() => onView?.("review")}>进入审阅精修 →</button> : null}</section> : null}
      {projectId && view === "assets" ? <div className="mix-review-actions"><button className="primary" disabled={busy || !selected} onClick={openEffects}>{busy ? "正在准备…" : "使用当前组合，进入分镜与方案 →"}</button></div> : null}
      {view === "review" && selected ? <div className="mix-review-actions"><button className="primary" disabled={busy || !selected.preview} onClick={approve}>{selected.approvedRevision === selected.revision ? "取消当前版本确认" : "确认当前版本"}</button><button onClick={() => onView?.("render")}>进入导出中心 →</button></div> : null}
      {view === "review" ? <details className="mix-comparison"><summary>并排对比已生成的版本</summary><div>{variants.filter((variant) => variant.preview).map((variant) => <article key={variant.id}><video src={mixApi.preview(variant.preview!)} controls playsInline preload="metadata" /><button onClick={() => setSelectedId(variant.id)}>{variant.name}{selectedId === variant.id ? " · 当前版本" : " · 选择"}</button></article>)}</div></details> : null}
      {view === "render" ? <section className="mix-export-panel"><h2>正式导出 · 1080 × 1920</h2><button className="primary" disabled={busy || !variants.some((item) => item.approvedRevision === item.revision)} onClick={() => render(variants.filter((item) => item.approvedRevision === item.revision).map((item) => item.id), "hd")}>批量导出已确认版本</button>{variants.map((variant) => <article key={variant.id}><b>{variant.name}</b><button disabled={busy || variant.approvedRevision !== variant.revision} onClick={() => render([variant.id], "hd")}>导出当前版本</button><small>{variant.approvedRevision === variant.revision ? "已确认" : "请先审阅确认"}</small>{[...jobs].reverse().filter((job) => job.variantId === variant.id && job.quality === "hd").slice(0, 1).map((job) => <p key={job.id}>{job.state === "failed" ? job.error : job.message}</p>)}{[...(variant.exports ?? [])].reverse().map((output) => <a key={output.file + output.createdAt} href={mixApi.preview(output.file)} download={variant.name + ".mp4"}>下载{output.revision === variant.revision ? "当前版本" : "历史版本"} {output.revision} · {output.width}×{output.height} · {output.duration.toFixed(1)} 秒</a>)}</article>)}</section> : null}
      {!preparing && view !== "render" ? <div className="mix-layout"><aside className="mix-versions"><div className="mix-section-head"><h2>混剪版本</h2><button onClick={() => render(variants.map((item) => item.id))} disabled={busy || !variants.length}>批量生成预览</button></div>{variants.map((variant) => { const job = [...jobs].reverse().find((item) => item.variantId === variant.id); return <button key={variant.id} className={`mix-version${selectedId === variant.id ? " active" : ""}`} onClick={() => setSelectedId(variant.id)}><b>{variant.name}</b><span>{job?.state === "failed" ? "生成失败" : job?.state === "running" ? job.message : job?.state === "queued" ? "排队中" : variant.preview ? "预览就绪" : "等待生成"}</span></button>; })}{!variants.length ? <p className="mix-empty">先生成 3 个组合，对比不同的开头和镜头顺序。</p> : null}</aside>
      <section className="mix-editor"><div className="mix-section-head"><div><h2>{selected?.name ?? "选择一个版本"}</h2><p>点击镜头卡更换素材；保留开头后可重新排列中段。</p></div>{selected ? <button disabled={busy} onClick={shuffleMiddle}><Shuffle size={15} /> 重组中段</button> : null}</div>
        {selected && library ? <div className="mix-hooks"><h3>快速更换开头</h3><div>{library.assets.filter((asset) => (asset.group === "wrong" || asset.group === "general")).map((asset) => <button key={asset.id} className={selected.selections[0].asset === asset.id ? "active" : ""} disabled={busy} onClick={() => replace("hook", asset.id)}><img src={mixApi.thumb(asset.id)} alt="" /><span>{asset.name}</span></button>)}</div></div> : null}
        {selected && library ? <div className="mix-slots">{library.slots.map((slot, index) => { const chosen = selected.selections[index]; const asset = byId[chosen?.asset]; return <div className="mix-slot" key={slot.id}><div className="mix-slot-head"><b>{String(index + 1).padStart(2, "0")} · {slot.label}</b><span>约 {(slot.durationMs / 1000).toFixed(1)} 秒</span><button disabled={busy} onClick={() => update({ ...selected, lockedSlots: selected.lockedSlots?.includes(slot.id) ? selected.lockedSlots.filter((id) => id !== slot.id) : [...(selected.lockedSlots ?? []), slot.id] })}>{selected.lockedSlots?.includes(slot.id) ? "已锁定" : "锁定"}</button></div><div className="mix-slot-body">{asset ? <img src={mixApi.thumb(asset.id)} alt={asset.name} /> : null}<div><small>{slot.group === "wrong" ? "错误示范" : "细节展示"}</small><select aria-label={`${slot.label}素材`} disabled={busy} value={chosen?.asset ?? ""} onChange={(event) => replace(slot.id, event.target.value)}>{library.assets.filter((item) => (item.group === slot.group || item.group === "general")).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div></div>; })}</div> : null}
      </section><aside className="mix-preview"><div className="mix-section-head"><h2>整体预览</h2>{selected ? <button className="primary" disabled={busy || selectedJob?.state === "running" || selectedJob?.state === "queued"} onClick={() => render([selected.id])}><RefreshCw size={15} /> {selected.preview ? "重新生成" : "生成预览"}</button> : null}</div>{selected?.preview ? <video key={selected.preview} src={mixApi.preview(selected.preview)} controls playsInline preload="metadata" /> : <div className="mix-preview-placeholder"><Play size={30} /><span>生成预览后，在这里观看整条视频</span></div>}{selectedJob?.state === "running" || selectedJob?.state === "queued" ? <p className="mix-progress">{selectedJob.message}</p> : null}{selectedJob?.state === "failed" ? <p className="mix-error">{selectedJob.error}</p> : null}{selected?.preview ? <a className="mix-download" href={mixApi.preview(selected.preview)} download={`${selected.name}.mp4`}><Download size={15} /> 下载此版本</a> : null}<p className="mix-note">当前文件是 540 × 960 样片。黑底抠像边缘、机器字幕及产品数字请在发布前核对。</p></aside></div> : null}
    </main>
  </div>;
};

import { useEffect, useState } from "react";
import { api, type Overview, type Version } from "./api.ts";
import { Clapperboard, Plus, Search, ArrowUpRight, Clock3, Trash2, RotateCcw } from "lucide-react";
import { nextAction, stageName, timeAgo } from "./WorkspaceUI.tsx";
import { ImportOrder } from "./ImportOrder.tsx";

type Props = { onImported: (id: string) => void; onTechniques: () => void; projects: Overview[]; onOpen: (id: string) => void; onRefresh: () => void };

export const HomeDesk: React.FC<Props> = ({ onImported, onTechniques, projects, onOpen, onRefresh }) => {
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Overview | null>(null);
  const [purging, setPurging] = useState<Awaited<ReturnType<typeof api.trash>>[number] | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof api.trash>>>([]);
  const [trashError, setTrashError] = useState("");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<{ project: Overview; version: Version }[]>([]);
  useEffect(() => { api.trash().then(setTrash).catch(() => {}); }, []);
  const refreshTrash = () => api.trash().then(setTrash).catch((cause) => setTrashError((cause as Error).message));
  const archive = async () => {
    if (!deleting) return;
    setBusy(true); setTrashError("");
    try { await api.archiveVideo(deleting.id); setDeleting(null); onRefresh(); await refreshTrash(); }
    catch (cause) { setTrashError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const restore = async (archiveId: string) => {
    setBusy(true); setTrashError("");
    try { await api.restoreVideo(archiveId); onRefresh(); await refreshTrash(); }
    catch (cause) { setTrashError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const permanentlyDelete = async () => {
    if (!purging) return;
    setBusy(true); setTrashError("");
    try { await api.permanentlyDeleteVideo(purging.archiveId); setPurging(null); await refreshTrash(); }
    catch (cause) { setTrashError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const ordered = [...projects].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  useEffect(() => {
    let cancelled = false;
    Promise.all(projects.filter((project) => project.hasPlan).map(async (project) => ({ project, versions: await api.versions(project.id).catch(() => []) }))).then((results) => {
      if (!cancelled) setHistory(results.flatMap(({ project, versions }) => versions.map((version) => ({ project, version }))).sort((a, b) => b.version.savedAt.localeCompare(a.version.savedAt)).slice(0, 5));
    });
    return () => { cancelled = true; };
  }, [projects]);
  const filtered = ordered.filter((project) => `${project.title} ${project.productName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = filtered.reduce<Record<string, Overview[]>>((all, project) => { (all[project.productName] ??= []).push(project); return all; }, {});

  return <div className="home-page">
    {importing ? <ImportOrder onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); onImported(id); }} /> : null}
    <header className="home-header"><div className="home-brand"><Clapperboard size={21} /><b>VIDEO STUDIO</b><span>视频项目</span></div><div className="home-header-actions"><button onClick={onTechniques}>风格库</button><button className="primary" onClick={() => setImporting(true)}><Plus size={16} /> 导入订单素材</button></div></header>
    <main className="home-content">
      <div className="home-intro"><p>VIDEO PROJECTS</p><h1>视频项目</h1><span>管理不同产品的视频，从上次停下的地方继续。</span></div>
      <div className="home-overview"><div><b>{projects.length}</b><span>当前项目</span></div><div><b>{projects.filter((item) => item.ready).length}</b><span>可进入工作区</span></div><div><b>{projects.filter((item) => !item.ready).length}</b><span>准备中</span></div></div>
      <div className="home-section-head"><div><h2>最近项目</h2><p>按最近修改时间排序</p></div><label className="home-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或产品" aria-label="搜索项目或产品" /></label></div>
      {!filtered.length ? <div className="home-empty">{query ? "没有找到匹配的项目" : "还没有项目。点右上角「导入订单素材」开始。"}</div> : null}
      {Object.entries(groups).map(([product, items]) => <section className="home-group" key={product}>
        <div className="home-group-head"><h2>{product}</h2><span>{items?.length ?? 0} 条视频</span></div>
        <div className="home-cards">{items?.map((item) => <article className="home-video-card" key={item.id}><button className="home-card-open" onClick={() => onOpen(item.id)} aria-label={`打开${item.title}`}>
          <div className="home-cover"><img src={item.id === "bloom10" ? "/storyboards/bloom10/b01.jpg" : `/api/projects/${item.id}/thumbs/at/source/0`} alt="项目首帧" onError={(event) => { event.currentTarget.style.display = "none"; }} /><span>9:16</span></div>
          <div className="home-card-copy"><div className="home-card-title"><b>{item.title}</b><ArrowUpRight size={17} /></div><span className="home-stage">{stageName(item.status.stage)}</span><div className="home-card-meta"><span><Clock3 size={13} /> {timeAgo(item.updatedAt)}</span><span>{item.ready ? "预览就绪" : item.previewReady ? "转录中" : "预览准备中"}</span></div><div className="home-next">下一步：{nextAction(item)}</div></div>
        </button><div className="home-card-footer"><span>{item.hasPlan ? `方案版本 ${item.revision ?? 0}` : "方案尚未确认"}</span><button className="home-card-delete" onClick={() => { setDeleting(item); setTrashError(""); }} aria-label={`删除${item.title}`}><Trash2 size={14} /> 移到回收区</button></div></article>)}</div>
      </section>)}
      <section className="home-history"><div className="home-section-head"><div><h2>项目记录</h2><p>已保存的方案版本</p></div></div><div className="history-list">{history.length ? history.map(({ project, version }) => <button key={`${project.id}-${version.revision}`} onClick={() => onOpen(project.id)}><span className="history-mark" /><span><b>{project.title} · 版本 {version.revision}</b><small>{version.note.startsWith("compiled from storyboard") ? "分镜方案已确认" : version.note.startsWith("edited in the review desk") ? "审阅区修改" : "方案已保存"}</small></span><time>{timeAgo(version.savedAt)}</time></button>) : <p className="history-empty">暂无方案版本记录</p>}</div></section>
      <section className="home-trash"><button onClick={() => { setTrashOpen((value) => !value); refreshTrash(); }}><Trash2 size={15} />{trashOpen ? "收起回收区" : `回收区（${trash.length}）`}</button>
        {trashOpen ? <div className="home-trash-list">{trash.length ? trash.map((item) => <div key={item.archiveId}><span><b>{item.title}</b> · {item.productName} · {new Date(item.archivedAt).toLocaleString("zh-CN")}</span><button disabled={busy} onClick={() => restore(item.archiveId)}><RotateCcw size={14} /> 恢复</button><button className="home-card-delete" disabled={busy} onClick={() => { setPurging(item); setTrashError(""); }} aria-label={`永久删除${item.title}`}><Trash2 size={14} /> 永久删除</button></div>) : <p>回收区为空</p>}</div> : null}
      </section>
    </main>
    {deleting ? <div className="home-modal-backdrop"><div className="home-modal" role="dialog" aria-modal="true" aria-label="删除视频"><h2>删除“{deleting.title}”？</h2><p>视频会从首页移到回收区。该视频的方案、素材和导出记录会一起保存，可随时恢复。</p>{trashError ? <p className="home-error">{trashError}</p> : null}<div className="home-confirm-actions"><button disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="home-danger" disabled={busy} onClick={archive}>{busy ? "正在移动…" : "移到回收区"}</button></div></div></div> : null}
    {purging ? <div className="home-modal-backdrop"><div className="home-modal" role="dialog" aria-modal="true" aria-label="永久删除回收区视频"><h2>永久删除“{purging.title}”？</h2><p>将删除这条回收记录中的项目方案、专属素材和导出文件。删除后无法恢复；共用原始素材不受影响。</p>{trashError ? <p className="home-error">{trashError}</p> : null}<div className="home-confirm-actions"><button disabled={busy} onClick={() => setPurging(null)}>取消</button><button className="home-danger" disabled={busy} onClick={permanentlyDelete}>{busy ? "正在删除…" : "确认永久删除"}</button></div></div></div> : null}
    {!deleting && !purging && trashError ? <div className="home-error-banner" role="alert">{trashError}<button onClick={() => setTrashError("")}>关闭</button></div> : null}
  </div>;
};

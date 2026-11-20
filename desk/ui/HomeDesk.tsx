import { useEffect, useState } from "react";
import { api, catalogApi, type Overview } from "./api.ts";
import { Clapperboard, Plus, Search, Clock3, Trash2, RotateCcw, ArrowRight } from "lucide-react";
import { timeAgo, type WorkspaceView } from "./WorkspaceUI.tsx";
import { ImportOrder } from "./ImportOrder.tsx";

// 首页：按产品分组的项目卡片。每张卡有封面帧、五步进度（素材 → 口播 → 方案 → 精修 → 导出）和「下一步」，点一下直接回到该做的那一步。

const STEPS = ["素材", "口播", "方案", "精修", "导出"];
const NEXT = ["确认素材和口播文字", "检测并确认口播清理", "生成方案，选一套", "在审阅台里精修", "导出成片或剪映草稿"];
const VIEWS: WorkspaceView[] = ["materials", "cleanup", "plan", "review", "render"];

type Props = { onImported: (id: string) => void; onTechniques: () => void; onSettings: () => void; onGo: (id: string, view: WorkspaceView) => void; projects: Overview[]; onOpen: (id: string) => void; onRefresh: () => void };

export const HomeDesk: React.FC<Props> = ({ onImported, onTechniques, onSettings, onGo, projects, onOpen, onRefresh }) => {
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Overview | null>(null);
  const [purging, setPurging] = useState<Awaited<ReturnType<typeof api.trash>>[number] | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof api.trash>>>([]);
  const [trashError, setTrashError] = useState("");
  const [query, setQuery] = useState("");
  const [assets, setAssets] = useState<Record<string, boolean>>({});
  useEffect(() => { api.trash().then(setTrash).catch(() => {}); }, []);
  // 素材是否全部确认：来自素材分类的计数（和「素材」页顶部的"已确认 N / N"是同一份数据）
  useEffect(() => { catalogApi.list().then((list) => setAssets(Object.fromEntries(list.map((c) => [c.id, c.total > 0 && c.confirmed >= c.total])))).catch(() => {}); }, [projects]);
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
  const filtered = ordered.filter((project) => `${project.title} ${project.productName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = filtered.reduce<Record<string, Overview[]>>((all, project) => { (all[project.productName] ??= []).push(project); return all; }, {});
  const progress = (item: Overview) => {
    const done = [!!assets[item.id], !!item.cleanupConfirmed, !!item.hasDrafts, !!item.hasPlan, !!item.hasExports];
    const current = done.indexOf(false);
    return { done, current: current < 0 ? 5 : current };
  };

  return <div className="home-page">
    {importing ? <ImportOrder onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); onImported(id); }} /> : null}
    <header className="home-header"><div className="home-brand"><Clapperboard size={21} /><b>VIDEO STUDIO</b><span>视频项目</span></div><div className="home-header-actions"><button onClick={onTechniques}>风格库</button><button onClick={onSettings}>API 设置</button><button className="primary" onClick={() => setImporting(true)}><Plus size={16} /> 导入订单素材</button></div></header>
    <main className="home-content">
      <div className="hm-top">
        <div className="hm-title"><h1>我的项目</h1><p>{projects.length ? `共 ${projects.length} 个项目，按最近修改排序。点卡片回到该做的那一步。` : "每个订单一个项目：导入素材，一步步做到导出。"}</p></div>
        {projects.length ? <label className="home-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或产品" aria-label="搜索项目或产品" /></label> : null}
      </div>
      {!filtered.length ? <div className="hm-empty">{query ? <p>没有找到匹配的项目。</p> : <><h2>还没有项目</h2><p>把一个订单的素材拖进来，系统会转竖屏、转文字、写描述，然后带你一步步做到导出。</p><button className="primary" onClick={() => setImporting(true)}><Plus size={16} /> 导入订单素材</button></>}</div> : null}
      {Object.entries(groups).map(([product, items]) => <section className="hm-group" key={product}>
        <div className="hm-group-head"><h2>{product}</h2><span>{items?.length ?? 0} 个项目</span></div>
        <div className="hm-cards">{items?.map((item) => {
          const { done, current } = progress(item);
          const tto = !!item.hasCatalog;
          const open = () => (tto && current < 5 ? onGo(item.id, VIEWS[current]) : tto ? onGo(item.id, "render") : onOpen(item.id));
          return <article className="hm-card" key={item.id}>
            <button className="hm-card-main" onClick={open} aria-label={`打开${item.title}`}>
              <div className="hm-cover">{item.coverAsset ? <img loading="lazy" src={catalogApi.frameUrl(item.id, item.coverAsset, 1)} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <Clapperboard size={26} />}<span>9:16</span></div>
              <div className="hm-body">
                <div className="hm-title-row"><b>{item.title}</b>{tto && current === 5 ? <i className="hm-done">已完成</i> : null}</div>
                {tto ? <>
                  <ol className="hm-steps" aria-label="进度">{STEPS.map((s, i) => <li key={s} className={done[i] ? "done" : i === current ? "now" : ""}><span>{done[i] ? "✓" : i + 1}</span><em>{s}</em></li>)}</ol>
                  <p className="hm-next">{current < 5 ? <><small>下一步</small>{NEXT[current]} <ArrowRight size={14} /></> : <><small>全部步骤已完成</small>交付前再对一遍自查清单</>}</p>
                </> : <p className="hm-next"><small>旧项目</small>没有素材分类，只能查看</p>}
                <div className="hm-meta"><span><Clock3 size={13} /> {timeAgo(item.updatedAt)}</span>{item.hasPlan ? <span>方案版本 {item.revision ?? 0}</span> : null}</div>
              </div>
            </button>
            <button className="hm-trash" onClick={() => { setDeleting(item); setTrashError(""); }} aria-label={`删除${item.title}`} title="移到回收区"><Trash2 size={14} /></button>
          </article>;
        })}</div>
      </section>)}
      <section className="home-trash"><button onClick={() => { setTrashOpen((value) => !value); refreshTrash(); }}><Trash2 size={15} />{trashOpen ? "收起回收区" : `回收区（${trash.length}）`}</button>
        {trashOpen ? <div className="home-trash-list">{trash.length ? trash.map((item) => <div key={item.archiveId}><span><b>{item.title}</b> · {item.productName} · {new Date(item.archivedAt).toLocaleString("zh-CN")}</span><button disabled={busy} onClick={() => restore(item.archiveId)}><RotateCcw size={14} /> 恢复</button><button className="home-card-delete" disabled={busy} onClick={() => { setPurging(item); setTrashError(""); }} aria-label={`永久删除${item.title}`}><Trash2 size={14} /> 永久删除</button></div>) : <p>回收区为空</p>}</div> : null}
      </section>
    </main>
    {deleting ? <div className="home-modal-backdrop"><div className="home-modal" role="dialog" aria-modal="true" aria-label="删除视频"><h2>删除“{deleting.title}”？</h2><p>视频会从首页移到回收区。该视频的方案、素材和导出记录会一起保存，可随时恢复。</p>{trashError ? <p className="home-error">{trashError}</p> : null}<div className="home-confirm-actions"><button disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="home-danger" disabled={busy} onClick={archive}>{busy ? "正在移动…" : "移到回收区"}</button></div></div></div> : null}
    {purging ? <div className="home-modal-backdrop"><div className="home-modal" role="dialog" aria-modal="true" aria-label="永久删除回收区视频"><h2>永久删除“{purging.title}”？</h2><p>将删除这条回收记录中的项目方案、专属素材和导出文件。删除后无法恢复；共用原始素材不受影响。</p>{trashError ? <p className="home-error">{trashError}</p> : null}<div className="home-confirm-actions"><button disabled={busy} onClick={() => setPurging(null)}>取消</button><button className="home-danger" disabled={busy} onClick={permanentlyDelete}>{busy ? "正在删除…" : "确认永久删除"}</button></div></div></div> : null}
    {!deleting && !purging && trashError ? <div className="home-error-banner" role="alert">{trashError}<button onClick={() => setTrashError("")}>关闭</button></div> : null}
  </div>;
};

import { useEffect, useState, type FormEvent } from "react";
import { api, type Overview, type Version, type MixLibrary } from "./api.ts";
import { Clapperboard, Plus, Search, ArrowUpRight, Clock3, Trash2, RotateCcw } from "lucide-react";
import { nextAction, stageName, timeAgo } from "./WorkspaceUI.tsx";

type Props = { projects: Overview[]; onOpen: (id: string) => void; onCreated: (id: string) => void; onRefresh: () => void };

export const HomeDesk: React.FC<Props> = ({ projects, onOpen, onCreated, onRefresh }) => {
  const [mixSource, setMixSource] = useState<MixLibrary | null>(null);
  const [mixActor, setMixActor] = useState("");
  const [mixVoice, setMixVoice] = useState("");
  const [mixStyle, setMixStyle] = useState(false);
  const [mixFolder, setMixFolder] = useState("F:\\VideoAutomation\\sucai");
  const [creating, setCreating] = useState(false);
  const [productName, setProductName] = useState("");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("auto");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mixStyle && !mixSource) return setError("请先检测素材并选择口播与达人文件");
    if (!mixStyle && !file) return setError("请选择口播视频");
    setBusy(true); setError("");
    try { const result = mixStyle ? await api.createMixProject({ title: title.trim(), productName: productName.trim(), folder: mixFolder, actorName: mixActor, voiceName: mixVoice }) : await api.createVideo({ title: title.trim(), productName: productName.trim(), language, file: file! }); onCreated(result.id); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  return <div className="home-page">
    <header className="home-header"><div className="home-brand"><Clapperboard size={21} /><b>VIDEO STUDIO</b><span>视频项目</span></div><button className="primary" onClick={() => setCreating(true)}><Plus size={16} /> 新建项目</button></header>
    <main className="home-content">
      <div className="home-intro"><p>VIDEO PROJECTS</p><h1>视频项目</h1><span>管理不同产品的视频，从上次停下的地方继续。</span></div>
      <div className="home-overview"><div><b>{projects.length}</b><span>当前项目</span></div><div><b>{projects.filter((item) => item.ready).length}</b><span>可进入工作区</span></div><div><b>{projects.filter((item) => !item.ready).length}</b><span>准备中</span></div></div>
      <div className="home-section-head"><div><h2>最近项目</h2><p>按最近修改时间排序</p></div><label className="home-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或产品" aria-label="搜索项目或产品" /></label></div>
      {!filtered.length ? <div className="home-empty">{query ? "没有找到匹配的项目" : "还没有项目。上传口播视频即可开始。"}</div> : null}
      {Object.entries(groups).map(([product, items]) => <section className="home-group" key={product}>
        <div className="home-group-head"><h2>{product}</h2><span>{items?.length ?? 0} 条视频</span></div>
        <div className="home-cards">{items?.map((item) => <article className="home-video-card" key={item.id}><button className="home-card-open" onClick={() => onOpen(item.id)} aria-label={`打开${item.title}`}>
          <div className="home-cover"><img src={item.mode === "mix" ? `/api/projects/${item.id}/mix/thumbs/wrong-1` : item.id === "bloom10" ? "/storyboards/bloom10/b01.jpg" : `/api/projects/${item.id}/thumbs/at/source/0`} alt="项目首帧" onError={(event) => { event.currentTarget.style.display = "none"; }} /><span>9:16</span></div>
          <div className="home-card-copy"><div className="home-card-title"><b>{item.title}</b><ArrowUpRight size={17} /></div><span className="home-stage">{item.mode === "mix" ? "混剪 · " : ""}{stageName(item.status.stage)}</span><div className="home-card-meta"><span><Clock3 size={13} /> {timeAgo(item.updatedAt)}</span><span>{item.ready ? "预览就绪" : item.previewReady ? "转录中" : "预览准备中"}</span></div><div className="home-next">下一步：{nextAction(item)}</div></div>
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
    {creating ? <div className="home-modal-backdrop" onClick={() => !busy && setCreating(false)}><form className="home-modal" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
      <div className="home-modal-head"><h2>新建视频</h2><button type="button" onClick={() => setCreating(false)} disabled={busy}>关闭</button></div>
      <p>{mixStyle ? "检测口播、达人和素材，选择后创建混剪项目。" : "上传口播视频，系统自动检测、转录并准备基础方案。"}</p>
      <label>剪辑风格<select value={mixStyle ? "mix" : "talk"} onChange={(event) => setMixStyle(event.target.value === "mix")}><option value="talk">口播精剪</option><option value="mix">混剪</option></select></label>
      <label>产品名称<input required maxLength={100} value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="例如：Bloom10 软糖" /></label>
      <label>视频名称<input required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：达人口播 11 月第一版" /></label>
      {mixStyle ? <label>素材文件夹<input required value={mixFolder} onChange={(event) => { setMixFolder(event.target.value); setMixSource(null); }} /><small>检测“口播、达人、素材”三个文件夹，选择后导入。</small><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const data = await api.inspectMixFolder(mixFolder); setMixSource(data); setMixActor(data.actor.name); setMixVoice(data.voice.name); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>检测素材</button>{mixSource ? <><span>口播</span><select value={mixVoice} onChange={(event) => setMixVoice(event.target.value)}>{mixSource.voiceOptions.map((name) => <option key={name}>{name}</option>)}</select><span>达人</span><select value={mixActor} onChange={(event) => setMixActor(event.target.value)}>{mixSource.actorOptions.map((name) => <option key={name}>{name}</option>)}</select><span>素材（{mixSource.assets.length} 个视频）</span><div className="mix-detected-materials">{mixSource.assets.map((asset) => <span key={asset.id}>{asset.name}</span>)}</div></> : null}</label> : <><label>口播视频<input required type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <label>语言<select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">自动识别</option><option value="en">英语</option><option value="zh">中文</option></select></label></>}
      {error ? <p className="home-error">{error}</p> : null}
      <button className="primary" disabled={busy}>{busy ? "正在导入…" : "导入并开始准备"}</button>
    </form></div> : null}
  </div>;
};

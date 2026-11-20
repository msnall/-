import { useEffect, useRef, useState } from "react";
import { inboxApi, orderApi, type ImportRun, type Inbox, type InboxCategory } from "./api.ts";

// 导入订单素材：① 按分类把视频拖进四个框（达人口播 / 达人动作 / 游戏录屏 / 官方素材）→ 入库、转录、模型描述 → 进入「素材」。
// 也可以直接填一个已有的 TikTok One 订单文件夹路径（只读，不复制）。

const LAST = "va.lastOrderFolder", LAST_ORDER = "va.lastInboxOrder";
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const ACCEPT: Record<string, string> = { talk: "video/*,.mov", action: "video/*,.mov", screen: "video/*,.mov", official: "video/*,.mov,image/*", script: ".txt,.md,text/plain" };
const ICON: Record<string, string> = { talk: "🎙", action: "🤚", screen: "📱", official: "🏷", script: "📝" };

type Upload = { name: string; category: string; done: number; total: number };

export const ImportOrder: React.FC<{ onClose: () => void; onDone: (id: string) => void }> = ({ onClose, onDone }) => {
  const [mode, setMode] = useState<"drop" | "folder">("drop");
  const [folder, setFolder] = useState(() => localStorage.getItem(LAST) ?? "");
  const [product, setProduct] = useState("");
  const [orders, setOrders] = useState<{ order: string; files: number }[]>([]);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [creator, setCreator] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [queued, setQueued] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const [run, setRun] = useState<(ImportRun & { id?: string }) | null>(null);
  const [error, setError] = useState("");
  const running = run?.state === "running";
  const busy = running || !!upload;
  const chosen = useRef<string>("talk");
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inboxApi.list().then((list) => {
      setOrders(list);
      const last = localStorage.getItem(LAST_ORDER);
      if (last && list.some((o) => o.order === last)) inboxApi.get(last).then((i) => { setInbox(i); setCreator(i.creator); }).catch(() => {});
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!run?.id || run.state !== "running") return;
    const timer = window.setTimeout(() => orderApi.status(run.id!).then((s) => setRun({ ...s, id: run.id })).catch((e) => setError(e.message)), 2500);
    return () => window.clearTimeout(timer);
  }, [run]);

  const openOrder = async (order: string) => { setError(""); try { const i = await inboxApi.get(order); localStorage.setItem(LAST_ORDER, order); setInbox(i); setCreator(i.creator); } catch (e) { setError((e as Error).message); } };
  const createOrder = async () => {
    setError("");
    try { const i = await inboxApi.create(product); localStorage.setItem(LAST_ORDER, i.order); setInbox(i); setOrders((o) => [{ order: i.order, files: 0 }, ...o.filter((x) => x.order !== i.order)]); } catch (e) { setError((e as Error).message); }
  };
  const addFiles = async (category: InboxCategory, files: File[]) => {
    if (!inbox || !files.length) return;
    setError("");
    const usable = files.filter((f) => f.size > 0 && (category.id === "script" ? /\.(txt|md)$/i.test(f.name) : category.id === "official" ? /^(video|image)\//.test(f.type) || /\.(mov|mp4|m4v|webm|png|jpe?g|webp)$/i.test(f.name) : /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name)));
    const skipped = files.length - usable.length;
    let current = inbox;
    setQueued(usable.length);
    try {
      for (const [n, file] of usable.entries()) {
        setUpload({ name: file.name, category: category.id, done: 0, total: file.size });
        current = await inboxApi.upload(inbox.order, category.id, file, creator, (done) => setUpload({ name: file.name, category: category.id, done, total: file.size }));
        setInbox(current); setQueued(usable.length - n - 1);
      }
      if (skipped) setError(`有 ${skipped} 个文件不是「${category.label}」能收的格式（文件夹不能直接拖，请打开文件夹后选中里面的文件再拖）。`);
    } catch (e) { setError((e as Error).message); }
    finally { setUpload(null); setQueued(0); }
  };
  const remove = async (rel: string) => { if (!inbox) return; try { setInbox(await inboxApi.remove(inbox.order, rel)); } catch (e) { setError((e as Error).message); } };
  const total = inbox?.categories.reduce((n, c) => n + c.files.length, 0) ?? 0;
  const talks = inbox?.categories.find((c) => c.id === "talk")?.files.length ?? 0;
  const start = async () => {
    setError("");
    try {
      if (mode === "folder") { localStorage.setItem(LAST, folder.trim()); setRun(await orderApi.import(folder)); }
      else setRun(await inboxApi.import(inbox!.order));
    } catch (e) { setError((e as Error).message); }
  };

  return <div className="home-modal-backdrop" onClick={() => !busy && onClose()}>
    <div className="home-modal import-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="导入订单素材">
      <div className="home-modal-head"><h2>导入订单素材</h2><button type="button" onClick={onClose} disabled={busy}>关闭</button></div>
      <div className="seg import-mode" role="group" aria-label="导入方式"><button className={mode === "drop" ? "on" : ""} disabled={busy} onClick={() => setMode("drop")}>拖入素材</button><button className={mode === "folder" ? "on" : ""} disabled={busy} onClick={() => setMode("folder")}>已有订单文件夹</button></div>

      {mode === "folder" ? <>
        <p>选一个 TikTok One 订单文件夹（里面有「02_官方素材」「04_达人回片」等）。程序只读取它，不复制。</p>
        <label>订单文件夹的完整路径<input value={folder} onChange={(e) => setFolder(e.target.value)} disabled={busy} placeholder="F:\TiktokOne订单\2026-10_Kika-Keyboard" spellCheck={false} /></label>
      </> : !inbox ? <>
        <p>先给这条订单起个名字（产品名），再把视频按类别拖进去。素材会复制到本项目的 <code>inbox</code> 文件夹，原文件不动。</p>
        <label>产品名称<input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="例如：Kika Keyboard" onKeyDown={(e) => e.key === "Enter" && product.trim() && createOrder()} /></label>
        <button className="primary" disabled={!product.trim()} onClick={createOrder}>新建订单</button>
        {orders.length ? <label>或者继续之前的订单<select value="" onChange={(e) => e.target.value && openOrder(e.target.value)}><option value="">选择…</option>{orders.map((o) => <option key={o.order} value={o.order}>{o.order}（{o.files} 个素材）</option>)}</select></label> : null}
      </> : <>
        <p className="import-order-name"><b>{inbox.order}</b> 把视频拖进下面的框里，也可以点框选择文件。<button type="button" disabled={busy} onClick={() => setInbox(null)}>换一个订单</button></p>
        <div className="drop-grid">{inbox.categories.map((c) => <section key={c.id} className={`drop-zone${over === c.id ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(c.id); }} onDragLeave={() => setOver((cur) => (cur === c.id ? null : cur))}
          onDrop={(e) => { e.preventDefault(); setOver(null); addFiles(c, [...e.dataTransfer.files]); }}>
          <header><b>{ICON[c.id]} {c.label}</b><small>{c.hint}</small></header>
          <button type="button" className="drop-pick" disabled={busy} onClick={() => { chosen.current = c.id; if (picker.current) { picker.current.accept = ACCEPT[c.id]; picker.current.click(); } }}>{c.files.length ? "＋ 再拖入或点此添加" : "拖到这里，或点此选择文件"}</button>
          {c.files.length ? <ul>{c.files.map((f) => <li key={f.rel}><span title={f.name}>{f.name}</span><small>{size(f.bytes)}</small><button type="button" title="从素材箱移除（不影响原文件）" disabled={busy} onClick={() => remove(f.rel)}>×</button></li>)}</ul> : null}
          {c.id === "talk" ? <label className="drop-creator">达人名字（可选）<input value={creator} disabled={busy} onChange={(e) => setCreator(e.target.value)} placeholder="例如：Kelsie" /></label> : null}
        </section>)}</div>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { const c = inbox.categories.find((x) => x.id === chosen.current); if (c) addFiles(c, [...(e.target.files ?? [])]); e.target.value = ""; }} />
        {upload ? <div className="drop-progress"><div style={{ width: `${Math.round((upload.done / upload.total) * 100)}%` }} /><span>正在上传 {upload.name} · {Math.round((upload.done / upload.total) * 100)}%{queued ? `（后面还有 ${queued} 个）` : ""}</span></div> : null}
        <p className="catalog-hint">至少要有一条达人口播。官方素材里的 logo、截图也可以拖进来。口播文案不用单独放，系统会从口播里转写出来。</p>
      </>}

      {run?.steps?.length ? <ol className="director-steps import-steps">{run.steps.map((s) => <li key={s.name} className={s.state}><span>{s.state === "done" ? "✓" : s.state === "running" ? "…" : s.state === "failed" ? "✕" : "·"}</span>{s.name}</li>)}</ol> : null}
      {running ? <p className="catalog-hint">4K 视频要转码，通常 1–3 分钟，请不要关闭页面。</p> : null}
      {error || run?.error ? <p className="home-error">{error || run?.error}</p> : null}
      {run?.state === "done" ? <><p className="notice settings-ok">导入完成。{run.note ? ` ${run.note}` : ""}</p><button className="primary" onClick={() => onDone(run.id!)}>进入「素材」→</button></>
        : <button className="primary" disabled={busy || (mode === "folder" ? !folder.trim() : !inbox || !talks)} title={mode === "drop" && inbox && !talks ? "先拖入至少一条达人口播" : undefined} onClick={start}>{running ? "导入中…" : upload ? "上传中…" : mode === "drop" && inbox ? `开始导入（${total} 个素材）` : "开始导入"}</button>}
    </div>
  </div>;
};

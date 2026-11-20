import { useState } from "react";
import { capcutApi, type DirectorDraft } from "./api.ts";

// 多选导出剪映草稿：勾选几套方案，各生成一份剪映草稿（可同时放进剪映草稿箱）。
// 用的是方案草稿原样，不经过审阅台，所以字幕样式、主题是默认值；需要精修的那套，再单独「放进审阅精修」。

type Result = { variant: string; label: string; name: string; built: boolean; installed: boolean; error: string | null };

export const ExportDrafts: React.FC<{ projectId: string; drafts: DirectorDraft[]; busy: boolean }> = ({ projectId, drafts, busy }) => {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [install, setInstall] = useState(true);
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState("");
  const toggle = (v: string) => setPicked((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  const stale = drafts.filter((d) => picked.includes(d.variant) && d.stale);
  const go = async () => {
    setWorking(true); setError(""); setResults(null);
    try { setResults((await capcutApi.buildVariants(projectId, picked, install)).results); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  };
  return <section className="plan-export">
    <button className="plan-export-toggle" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} 导出为剪映草稿（可多选）</button>
    {open ? <div className="plan-export-body">
      <p className="catalog-hint">勾选几套方案，各生成一份剪映草稿，名字是「项目名 + 方案名」。用的是方案草稿原样（不经过审阅台，字幕样式、主题是默认值）；其中要精修的那套，再单独「选这一版 → 放进审阅精修」。</p>
      <div className="plan-export-list">{drafts.map((d) => <label key={d.variant}><input type="checkbox" checked={picked.includes(d.variant)} disabled={working || busy} onChange={() => toggle(d.variant)} /> {d.label}{d.direction?.followsStyleCard ? "（照卡）" : ""}<small>{d.blurb}</small></label>)}</div>
      <label className="plan-export-install"><input type="checkbox" checked={install} disabled={working} onChange={(e) => setInstall(e.target.checked)} /> 同时放进剪映草稿箱（剪映正在运行时放不进去，会提示；关掉剪映再放就行）</label>
      {stale.length ? <p className="notice settings-bad">{stale.map((d) => d.label).join("、")} 是在素材、文案或口播清理改动之前生成的，建议先重新生成方案。</p> : null}
      <div className="catalog-actions"><button className="primary" disabled={!picked.length || working || busy} onClick={go}>{working ? `正在生成 ${picked.length} 份…（每份约 10–20 秒）` : `生成所选 ${picked.length} 份剪映草稿`}</button></div>
      {error ? <p className="notice settings-bad">{error}</p> : null}
      {results ? <ul className="plan-export-results">{results.map((r) => <li key={r.variant} className={r.error ? "bad" : "ok"}><b>{r.name}</b> {r.built ? (r.installed ? "· 已生成并放进剪映草稿箱" : "· 已生成（在「⑤ 导出」的剪映草稿里可以放进草稿箱）") : ""}{r.error ? <span> · {r.error}</span> : null}</li>)}</ul> : null}
    </div> : null}
  </section>;
};

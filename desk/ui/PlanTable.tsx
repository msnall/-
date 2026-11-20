import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, catalogApi, tableApi, type DirectorDraft, type PlanTableData, type TableRow, type TableShot } from "./api.ts";

// 表格方案：一套方案按口播一句一行，列出 时间 / 口播 / 画面 / 效果 / 字幕 / 音效。
// 整套选，或者逐行改；改完点「保存并更新」，直接写回时间线文件并重新编译，再放进审阅精修。

const SLOT: Record<string, string> = { "top-left": "左上", "top-right": "右上", "lower-left": "左下", "lower-right": "右下" };
const SFX: Record<string, string> = { auto: "自动", none: "无", whoosh: "嗖 whoosh", pop: "叮 pop" };
const ZOOMS: [string, string][] = [["", "自动"], ["1", "不推近"], ["1.1", "推近 110%"], ["1.15", "推近 115%"], ["1.2", "推近 120%"]];
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const secs = (ms: number) => Number((ms / 1000).toFixed(2));

type Edit = Partial<Pick<TableRow, "broll" | "zoom" | "sfx" | "emphasis">>;
type Props = { projectId: string; draft: DirectorDraft; busy: boolean; applied: boolean; onSaved: () => void; onApply: () => void; onOptions: (body: { logo?: boolean; layout?: "full" | "pip" }) => void };

export const PlanTable: React.FC<Props> = ({ projectId, draft, busy, applied, onSaved, onApply, onOptions }) => {
  const [table, setTable] = useState<PlanTableData | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const load = useCallback(() => tableApi.get(projectId, draft.variant).then((t) => { setTable(t); setEdits({}); setProblems([]); }).catch((e) => setMessage(e.message)), [projectId, draft.variant]);
  useEffect(() => { setTable(null); load(); }, [load, draft.builtAt, draft.logo, draft.stats.pip, draft.stats.full]);
  const assets = useMemo(() => new Map((table?.assets ?? []).map((a) => [a.id, a])), [table]);
  if (!table) return <p className="catalog-hint">{message || "加载中…"}</p>;
  const dirty = Object.keys(edits).length;
  const val = <K extends keyof Edit>(row: TableRow, key: K): NonNullable<TableRow[K]> | TableRow[K] => (edits[row.id]?.[key] !== undefined ? edits[row.id][key] : row[key]) as TableRow[K];
  const set = (row: TableRow, part: Edit) => setEdits((cur) => ({ ...cur, [row.id]: { ...cur[row.id], ...part } }));
  const shots = (row: TableRow) => val(row, "broll") as TableShot[];
  const setShot = (row: TableRow, n: number, part: Partial<TableShot>) => set(row, { broll: shots(row).map((s, k) => (k === n ? { ...s, ...part } : s)) });
  const addShot = (row: TableRow) => {
    const a = table.assets[0]; if (!a) return;
    const current = shots(row);
    const last = current[current.length - 1];
    const atMs = last ? Math.min(row.lengthMs - 600, last.atMs + last.durationMs) : 0;
    set(row, { broll: [...shots(row), { asset: a.id, srcStartMs: 0, atMs: Math.max(0, atMs), durationMs: Math.min(1500, Math.max(600, row.lengthMs - Math.max(0, atMs))), layout: "full", slot: null }] });
  };
  const toggleWord = (row: TableRow, word: string) => {
    const now = val(row, "emphasis") as string[];
    const has = now.some((w) => norm(w) === norm(word));
    set(row, { emphasis: has ? now.filter((w) => norm(w) !== norm(word)) : [...now, word] });
  };
  const save = async () => {
    setSaving(true); setProblems([]); setMessage("");
    try {
      await tableApi.save(projectId, draft.variant, { rows: Object.entries(edits).map(([id, e]) => ({ id, ...e })) });
      setMessage("已保存，并重新编译了这一套"); await load(); onSaved();
    } catch (error) {
      const e = error as ApiError;
      setProblems(e.problems?.length ? e.problems : [e.message]);
    } finally { setSaving(false); }
  };
  const mostlyPip = draft.stats.pip > 0 && draft.stats.pip >= draft.stats.full;
  const frameOf = (s: TableShot) => { const a = assets.get(s.asset); return a ? Math.max(0, Math.min(3, Math.floor((s.srcStartMs / a.durationMs) * 4))) : 0; };
  return <section className={`pt${applied ? " applied" : ""}`}>
    <header className="pt-head">
      <div><h3>{table.label}</h3><p>{draft.blurb} · {(table.totalMs / 1000).toFixed(1)} 秒 · {draft.stats.shots ? `录屏镜头 ${draft.stats.shots} 个（全屏 ${draft.stats.full}，画中画 ${draft.stats.pip}）` : "全程是达人画面"}</p></div>
      <div className="plan-options">
        <label><input type="checkbox" checked={draft.logo} disabled={busy || saving || !!dirty} onChange={(e) => onOptions({ logo: e.target.checked })} /> 常驻品牌图标</label>
        <span className="seg" role="group" aria-label="全部镜头的样式"><button className={!mostlyPip ? "on" : ""} disabled={busy || saving || !!dirty} onClick={() => onOptions({ layout: "full" })}>全部全屏</button><button className={mostlyPip ? "on" : ""} disabled={busy || saving || !!dirty} onClick={() => onOptions({ layout: "pip" })}>全部画中画</button></span>
      </div>
    </header>
    {draft.notes ? <p className="plan-notes">模型说明：{draft.notes}</p> : null}
    <div className="pt-scroll"><table className="pt-table">
      <thead><tr><th>时间</th><th>口播内容</th><th>画面</th><th>效果</th><th>字幕</th><th>音效</th></tr></thead>
      <tbody>{table.rows.map((row) => {
        const changed = !!edits[row.id];
        const emph = val(row, "emphasis") as string[];
        return <tr key={row.id} className={changed ? "changed" : ""}>
          <td className="pt-time">{secs(row.startMs)}–{secs(row.startMs + row.lengthMs)}s<small>{secs(row.lengthMs)}s</small></td>
          <td className="pt-text">{row.text}{row.logoAtMs !== null ? <span className="beat-shot logo">品牌图标出现</span> : null}</td>
          <td className="pt-shots">
            {shots(row).length ? shots(row).map((s, n) => <div key={n} className="pt-shot">
              <img loading="lazy" alt="" src={catalogApi.frameUrl(projectId, s.asset, frameOf(s))} />
              <div>
                <select value={s.asset} onChange={(e) => setShot(row, n, { asset: e.target.value, srcStartMs: 0 })}>{table.assets.map((a) => <option key={a.id} value={a.id} title={a.description}>{a.title.replace(/^视频_/, "").replace(/\.\w+$/, "")}</option>)}</select>
                <select value={s.layout} onChange={(e) => setShot(row, n, { layout: e.target.value as "full" | "pip", slot: e.target.value === "pip" ? (s.slot ?? "top-right") : null })}><option value="full">全屏</option><option value="pip">画中画</option></select>
                {s.layout === "pip" ? <select value={s.slot ?? "top-right"} onChange={(e) => setShot(row, n, { slot: e.target.value })}>{Object.entries(SLOT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : null}
                <label>从本句第<input type="number" step={0.1} min={0} value={secs(s.atMs)} onChange={(e) => setShot(row, n, { atMs: Math.round(Number(e.target.value) * 1000) })} />秒</label>
                <label>放<input type="number" step={0.1} min={0.4} value={secs(s.durationMs)} onChange={(e) => setShot(row, n, { durationMs: Math.round(Number(e.target.value) * 1000) })} />秒</label>
                <label title="从这条录屏的第几秒开始放">素材起点<input type="number" step={0.1} min={0} value={secs(s.srcStartMs)} onChange={(e) => setShot(row, n, { srcStartMs: Math.round(Number(e.target.value) * 1000) })} />秒</label>
                <button title="删除这个镜头" onClick={() => set(row, { broll: shots(row).filter((_, k) => k !== n) })}>×</button>
              </div>
            </div>) : <div className="pt-creator"><img loading="lazy" alt="" src={catalogApi.frameAtUrl(projectId, row.voice.asset, row.voice.atMs)} /><span>达人出镜<small>这一句不插画，保持达人画面</small></span></div>}
            <button className="pt-add" disabled={!table.assets.length} onClick={() => addShot(row)}>＋ 加一个镜头</button>
          </td>
          <td><select value={val(row, "zoom") === null ? "" : String(val(row, "zoom"))} onChange={(e) => set(row, { zoom: e.target.value === "" ? null : Number(e.target.value) })}>{ZOOMS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></td>
          <td className="pt-caption">
            <div className="pt-words">{row.words.map((w, i) => <button key={i} className={emph.some((e) => norm(e) === norm(w)) ? "on" : ""} title="点一下：字幕里高亮这个词" onClick={() => toggleWord(row, w)}>{w}</button>)}</div>
          </td>
          <td><select value={val(row, "sfx") as string} onChange={(e) => set(row, { sfx: e.target.value as TableRow["sfx"] })}>{Object.entries(SFX).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
        </tr>;
      })}</tbody>
    </table></div>
    <p className="catalog-hint">口播内容在「① 素材」里校对，这里不改。推近「自动」是近景和中景交替；字幕只高亮你点中的词；音效「自动」是每个插画出现处一个 whoosh、图标出现处一个 pop，会写进剪映草稿（网页渲染的成片不含音效）。</p>
    {problems.length ? <div className="notice settings-bad"><b>有几处没法保存：</b><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div> : null}
    {message ? <p className="notice settings-ok">{message}</p> : null}
    <footer className="pt-foot">
      {dirty ? <span className="pt-dirty">改了 {dirty} 行，还没保存</span> : <span className="catalog-hint">没有未保存的修改</span>}
      <button disabled={!dirty || saving} onClick={save}>{saving ? "保存并重新编译中…" : "保存并更新这一套"}</button>
      <button disabled={!dirty || saving} onClick={() => { setEdits({}); setProblems([]); }}>放弃修改</button>
      {draft.stale ? <span className="notice settings-bad">这套之后，素材、文案或口播清理又改过了，请先重新生成方案。</span> : null}
      <button className="primary" style={{ marginLeft: "auto" }} disabled={busy || saving || !!dirty || draft.stale} title={dirty ? "先保存修改" : undefined} onClick={onApply}>{applied ? "再次放进审阅精修" : "选这一版 → 放进审阅精修"}</button>
    </footer>
  </section>;
};

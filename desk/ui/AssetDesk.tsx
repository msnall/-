import { useCallback, useEffect, useRef, useState } from "react";
import { SIMPLE_ROLES, SIMPLE_ROLE_LABEL, simpleRole } from "../../src/engine/beat-roles.ts";
import { api, storyboardApi, type Assets, type Beats, type Overview } from "./api.ts";

// ① Asset prep: confirm the beats (what each part of the talk does), approve
// or reject candidate stills, upload what is missing, verify product claims,
// and print the shot list.

const ROLE_ZH: Record<string, string> = {
  hook: "钩子", intro: "开场介绍", pain: "痛点", benefit: "卖点", proof: "证明", product: "产品", dose: "用量", offer: "优惠", cta: "行动号召", filler: "过渡",
};
const STATUS_ZH: Record<string, string> = { available: "已有", candidate: "待确认", missing: "缺失" };
const CLAIM_ZH: Record<string, string> = { unverified: "未核实", verified: "已核实", rejected: "不成立" };

type Props = { projectId: string; overview: Overview; nav: React.ReactNode; tick: number; onChanged: () => void; onNext: () => void };

export const AssetDesk: React.FC<Props> = ({ projectId, overview, nav, tick, onChanged, onNext }) => {
  const [assets, setAssets] = useState<Assets | null>(null);
  const [beats, setBeats] = useState<Beats | null>(null);
  const [footage, setFootage] = useState("source");
  const [dirtyBeats, setDirtyBeats] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const classificationAttempted = useRef(false);
  const [sheets, setSheets] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [cueMs, setCueMs] = useState<Record<string, number>>({});
  const [words, setWords] = useState<{ index: number; text: string; startMs: number }[]>([]);
  const [selectedBeatId, setSelectedBeatId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await storyboardApi.assets(projectId);
    setAssets(data.assets);
    setFootage(data.footage);
    setWords(data.words);
    setBeats((current) => (dirtyBeats && current ? current : data.beats));
    setSheets(await storyboardApi.candidateSheets(projectId));
  }, [projectId, dirtyBeats]);

  useEffect(() => {
    load().catch((error) => setMessage(`加载失败：${error.message}`));
  }, [load, tick]);

  useEffect(() => {
    if (!beats?.beats.length || beats.confirmedAt || dirtyBeats || classificationAttempted.current || beats.beats.some((beat) => beat.classification)) return;
    classificationAttempted.current = true;
    setClassifying(true);
    storyboardApi.classifyBeats(projectId).then((result) => { setBeats(result); setMessage("AI 已预选段落分类，请检查低置信度段落。"); }).catch((error) => setMessage(`自动分类未完成：${error.message}。可点击“重新识别”。`)).finally(() => setClassifying(false));
  }, [beats, dirtyBeats, projectId]);

  const reclassify = async () => {
    if (!beats || classifying) return;
    setClassifying(true); setMessage("正在重新识别段落…");
    try {
      if (dirtyBeats) await storyboardApi.saveBeats(projectId, beats);
      const result = await storyboardApi.classifyBeats(projectId);
      setBeats(result); setDirtyBeats(false); setMessage("重新识别完成。人工修改的分类已保留。");
    } catch (error) { setMessage(`重新识别失败：${(error as Error).message}`); }
    finally { setClassifying(false); }
  };

  const act = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) setMessage(done);
      await load();
      onChanged();
    } catch (error) {
      const problems = (error as { problems?: string[] }).problems ?? [];
      setMessage(`${(error as Error).message}${problems.length ? `：${problems.join("；")}` : ""}`);
    }
  };

  if (!assets) return <div className="loading">加载中…</div>;
  const missing = assets.items.filter((item) => item.status === "missing");
  const beatsConfirmed = !!beats?.confirmedAt && !dirtyBeats;
  const selectedBeat = beats?.beats.find((beat) => beat.id === selectedBeatId) ?? beats?.beats[0];
  const selectedStartMs = selectedBeat ? words[selectedBeat.words[0]]?.startMs ?? cueMs[selectedBeat.id] ?? 0 : 0;

  return (
    <div className="app desk-page">
      <header>
        {nav}
        <span className="spacer" />
        <button className="primary" disabled={!beatsConfirmed} title={beatsConfirmed ? undefined : "先确认段落角色"} onClick={onNext}>
          去看方案 →
        </button>
      </header>
      <div className="banner-slot">{message ? <div className="banner" onClick={() => setMessage(null)}>{message}</div> : null}</div>
      <main className="asset-grid">
        <section className="panel asset-segments">
          <h2>
            口播段落 {beatsConfirmed ? <span className="pill state-accepted">已确认</span> : <span className="pill state-pending">待确认</span>}
          </h2>
          <p className="muted small">系统先识别七类段落；请检查待确认项，点击分类可修改。</p><button disabled={classifying || !!beats?.confirmedAt} onClick={reclassify}>{classifying ? "AI 识别中…" : "重新识别"}</button>
          {beats?.beats.map((beat, index) => (
            <div key={beat.id} className={`beat-row${selectedBeat?.id === beat.id ? " selected" : ""}`} onClick={() => setSelectedBeatId(beat.id)}>
              <img src={storyboardApi.thumbAt(projectId, footage, cueMs[beat.id] ?? 0)} alt="" />
              <div>
                <div className="beat-head">
                  <b>{beat.id}</b>
                  <select
                    aria-label={`${beat.id}段落分类`}
                    value={simpleRole(beat.role)}
                    disabled={classifying || !!beats.confirmedAt}
                    onChange={(event) => {
                      const next = structuredClone(beats);
                      next.beats[index].role = event.target.value as typeof beat.role;
                      next.beats[index].classification = { recommendedRole: next.beats[index].classification?.recommendedRole ?? beat.role, confidence: next.beats[index].classification?.confidence ?? 0, source: "manual", confirmed: true, alternatives: next.beats[index].classification?.alternatives ?? [], model: next.beats[index].classification?.model, analyzedAt: next.beats[index].classification?.analyzedAt };
                      next.confirmedAt = null;
                      setBeats(next);
                      setDirtyBeats(true);
                    }}
                  >
                    {SIMPLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                          {SIMPLE_ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                  <span className={`pill ${beat.classification?.source === "manual" ? "state-accepted" : beat.classification && beat.classification.confidence >= 0.75 ? "state-accepted" : "state-pending"}`}>{beat.classification?.source === "manual" ? "人工修改" : beat.classification?.source === "ai" && beat.classification.confidence >= 0.75 ? `AI 已识别 ${Math.round(beat.classification.confidence * 100)}%` : beat.classification?.source === "ai" ? `待确认 · AI 建议 ${Math.round(beat.classification.confidence * 100)}%` : "待识别"}</span>
                  <span className="muted small">{((words[beat.words[0]]?.startMs ?? 0) / 1000).toFixed(1)} 秒</span>
                </div>
                {beat.textZh ? <div className="zh">{beat.textZh}</div> : null}
                <div className="en small muted">{beat.text}</div>
                {beat.claims.length ? (
                  <div className="chips">
                    {beat.claims.map((claimId) => {
                      const claim = assets.claims.find((item) => item.id === claimId);
                      return (
                        <span key={claimId} className={`pill claim-${claim?.status ?? "unverified"}`}>
                          事实：{claim?.text ?? claimId} · {CLAIM_ZH[claim?.status ?? "unverified"]}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {beats ? (
            <div className="actions">
              {dirtyBeats ? (
                <button onClick={() => act(async () => { await storyboardApi.saveBeats(projectId, beats); setDirtyBeats(false); }, "段落角色已保存")}>保存修改</button>
              ) : null}
              <button className="primary" disabled={beatsConfirmed} onClick={() => act(async () => { await storyboardApi.confirmBeats(projectId, beats); setDirtyBeats(false); }, "段落角色已确认")}>
                {beatsConfirmed ? "已确认" : "批量确认分类"}
              </button>
            </div>
          ) : (
            <p className="muted">尚未生成段落分析，请先完成语音转录。</p>
          )}
        </section>

        <section className="panel asset-main">
          <div className="asset-current"><div><span className="eyebrow">CURRENT SEGMENT</span><h2>当前段落 · {selectedBeat ? ROLE_ZH[selectedBeat.role] : "等待分析"}</h2><p>{selectedBeat?.textZh ?? selectedBeat?.text ?? "暂无转录文字"}</p>{selectedBeat?.textZh ? <p className="muted">{selectedBeat.text}</p> : null}{selectedBeat?.claims.length ? <div className="asset-current-claims">{selectedBeat.claims.map((id) => { const claim = assets.claims.find((item) => item.id === id); return <span key={id} className={`pill claim-${claim?.status ?? "unverified"}`}>{claim?.text ?? "产品事实"} · {CLAIM_ZH[claim?.status ?? "unverified"]}</span>; })}</div> : null}</div><video key={`${selectedBeat?.id}-${selectedStartMs}`} controls preload="metadata" src={`/media/${encodeURIComponent(projectId)}/${encodeURIComponent(footage)}#t=${selectedStartMs / 1000}`} aria-label="当前段落原片预览" /></div>
          <div className="asset-section-head"><div><h2>关联素材</h2><p className="muted small">确认候选图、补齐缺失素材，原片始终保留。</p></div><span className="pill">{missing.length} 项待补</span></div>
          {assets.items.map((item) => (
            <div key={item.id} className={`asset-card ${item.status}`}>
              <div className="beat-head">
                <b>{item.label ?? item.id}</b>
                <span className={`pill asset-${item.status}`}>{STATUS_ZH[item.status]}</span>
                <details className="asset-technical"><summary>技术信息</summary><code>{item.id} · {item.kind}</code></details>
              </div>
              {item.neededBy.length ? <div className="muted small">用于：{item.neededBy.join("、")}</div> : null}
              {item.status === "available" && item.file && item.kind !== "footage" ? (
                <div className="asset-preview">
                  <img src={storyboardApi.publicUrl(item.file)} alt="" />
                  <div className="small">
                    {item.source}
                    <br />
                    <details><summary>素材来源</summary><code>{item.file}</code></details>
                    <br />
                    <button className="small-button" onClick={() => act(() => storyboardApi.resetAsset(projectId, item.id), `${item.id} 已撤回`)}>
                      撤回
                    </button>
                  </div>
                </div>
              ) : null}
              {item.kind === "footage" ? <div className="small muted">{item.originalName} · {item.source}</div> : null}
              {item.status !== "available" && item.candidates.length ? (
                <div className="candidates">
                  {item.candidates.map((candidate) => (
                    <figure key={candidate.file}>
                      <img src={storyboardApi.publicUrl(candidate.file)} alt="" />
                      <figcaption className="small">
                        原片第 {candidate.frame} 帧{candidate.note ? `：${candidate.note}` : ""}
                      </figcaption>
                      <div className="actions">
                        <button className="primary" onClick={() => act(() => storyboardApi.approve(projectId, item.id, candidate.file), `${item.id} 已采用`)}>
                          采用
                        </button>
                        <button onClick={() => act(() => storyboardApi.rejectCandidate(projectId, item.id, candidate.file), "已移除候选")}>不用</button>
                      </div>
                    </figure>
                  ))}
                </div>
              ) : null}
              {item.status !== "available" && item.kind !== "footage" ? (
                <label className="upload small">
                  上传文件：
                  <input
                    type="file"
                    accept="image/*,video/*,audio/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) act(() => storyboardApi.upload(projectId, item.id, file), `${file.name} 已上传为 ${item.id}`);
                    }}
                  />
                </label>
              ) : null}
            </div>
          ))}
          <details>
            <summary className="small">原片候选帧参考</summary>
            <button className="small-button" onClick={() => act(() => api.startJob(projectId, "candidates"), "已开始生成联系表")}>
              重新生成
            </button>
            {sheets.map((name) => (
              <img key={name} className="sheet" src={storyboardApi.sheetUrl(projectId, name)} alt={name} />
            ))}
          </details>
        </section>

        <section className="panel asset-facts">
          <h2>产品事实核实</h2>
          <p className="muted small">可直接标记为已核实；依据可以选填。未核实的事实仍会影响方案确认。</p>
          {assets.claims.map((claim) => (
            <div key={claim.id} className={`claim claim-${claim.status}`}>
              <div className="beat-head">
                <b>{claim.text}</b>
                <span className={`pill claim-${claim.status}`}>{CLAIM_ZH[claim.status]}</span>
              </div>
              {claim.note ? <div className="small muted">备注：{claim.note}</div> : null}
              {claim.evidence ? <div className="small">依据：{claim.evidence}</div> : null}
              <textarea
                rows={2}
                placeholder="依据（选填）：可记录包装、商品页或关联素材"
                value={evidence[claim.id] ?? ""}
                onChange={(event) => setEvidence({ ...evidence, [claim.id]: event.target.value })}
              />
              <div className="actions">
                <button className="primary" onClick={() => act(() => storyboardApi.updateClaim(projectId, claim.id, { status: "verified", evidence: evidence[claim.id] || claim.evidence }), "已标记为已核实")}>
                  已核实
                </button>
                <button onClick={() => act(() => storyboardApi.updateClaim(projectId, claim.id, { status: "rejected", evidence: evidence[claim.id] || claim.evidence }), "已标记为不成立")}>不成立</button>
                {claim.status !== "unverified" ? <button onClick={() => act(() => storyboardApi.updateClaim(projectId, claim.id, { status: "unverified" }), "已改回未核实")}>改回未核实</button> : null}
              </div>
            </div>
          ))}

          <h2 className="print-title">补拍清单（{missing.length}）</h2>
          {missing.length ? (
            <>
              <ul className="shotlist">
                {missing.map((item) => (
                  <li key={item.id}>
                    <b>{item.label ?? item.id}</b> <span className="muted small">（{item.id}，用于 {item.neededBy.join("、")}）</span>
                    {item.shotRequest ? (
                      <dl>
                        {Object.entries(item.shotRequest).map(([key, value]) => (
                          <div key={key}>
                            <dt>{{ subject: "拍什么", framing: "构图", background: "背景", duration: "时长", notes: "注意" }[key] ?? key}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ul>
              <button onClick={() => window.print()}>打印补拍清单</button>
            </>
          ) : (
            <p className="ok-line">✓ 没有缺失的素材</p>
          )}
          <p className="muted small">项目：{overview.title}</p>
        </section>
      </main>
      <BeatThumbs projectId={projectId} beats={beats} onReady={setCueMs} />
    </div>
  );
};

// The middle of each beat in source time, for the beat thumbnails.
const BeatThumbs: React.FC<{ projectId: string; beats: Beats | null; onReady: (value: Record<string, number>) => void }> = ({ projectId, beats, onReady }) => {
  useEffect(() => {
    if (!beats) return;
    fetch(`/api/projects/${projectId}/beat-times`)
      .then((response) => (response.ok ? response.json() : {}))
      .then(onReady)
      .catch(() => {});
  }, [projectId, beats, onReady]);
  return null;
};

import { useCallback, useEffect, useState } from "react";
import { ROLES } from "../../src/engine/library.ts";
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
  const [sheets, setSheets] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [cueMs, setCueMs] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    const data = await storyboardApi.assets(projectId);
    setAssets(data.assets);
    setFootage(data.footage);
    setBeats((current) => (dirtyBeats && current ? current : data.beats));
    setSheets(await storyboardApi.candidateSheets(projectId));
  }, [projectId, dirtyBeats]);

  useEffect(() => {
    load().catch((error) => setMessage(`加载失败：${error.message}`));
  }, [load, tick]);

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
        <section className="panel">
          <h2>
            段落角色 {beatsConfirmed ? <span className="pill state-accepted">已确认</span> : <span className="pill state-pending">待确认</span>}
          </h2>
          <p className="muted small">Claude 按转录把口播分成几段。检查每段的角色对不对；确认后 Claude 才会用它出方案。</p>
          {beats?.beats.map((beat, index) => (
            <div key={beat.id} className="beat-row">
              <img src={storyboardApi.thumbAt(projectId, footage, cueMs[beat.id] ?? 0)} alt="" style={{ display: cueMs[beat.id] === undefined ? "none" : undefined }} />
              <div>
                <div className="beat-head">
                  <b>{beat.id}</b>
                  <select
                    value={beat.role}
                    onChange={(event) => {
                      const next = structuredClone(beats);
                      next.beats[index].role = event.target.value as typeof beat.role;
                      next.confirmedAt = null;
                      setBeats(next);
                      setDirtyBeats(true);
                    }}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_ZH[role]}（{role}）
                      </option>
                    ))}
                  </select>
                  <span className="muted small">第 {beat.words[0]}–{beat.words[1]} 个词</span>
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
                {beatsConfirmed ? "已确认" : "确认段落角色"}
              </button>
            </div>
          ) : (
            <p className="muted">还没有段落分析。在对话里让 Claude 开始这条视频（video-workflow）。</p>
          )}
        </section>

        <section className="panel">
          <h2>素材</h2>
          {assets.items.map((item) => (
            <div key={item.id} className={`asset-card ${item.status}`}>
              <div className="beat-head">
                <b>{item.label ?? item.id}</b>
                <span className={`pill asset-${item.status}`}>{STATUS_ZH[item.status]}</span>
                <span className="muted small">
                  {item.id} · {item.kind}
                </span>
              </div>
              {item.neededBy.length ? <div className="muted small">用于：{item.neededBy.join("、")}</div> : null}
              {item.status === "available" && item.file && item.kind !== "footage" ? (
                <div className="asset-preview">
                  <img src={storyboardApi.publicUrl(item.file)} alt="" />
                  <div className="small">
                    {item.source}
                    <br />
                    <code>{item.file}</code>
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
            <summary className="small">原片联系表（Claude 找候选帧用，编号是原片帧号）</summary>
            <button className="small-button" onClick={() => act(() => api.startJob(projectId, "candidates"), "已开始生成联系表")}>
              重新生成
            </button>
            {sheets.map((name) => (
              <img key={name} className="sheet" src={storyboardApi.sheetUrl(projectId, name)} alt={name} />
            ))}
          </details>
        </section>

        <section className="panel">
          <h2>产品事实核实</h2>
          <p className="muted small">上屏或口播里的产品事实必须核实并写明依据。未核实的事实，方案不能确认。</p>
          {assets.claims.map((claim) => (
            <div key={claim.id} className={`claim claim-${claim.status}`}>
              <div className="beat-head">
                <b>{claim.text}</b>
                <span className={`pill claim-${claim.status}`}>{CLAIM_ZH[claim.status]}</span>
              </div>
              {claim.note ? <div className="small muted">Claude 的说明：{claim.note}</div> : null}
              {claim.evidence ? <div className="small">依据：{claim.evidence}</div> : null}
              <textarea
                rows={2}
                placeholder="依据：例如『包装背面写明 60 粒，每天 2 粒』，或素材 id wrapped-evidence"
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

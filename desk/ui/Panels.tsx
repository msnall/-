import { useState } from "react";
import { api, type Job, type Proposal, type Version } from "./api.ts";

const fmtValue = (value: unknown) =>
  value === undefined ? "—" : JSON.stringify(value);
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "";
const STATE_LABEL: Record<Proposal["state"], string> = {
  pending: "待确认",
  accepted: "已采纳",
  rejected: "已拒绝",
  stale: "已过期",
  superseded: "已被替代",
};

const ProposalCard: React.FC<{
  projectId: string;
  proposal: Proposal;
  fps: number;
  previewing: boolean;
  onPreview: (id: string | null) => void;
  onAccept: (id: string) => void;
  onReject: (id: string, text: string) => void;
}> = ({
  projectId,
  proposal,
  fps,
  previewing,
  onPreview,
  onAccept,
  onReject,
}) => {
  const [text, setText] = useState("");
  const open = proposal.state === "pending";
  const delta = proposal.impact?.durationDeltaFrames;
  return (
    <div className={`proposal ${proposal.state}`}>
      <div className="proposal-head">
        <b>{proposal.id}</b>
        <span className={`pill state-${proposal.state}`}>
          {STATE_LABEL[proposal.state]}
        </span>
        <span className="muted small">基于 r{proposal.basedOnRevision}</span>
      </div>
      <p className="summary">{proposal.summary}</p>
      {proposal.reason ? (
        <p className="small reason">理由：{proposal.reason}</p>
      ) : null}
      {proposal.staleReason ? (
        <p className="small warn-text">
          {proposal.staleReason}。需要 Claude 基于当前版本重出。
        </p>
      ) : null}
      {proposal.problem ? (
        <p className="small warn-text">无法应用：{proposal.problem}</p>
      ) : null}
      {proposal.preview?.before?.length || proposal.preview?.after?.length ? (
        <div className="before-after">
          <figure>
            {(proposal.preview?.before ?? []).map((file) => (
              <img key={file} src={api.projectFileUrl(projectId, file)} />
            ))}
            <figcaption>修改前</figcaption>
          </figure>
          <figure>
            {(proposal.preview?.after ?? []).map((file) => (
              <img key={file} src={api.projectFileUrl(projectId, file)} />
            ))}
            <figcaption>修改后</figcaption>
          </figure>
        </div>
      ) : null}
      <details open={open}>
        <summary className="small">
          改动（
          {proposal.changes.filter((change) => change.op !== "test").length}）
        </summary>
        <ul className="changes">
          {proposal.changes.map((change, index) =>
            change.op === "test" ? (
              <li key={index} className="muted small">
                确认 <code>{change.path}</code> ={" "}
                <code>{fmtValue(change.value)}</code>
              </li>
            ) : (
              <li key={index}>
                <code>{change.op}</code> <code>{change.path}</code>
                {"value" in change ? (
                  <div className="diff">
                    {change.op !== "add" ? (
                      <span className="del">{fmtValue(change.before)}</span>
                    ) : null}
                    <span className="ins">{fmtValue(change.value)}</span>
                  </div>
                ) : change.op === "remove" ? (
                  <div className="diff">
                    <span className="del">{fmtValue(change.before)}</span>
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </details>
      {delta ? (
        <p className="small">
          时长变化：{delta > 0 ? "+" : ""}
          {(delta / fps).toFixed(2)}s
          {proposal.impact?.segments?.length
            ? ` · 影响段落：${proposal.impact.segments.join("、")}`
            : ""}
        </p>
      ) : null}
      {proposal.rejectComment ? (
        <p className="small">你的意见：{proposal.rejectComment}</p>
      ) : null}
      {open ? (
        <>
          <div className="actions">
            <button
              className="primary"
              disabled={!!proposal.problem}
              onClick={() => onAccept(proposal.id)}
            >
              采纳
            </button>
            <button
              className={previewing ? "on" : ""}
              disabled={!!proposal.problem}
              onClick={() => onPreview(previewing ? null : proposal.id)}
            >
              {previewing ? "停止预览" : "在播放器中预览修改"}
            </button>
          </div>
          <div className="comment-box">
            <textarea
              rows={2}
              placeholder="拒绝时可补充意见，Claude 会只针对这一条重出"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button onClick={() => onReject(proposal.id, text.trim())}>
              拒绝{text.trim() ? "并附意见" : ""}
            </button>
          </div>
        </>
      ) : null}
      <p className="muted small">
        {proposal.createdBy ?? "claude"} · {fmtDate(proposal.createdAt)}
        {proposal.decidedAt ? ` · 处理于 ${fmtDate(proposal.decidedAt)}` : ""}
        {proposal.appliedRevision ? ` · 写入 r${proposal.appliedRevision}` : ""}
      </p>
    </div>
  );
};

export const Proposals: React.FC<{
  projectId: string;
  proposals: Proposal[];
  fps: number;
  previewing: string | null;
  onPreview: (id: string | null) => void;
  onAccept: (id: string) => void;
  onReject: (id: string, text: string) => void;
}> = (props) => {
  const order: Proposal["state"][] = [
    "pending",
    "stale",
    "accepted",
    "rejected",
    "superseded",
  ];
  const sorted = [...props.proposals].sort(
    (a, b) =>
      order.indexOf(a.state) - order.indexOf(b.state) ||
      b.id.localeCompare(a.id),
  );
  if (!sorted.length)
    return (
      <p className="muted">
        还没有提案。提交审阅意见后，可复制给 AI 助手处理。
      </p>
    );
  return (
    <div>
      {sorted.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          projectId={props.projectId}
          proposal={proposal}
          fps={props.fps}
          previewing={props.previewing === proposal.id}
          onPreview={props.onPreview}
          onAccept={props.onAccept}
          onReject={props.onReject}
        />
      ))}
    </div>
  );
};

export const Versions: React.FC<{
  versions: Version[];
  current: number;
  onRestore: (revision: number) => void;
}> = ({ versions, current, onRestore }) =>
  versions.length ? (
    <ul className="versions">
      {versions.map((version) => (
        <li
          key={version.revision}
          className={version.revision === current ? "current" : ""}
        >
          <b>第 {version.revision} 次修改</b>{" "}
          <span className="muted small">
            {fmtDate(version.savedAt)} · {version.by}
          </span>
          <div className="small">{version.note}</div>
          {version.revision !== current ? (
            <button
              className="small-button"
              onClick={() => onRestore(version.revision)}
            >
              恢复为新版本
            </button>
          ) : (
            <span className="pill">当前</span>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="muted">
      还没有历史版本。第一次保存修改时会记录修改前的版本。
    </p>
  );

const JOB_LABEL: Record<string, string> = {
  proxy: "生成预览代理",
  faces: "人脸检测",
  stills: "截帧",
  render: "视频导出",
};
const JOB_STATE: Record<Job["state"], string> = {
  queued: "排队",
  running: "运行中",
  done: "完成",
  failed: "失败",
};

export const Jobs: React.FC<{
  projectId: string;
  jobs: Job[];
  onStart: (type: string) => void;
}> = ({ projectId, jobs, onStart }) => (
  <div>
    <div className="actions wrap">
      {(["proxy", "faces"] as const).map((type) => (
        <button key={type} onClick={() => onStart(type)}>
          {JOB_LABEL[type]}
        </button>
      ))}
    </div>
    <p className="muted small">导出视频请前往“导出中心”。此处仅显示准备工具与任务记录。</p>
    <ul className="jobs">
      {jobs.map((job) => (
        <li key={job.id} className={job.state}>
          <b>{JOB_LABEL[job.type] ?? job.type}</b>{" "}
          <span className={`pill job-${job.state}`}>
            {JOB_STATE[job.state]}
          </span>
          <div className="muted small">
            {fmtDate(job.createdAt)}
            {job.output ? (
              <>
                <br />
                已生成文件
              </>
            ) : null}
            {job.error ? <div className="warn-text">{job.error}</div> : null}
          </div>
          <details className="technical-details"><summary>任务技术详情</summary><code>{job.id}{job.output ? ` · ${job.output}` : ""}</code></details>
          <a
            className="small"
            href={`/api/projects/${projectId}/jobs/${job.id}/log`}
            target="_blank"
            rel="noreferrer"
          >
            日志
          </a>
        </li>
      ))}
    </ul>
  </div>
);

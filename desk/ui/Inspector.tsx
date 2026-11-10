import { useState } from "react";
import { getEffect, type EffectId } from "../../src/engine/effects/catalog.ts";
import type { LayoutWarning } from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import type { Comment, Decision, RawPlan, Review } from "./api.ts";
import type { Selection } from "./Stage.tsx";

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const fmtTime = (frame: number, fps: number) => `${(frame / fps).toFixed(2)}s`;

const Field: React.FC<{ name: string; value: unknown; onChange: (value: unknown) => void }> = ({ name, value, onChange }) => {
  if (typeof value === "number") {
    return (
      <label className="field">
        <span>{name}</span>
        <input type="number" value={value} step={Number.isInteger(value) ? 1 : 0.05} onChange={(event) => event.target.value !== "" && onChange(Number(event.target.value))} />
      </label>
    );
  }
  if (typeof value === "string" && HEX.test(value)) {
    return (
      <label className="field">
        <span>{name}</span>
        <span className="color-field">
          <input type="color" value={value.slice(0, 7)} onChange={(event) => onChange(event.target.value + value.slice(7))} />
          <input type="text" value={value} onChange={(event) => HEX.test(event.target.value) && onChange(event.target.value)} />
        </span>
      </label>
    );
  }
  if (typeof value === "string") {
    return (
      <label className="field wide">
        <span>{name}</span>
        {value.length > 30 ? <textarea value={value} rows={2} onChange={(event) => onChange(event.target.value)} /> : <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />}
      </label>
    );
  }
  if (typeof value === "boolean") {
    return (
      <label className="field">
        <span>{name}</span>
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  return (
    <div className="field wide readonly">
      <span>{name}</span>
      <code>{JSON.stringify(value)}</code>
    </div>
  );
};

const describeAnchor = (anchor: unknown) => {
  if (!anchor || typeof anchor !== "object") return "—";
  const value = anchor as Record<string, unknown>;
  if ("frame" in value) return `第 ${value.frame} 帧`;
  if ("fromEnd" in value) return `结尾前 ${value.fromEnd} 帧`;
  if ("word" in value) return `第 ${value.word} 个词${value.expect ? `「${value.expect}」` : ""}${value.edge === "end" ? "结束" : ""}${value.offsetMs ? ` ${Number(value.offsetMs) > 0 ? "+" : ""}${value.offsetMs}ms` : ""}`;
  if ("segment" in value) return `段落 ${value.segment} ${value.edge === "end" ? "结束" : "开始"}`;
  return JSON.stringify(anchor);
};

const Warnings: React.FC<{ warnings: LayoutWarning[]; onSeek: (frame: number) => void }> = ({ warnings, onSeek }) =>
  warnings.length ? (
    <ul className="warnings">
      {warnings.map((warning, index) => (
        <li key={index} className={warning.kind} onClick={() => onSeek(warning.fromFrame)}>
          <b>{warning.kind === "face" ? "遮挡人脸" : warning.kind === "safe-zone" ? "安全区" : "超出画面"}</b> {warning.message}
        </li>
      ))}
    </ul>
  ) : (
    <p className="ok-line">✓ 没有布局警告</p>
  );

type Props = {
  plan: RawPlan;
  resolved: ResolvedPlan;
  selection: Selection;
  frame: number;
  warnings: LayoutWarning[];
  problems: string[];
  review: Review | null;
  faceMode: "auto" | "manual" | "none";
  hasFaces: boolean;
  onOverlayProp: (id: string, key: string, value: unknown) => void;
  onSelectOverlay: (id: string) => void;
  onRemoveOverlay: (id: string) => void;
  onCaptionProp: (key: string, value: unknown) => void;
  onDecision: (segment: string, decision: Decision) => void;
  onComment: (segment: string | null, text: string) => void;
  onFaceMode: (segment: string, mode: "auto" | "manual" | "none") => void;
  onSeek: (frame: number) => void;
};

const CommentList: React.FC<{ comments: Comment[]; fps: number; onSeek: (frame: number) => void }> = ({ comments, fps, onSeek }) => (
  <ul className="comments">
    {comments.map((comment) => (
      <li key={comment.id}>
        <span className="comment-meta">
          意见
          {comment.at ? (
            <a onClick={() => onSeek(comment.at!.frame)}> @ {fmtTime(comment.at.frame, fps)}</a>
          ) : null}
          {comment.proposal ? ` · 关于 ${comment.proposal}` : ""}
        </span>
        {comment.text}
      </li>
    ))}
  </ul>
);

const CommentBox: React.FC<{ onAdd: (text: string) => void; placeholder: string }> = ({ onAdd, placeholder }) => {
  const [text, setText] = useState("");
  return (
    <div className="comment-box">
      <textarea value={text} placeholder={placeholder} rows={3} onChange={(event) => setText(event.target.value)} />
      <button
        disabled={!text.trim()}
        onClick={() => {
          onAdd(text.trim());
          setText("");
        }}
      >
        添加意见
      </button>
    </div>
  );
};

export const Inspector: React.FC<Props> = (props) => {
  const { plan, resolved, selection, warnings, frame } = props;
  const fps = resolved.fps;

  if (selection?.kind === "overlay") {
    const raw = plan.overlays?.find((item) => item.id === selection.id);
    const overlay = resolved.overlays.find((item) => item.id === selection.id);
    if (!raw || !overlay) return <p className="muted">该元素不在当前版本中。</p>;
    const definition = getEffect(overlay.effect as EffectId);
    const boxKeys = Object.values(definition.box);
    const shown = { ...overlay.props, ...raw.props };
    const other = Object.keys(shown).filter((key) => !boxKeys.includes(key) && key !== "asset");
    const own = warnings.filter((warning) => warning.target === overlay.id);
    return (
      <div className="inspector">
        <h3>
          画面元素
        </h3>
        <details className="technical-details"><summary>技术信息</summary><code>{overlay.id} · {overlay.effect}</code></details>
        <button className="small-button" onClick={() => props.onRemoveOverlay(overlay.id)}>删除这个画面图层</button>
        <p className="muted small">{definition.description}</p>
        <h4>位置与大小（像素，画面 {resolved.width}×{resolved.height}）</h4>
        <div className="grid4">
          {(["x", "y", "width", "height"] as const).map((axis) => (
            <Field key={axis} name={definition.box[axis]} value={shown[definition.box[axis]] ?? 0} onChange={(value) => props.onOverlayProp(overlay.id, definition.box[axis], value)} />
          ))}
        </div>
        <h4>出现时间</h4>
        <p className="small">
          {fmtTime(overlay.from, fps)} – {fmtTime(overlay.from + overlay.durationInFrames, fps)}（{overlay.durationInFrames} 帧）
          <br />
          开始：{describeAnchor(raw.from)}
          {raw.until ? <> · 结束：{describeAnchor(raw.until)}</> : null}
        </p>
        {typeof shown.asset === "string" ? (
          <details className="technical-details"><summary>素材来源</summary><p className="small">
            素材：<code>{String(shown.asset)}</code> → <code>{plan.assets[String(shown.asset)]?.path ?? plan.assets[String(shown.asset)]?.dir}</code>
          </p></details>
        ) : null}
        <h4>样式</h4>
        <div className="fields">
          {other.map((key) => (
            <Field key={key} name={key} value={shown[key]} onChange={(value) => props.onOverlayProp(overlay.id, key, value)} />
          ))}
        </div>
        <h4>检查</h4>
        <Warnings warnings={own} onSeek={props.onSeek} />
      </div>
    );
  }

  if (selection?.kind === "captions" && plan.captions && resolved.captions) {
    const captions = plan.captions;
    const own = warnings.filter((warning) => warning.target === "captions");
    return (
      <div className="inspector">
        <h3>字幕</h3>
        <h4>字幕框</h4>
        <div className="grid4">
          {(["x", "y", "width", "height"] as const).map((axis) => (
            <Field key={axis} name={axis} value={captions.box[axis]} onChange={(value) => props.onCaptionProp("box", { ...captions.box, [axis]: value })} />
          ))}
        </div>
        <h4>样式</h4>
        <div className="fields">
          {(["fontSize", "lineHeight", "fontWeight", "color", "activeColor", "background", "wordGap"] as const).map((key) =>
            captions[key] !== undefined || key === "background" ? <Field key={key} name={key} value={captions[key] ?? "#00000000"} onChange={(value) => props.onCaptionProp(key, value)} /> : null,
          )}
        </div>
        <h4>检查</h4>
        <Warnings warnings={own} onSeek={props.onSeek} />
      </div>
    );
  }

  if (selection?.kind === "segment") {
    const segment = resolved.footage.segments.find((item) => item.id === selection.id);
    const entry = props.review?.segments.find((item) => item.segment === selection.id);
    const visibleLayers = resolved.overlays.filter((item) => item.from <= frame && frame < item.from + item.durationInFrames && plan.overlays?.some((raw) => raw.id === item.id));
    if (!segment) return <p className="muted">该段落不在当前版本中。</p>;
    return (
      <div className="inspector">
        <h3>片段 {resolved.footage.segments.indexOf(segment) + 1}</h3>
        <p className="small">
          原片 {(segment.sourceStartMs / 1000).toFixed(2)}–{(segment.sourceEndMs / 1000).toFixed(2)}s → 成片 {fmtTime(segment.from, fps)}–{fmtTime(segment.from + segment.durationInFrames, fps)}
          {segment.camera.zoom !== 1 ? ` · 缩放 ${segment.camera.zoom}` : ""}
          {segment.camera.punchIns.length ? ` · ${segment.camera.punchIns.length} 处推近` : ""}
        </p>
        <h4>当前画面图层</h4>
        {visibleLayers.length ? visibleLayers.map((item) => <div className="review-layer-row" key={item.id}><button onClick={() => props.onSelectOverlay(item.id)}>{item.id.startsWith("product-fade") ? "产品图柔和淡入" : item.id.startsWith("product-pip") ? "产品画中画" : item.effect === "image-card@1" ? "图片图层" : item.id}</button><button onClick={() => props.onRemoveOverlay(item.id)}>删除</button></div>) : <p className="muted small">当前帧没有额外画面图层。</p>}
        <h4>标记</h4>
        <div className="decisions">
          {(["keep", "modify", "drop"] as const).map((decision) => (
            <button key={decision} className={`chip ${decision}${entry?.decision === decision ? " on" : ""}`} onClick={() => props.onDecision(segment.id, entry?.decision === decision ? "undecided" : decision)}>
              {decision === "keep" ? "保留" : decision === "modify" ? "修改" : "放弃"}
            </button>
          ))}
        </div>
        <p className="muted small">意见会保存在本项目。提交后可复制给 AI 助手处理；只有采纳提案后才会更新方案。</p>
        <h4>意见</h4>
        <CommentList comments={entry?.comments ?? []} fps={fps} onSeek={props.onSeek} />
        <CommentBox placeholder={`针对这一段，记在当前帧 ${fmtTime(frame, fps)}`} onAdd={(text) => props.onComment(segment.id, text)} />
        <h4>人脸区域</h4>
        {props.hasFaces ? (
          <div className="decisions">
            {(["auto", "manual", "none"] as const).map((mode) => (
              <button key={mode} className={`chip${props.faceMode === mode ? " on" : ""}`} onClick={() => props.onFaceMode(segment.id, mode)}>
                {mode === "auto" ? "自动检测" : mode === "manual" ? "手动修正" : "此段无人脸"}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted small">还没有人脸分析。可在检查模式中运行人脸检测。</p>
        )}
        {props.faceMode === "manual" ? <p className="muted small">在画面上拖动黄色框修正人脸区域。</p> : null}
      </div>
    );
  }

  return (
    <div className="inspector">
      <h3>整片检查</h3>
      {props.problems.length ? (
        <>
          <h4>配置错误</h4>
          <ul className="warnings">
            {props.problems.map((problem, index) => (
              <li key={index} className="error">
                {problem}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>布局警告（{warnings.length}）</h4>
      <Warnings warnings={warnings} onSeek={props.onSeek} />
      <h4>整体意见</h4>
      <CommentList comments={props.review?.comments ?? []} fps={fps} onSeek={props.onSeek} />
      <CommentBox placeholder="不针对某一段的意见" onAdd={(text) => props.onComment(null, text)} />
      <p className="muted small">点击画面上的元素、时间轴或左侧段落进行查看和修改。</p>
    </div>
  );
};

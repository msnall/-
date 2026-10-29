import { useEffect, useRef, useState } from "react";
import type { LayoutWarning } from "../../src/engine/layout.ts";
import type { ResolvedPlan } from "../../src/engine/load.ts";
import type { Decision } from "./api.ts";
import type { Selection } from "./Stage.tsx";

type Props = {
  resolved: ResolvedPlan;
  frame: number;
  decisions: Record<string, Decision>;
  warnings: LayoutWarning[];
  peaks: number[] | null;
  selection: Selection;
  onSeek: (frame: number) => void;
  onSelect: (selection: Selection) => void;
};

const Waveform: React.FC<{ peaks: number[]; width: number; volume: number[] }> = ({ peaks, width, volume }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !width) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = width * ratio;
    element.height = 44 * ratio;
    const context = element.getContext("2d")!;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, 44);
    context.fillStyle = "#4f8fd8";
    const step = width / peaks.length;
    for (let index = 0; index < peaks.length; index++) {
      const value = Math.sqrt(peaks[index]) * 20;
      context.fillRect(index * step, 22 - value, Math.max(1, step), value * 2);
    }
    // Volume line (track volume, 0–2 mapped onto the lane).
    context.strokeStyle = "#f2c14e";
    context.lineWidth = 1.5;
    context.beginPath();
    volume.forEach((level, index) => {
      const y = 42 - Math.min(2, level) * 19;
      if (index === 0) context.moveTo(0, y);
      context.lineTo((index + 1) * (width / volume.length), y);
    });
    context.stroke();
  }, [peaks, width, volume]);
  return <canvas ref={canvas} style={{ width, height: 44, display: "block" }} />;
};

export const Timeline: React.FC<Props> = ({ resolved, frame, decisions, warnings, peaks, selection, onSeek, onSelect }) => {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const total = resolved.durationInFrames;
  const x = (value: number) => (value / total) * width;
  const seekFromEvent = (event: React.PointerEvent) => {
    const rect = host.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(total - 1, Math.round(((event.clientX - rect.left) / rect.width) * total))));
  };
  const scrub = useRef(false);
  const seconds = Math.ceil(total / resolved.fps);
  const tick = seconds > 40 ? 5 : seconds > 15 ? 2 : 1;
  const cuts = resolved.footage.segments.slice(1).map((segment) => segment.from);
  const volume = resolved.audio.tracks.length ? [resolved.audio.tracks[0].volume] : [1];

  return (
    <div className="timeline">
      <div className="track-labels">
        <div className="ruler-label" />
        <div>段落</div>
        <div>字幕</div>
        <div>叠加</div>
        <div className="audio-label">音频</div>
      </div>
      <div
        className="tracks"
        ref={host}
        onPointerDown={(event) => {
          scrub.current = true;
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
          seekFromEvent(event);
        }}
        onPointerMove={(event) => scrub.current && seekFromEvent(event)}
        onPointerUp={() => (scrub.current = false)}
      >
        <div className="ruler">
          {Array.from({ length: Math.floor(seconds / tick) + 1 }, (_, index) => index * tick).map((second) => (
            <span key={second} style={{ left: x(second * resolved.fps) }}>
              {second}s
            </span>
          ))}
        </div>
        <div className="track">
          {resolved.footage.segments.map((segment) => (
            <div
              key={segment.id}
              className={`clip segment ${decisions[segment.id] ?? "undecided"}${selection?.kind === "segment" && selection.id === segment.id ? " selected" : ""}`}
              style={{ left: x(segment.from), width: x(segment.durationInFrames) }}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect({ kind: "segment", id: segment.id });
                onSeek(segment.from);
              }}
            >
              {segment.id}
            </div>
          ))}
        </div>
        <div className="track">
          {resolved.captions?.cues.map((cue, index) => (
            <div key={index} className="clip cue" style={{ left: x(cue.from), width: Math.max(2, x(cue.to - cue.from)) }} title={cue.lines.flat().map((word) => word.text).join(" ")}>
              {cue.lines.flat().map((word) => word.text).join(" ")}
            </div>
          ))}
        </div>
        <div className="track overlays-track">
          {resolved.overlays.map((overlay, index) => (
            <div
              key={overlay.id}
              className={`clip overlay${selection?.kind === "overlay" && selection.id === overlay.id ? " selected" : ""}`}
              style={{ left: x(overlay.from), width: Math.max(3, x(overlay.durationInFrames)), top: (index % 2) * 13 + 2 }}
              title={`${overlay.id} (${overlay.effect})`}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect({ kind: "overlay", id: overlay.id });
                if (frame < overlay.from || frame >= overlay.from + overlay.durationInFrames) onSeek(overlay.from + Math.min(15, Math.floor(overlay.durationInFrames / 2)));
              }}
            >
              {overlay.id}
            </div>
          ))}
          {warnings
            .filter((warning) => warning.kind === "face")
            .map((warning, index) => (
              <div key={index} className="warn-range" style={{ left: x(warning.fromFrame), width: Math.max(2, x(warning.toFrame - warning.fromFrame)) }} title={warning.message} />
            ))}
        </div>
        <div className="track audio-track">{peaks && width ? <Waveform peaks={peaks} width={width} volume={volume} /> : <span className="muted small">波形加载中…</span>}</div>
        {cuts.map((cut) => (
          <div key={cut} className="cut-line" style={{ left: x(cut) }} title={`跳剪 @ ${cut}`} />
        ))}
        <div className="playhead" style={{ left: x(frame) }} />
      </div>
    </div>
  );
};

import { useLayoutEffect, useRef, useState } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { ResolvedPlan } from "./resolve.ts";

// A line wider than the caption box is scaled down to fit. Lines that fit are
// left untouched, so plans whose lines already fit render exactly as before.
// Must only mount once fonts are loaded, so the measurement uses the real font.
const FittedLine: React.FC<{ maxWidth: number; children: React.ReactNode }> = ({ maxWidth, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    setScale(width > maxWidth ? maxWidth / width : 1);
  }, [maxWidth]);
  return (
    <div
      ref={ref}
      data-caption-line
      style={{ display: "flex", justifyContent: "center", whiteSpace: "nowrap", width: "max-content", ...(scale !== 1 ? { transform: `scale(${scale})` } : {}) }}
    >
      {children}
    </div>
  );
};

// Word-by-word captions: the cue on screen is chosen by output frame, and the
// word being spoken switches to activeColor.
export const Captions: React.FC<{ captions: NonNullable<ResolvedPlan["captions"]> }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cue = captions.cues.find((item) => frame >= item.from && frame < item.to);
  if (!cue) return null;
  const timeMs = Math.max(frame / fps * 1000, cue.startMs);
  const { box } = captions;
  return (
    <div
      data-caption-root
      data-cue-start={cue.startMs}
      style={{
        position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height,
        display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
        color: captions.color, fontSize: captions.fontSize, lineHeight: `${captions.lineHeight}px`, fontWeight: captions.fontWeight,
        ...(captions.background ? { backgroundColor: captions.background } : {}),
      }}
    >
      {cue.lines.map((line, lineIndex) => (
        <FittedLine key={`${cue.startMs}-${lineIndex}`} maxWidth={box.width}>
          {line.map((word, index) => {
            // A scaled (emphasised) word gets extra side margin so it does not overlap its neighbours.
            const extra = word.scale !== 1 ? captions.fontSize * (word.scale - 1) : 0;
            return (
              <span
                key={`${word.startMs}-${index}`}
                data-caption-word
                style={{
                  color: timeMs >= word.startMs && timeMs < word.endMs ? captions.activeColor : (word.color ?? captions.color),
                  marginRight: (index < line.length - 1 ? captions.wordGap : 0) + extra,
                  ...(extra ? { marginLeft: extra, display: "inline-block", transform: `scale(${word.scale})` } : {}),
                }}
              >
                {word.text}
              </span>
            );
          })}
        </FittedLine>
      ))}
    </div>
  );
};

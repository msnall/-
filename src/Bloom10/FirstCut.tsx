import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import cues from "../../public/transcripts/Bloom10-达人素材.edited.cues.json";
import words from "../../public/transcripts/Bloom10-达人素材.edited.json";

const paper = "#fff8fb";
const ink = "#231b22";
const accent = "#c95f8e";
const activeInk = "#9f3262";

function splitLines(text: string): string[][] {
  const pieces = text.split(" ");
  if (text.length <= 24) return [pieces];
  let split = 1;
  let best = Infinity;
  for (let index = 1; index < pieces.length; index++) {
    const left = pieces.slice(0, index).join(" ").length;
    const right = pieces.slice(index).join(" ").length;
    const score = Math.max(left, right) + Math.abs(left - right) * 0.2;
    if (score < best) {
      best = score;
      split = index;
    }
  }
  return [pieces.slice(0, split), pieces.slice(split)];
}

const captionData = cues.map((cue) => {
  const timings = words.filter((word) => word.startMs >= cue.startMs && word.endMs <= cue.endMs);
  const lines = splitLines(cue.text);
  if (timings.length !== cue.text.split(" ").length) {
    throw new Error(`Caption word counts differ at ${cue.startMs}ms`);
  }
  let offset = 0;
  return {
    ...cue,
    lines: lines.map((line) => line.map((text) => ({ ...timings[offset++], displayText: text }))),
  };
});

const headers = [
  { from: 0, until: 150, text: "ONE WEEK IN" },
  // The verified alpha label runs 263–323, so the next header waits until it ends.
  { from: 323, until: 456, text: "THE BOTTLE PROBLEM" },
  { from: 515, until: 588, text: "A CLOSER LOOK" },
  { from: 825, until: 909, text: "SEE PRODUCT DETAILS" },
];

const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const cue = captionData.find((item) => frame >= item.startFrame && frame < item.endFrame);
  if (!cue) return null;
  const timeMs = Math.max(frame / 30 * 1000, cue.startMs);
  return (
    <div
      data-caption-root
      data-cue-start={cue.startMs}
      style={{
        position: "absolute", left: 90, top: 1540, width: 800, height: 140,
        display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
        color: ink, fontSize: 58, lineHeight: "70px", fontWeight: 700,
      }}
    >
      {cue.lines.map((line, lineIndex) => (
        <div key={lineIndex} data-caption-line style={{ display: "flex", justifyContent: "center", whiteSpace: "nowrap" }}>
          {line.map((word, index) => (
            <span
              key={`${word.startMs}-${index}`}
              data-caption-word
              style={{
                color: timeMs >= word.startMs && timeMs < word.endMs ? activeInk : ink,
                marginRight: index < line.length - 1 ? 13 : 0,
              }}
            >
              {word.displayText}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
};

export const Bloom10FirstCut: React.FC = () => {
  const frame = useCurrentFrame();
  const [fontHandle] = useState(() => delayRender("Loading local Inter font"));
  useEffect(() => {
    document.fonts.load('700 58px "BloomInter"').then(() => continueRender(fontHandle)).catch(cancelRender);
  }, [fontHandle]);
  const header = headers.find((item) => frame >= item.from && frame < item.until);
  let opacity = 1;
  let y = 0;
  if (header) {
    const local = frame - header.from;
    const duration = header.until - header.from;
    opacity = header.from === 0
      ? interpolate(local, [duration - 8, duration - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : interpolate(local, [0, 9, duration - 8, duration - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    y = header.from === 0 ? 0 : interpolate(local, [0, 10], [14, 0], { extrapolateRight: "clamp" });
  }
  return (
    <AbsoluteFill style={{ backgroundColor: paper, fontFamily: '"BloomInter", sans-serif', color: ink }}>
      <style>{`@font-face { font-family: "BloomInter"; src: url("${staticFile("fonts/Inter-700.woff2")}") format("woff2"); font-weight: 700; font-style: normal; font-display: block; }`}</style>
      <div style={{ position: "absolute", left: 43, top: 38, width: 842, height: 1498, overflow: "hidden", borderRadius: 18 }}>
        <Img
          src={staticFile(`derived/bloom10/frames/frame-${String(Math.min(frame, 908)).padStart(4, "0")}.jpg`)}
          style={{ width: 842, height: 1498, objectFit: "fill" }}
        />
      </div>
      <Audio src={staticFile("derived/bloom10/mix.wav")} />
      {header ? (
        <div
          data-header
          style={{
            position: "absolute", left: 110, top: 60, width: 760, minHeight: 112,
            boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
            padding: "24px 32px", backgroundColor: paper, borderLeft: `8px solid ${accent}`,
            fontSize: 46, lineHeight: 1.2, letterSpacing: 1.2, fontWeight: 700,
            opacity, transform: `translateY(${y}px)`,
          }}
        >{header.text}</div>
      ) : null}
      <Sequence from={263} durationInFrames={60} name="HyperFrames packaging label">
        <OffthreadVideo
          src={staticFile("effects/packaging-label.webm")}
          transparent
          muted
          style={{ position: "absolute", left: 0, top: -160, width: 1080, height: 1920 }}
        />
      </Sequence>
      <Captions />
      <div style={{ position: "absolute", left: 90, top: 1730, width: 800, height: 5, backgroundColor: accent }} />
    </AbsoluteFill>
  );
};

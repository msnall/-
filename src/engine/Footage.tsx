import { Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { zoomAt } from "./layout.ts";
import { imageSequenceFile, type ResolvedPlan, type ResolvedSegment } from "./resolve.ts";

type FootageLayout = ResolvedPlan["footage"];

const SegmentPicture: React.FC<{ segment: ResolvedSegment; layout: FootageLayout; segmentAudio: boolean }> = ({ segment, layout, segmentAudio }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = zoomAt(segment.camera, frame);
  const { grade } = layout;
  const style: React.CSSProperties = {
    width: layout.width,
    height: layout.height,
    objectFit: layout.fit,
    // Identity transforms/filters are left out so an unzoomed, ungraded plan
    // draws exactly the same pixels as a plain image.
    ...(zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: `${segment.camera.originX * 100}% ${segment.camera.originY * 100}%` } : {}),
    ...(grade && (grade.brightness !== 1 || grade.contrast !== 1 || grade.saturate !== 1)
      ? { filter: `brightness(${grade.brightness}) contrast(${grade.contrast}) saturate(${grade.saturate})` }
      : {}),
  };
  const { source } = segment;
  if (source.type === "video") {
    return <OffthreadVideo src={staticFile(source.src)} trimBefore={source.trimBefore} muted={!segmentAudio} style={style} />;
  }
  const index = Math.min(source.startIndex + Math.floor((frame * source.assetFps) / fps), source.frameCount - 1);
  return <Img src={staticFile(imageSequenceFile(source.dir, source.pattern, index))} style={style} />;
};

// The main picture, clipped to its layout box, one Sequence per kept segment.
export const Footage: React.FC<{ footage: FootageLayout; segmentAudio: boolean }> = ({ footage, segmentAudio }) => (
  <div
    data-footage
    style={{ position: "absolute", left: footage.x, top: footage.y, width: footage.width, height: footage.height, overflow: "hidden", borderRadius: footage.borderRadius }}
  >
    {footage.segments.map((segment) => (
      <Sequence key={segment.id} from={segment.from} durationInFrames={segment.durationInFrames} layout="none" name={`segment ${segment.id}`}>
        <SegmentPicture segment={segment} layout={footage} segmentAudio={segmentAudio} />
      </Sequence>
    ))}
  </div>
);

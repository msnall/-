import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const EnvironmentTest: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#101827",
        color: "#f8fafc",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: '"Microsoft YaHei", sans-serif',
      }}
    >
      <div style={{ opacity, textAlign: "center" }}>
        <div style={{ color: "#5eead4", fontSize: 26, letterSpacing: 6 }}>
          VIDEO AUTOMATION
        </div>
        <h1 style={{ fontSize: 100, margin: "36px 0", fontWeight: 700 }}>
          环境测试
        </h1>
        <div style={{ color: "#94a3b8", fontSize: 32 }}>
          1080 × 1920 · 30 fps · 3 秒
        </div>
        <div
          style={{
            marginTop: 56,
            height: 6,
            width: 640,
            backgroundColor: "#243247",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${(frame / 89) * 100}%`,
              backgroundColor: "#5eead4",
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

import { AbsoluteFill, Composition } from "remotion";
import { EnvironmentTest } from "./Composition";
import { calculateEditPlanMetadata, EditPlanVideo, type EditPlanProps } from "./engine/EditPlanVideo.tsx";

const EditPlanEntry: React.FC<EditPlanProps> = (props) => props.resolved
  ? <EditPlanVideo {...props} />
  : <AbsoluteFill style={{ background: "#111827", color: "#fff", justifyContent: "center", alignItems: "center", fontFamily: "sans-serif" }}>从工作台选择视频，或通过 --props 指定 edit-plan</AbsoluteFill>;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The render script supplies each project's plan via --props. */}
      <Composition
        id="EditPlan"
        component={EditPlanEntry}
        defaultProps={{ plan: null } satisfies EditPlanProps}
        calculateMetadata={calculateEditPlanMetadata}
      />
      <Composition
        id="Reel"
        component={EnvironmentTest}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};

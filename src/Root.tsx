import { Composition } from "remotion";
import { EnvironmentTest } from "./Composition";
import { calculateEditPlanMetadata, EditPlanVideo, type EditPlanProps } from "./engine/EditPlanVideo.tsx";
import bloom10Plan from "../projects/bloom10/edit-plan.json";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Any edit-plan renders through this composition. Studio opens the Bloom10
          plan by default; scripts/render-plan.mjs passes other plans via --props. */}
      <Composition
        id="EditPlan"
        component={EditPlanVideo}
        defaultProps={{ plan: bloom10Plan } satisfies EditPlanProps}
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

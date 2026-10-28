import { Composition } from "remotion";
import { EnvironmentTest } from "./Composition";
import { Bloom10FirstCut } from "./Bloom10/FirstCut";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Bloom10FirstCut"
        component={Bloom10FirstCut}
        durationInFrames={909}
        fps={30}
        width={1080}
        height={1920}
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

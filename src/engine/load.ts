import { resolvePlan, type AssetFacts, type ResolvedPlan } from "./resolve.ts";
import { parseEditPlan, type EditPlan } from "./schema.ts";
import { parseTranscript, type Transcript } from "./transcript.ts";

// One entry point shared by the Node scripts (reading from disk) and the
// Remotion composition (fetching through staticFile), so both run the exact
// same validation and timeline resolution.
export const loadEditPlan = async (
  input: unknown,
  readPublicJson: (publicPath: string) => Promise<unknown>,
  facts: AssetFacts = {},
): Promise<{ plan: EditPlan; transcript: Transcript | null; resolved: ResolvedPlan }> => {
  const plan = parseEditPlan(input);
  const transcript = plan.transcript
    ? parseTranscript(await readPublicJson(plan.transcript.words), await readPublicJson(plan.transcript.cues), plan.transcript)
    : null;
  return { plan, transcript, resolved: resolvePlan(plan, transcript, facts) };
};

export { parseEditPlan, PlanError, SCHEMA_VERSION, type EditPlan } from "./schema.ts";
export { assetFile, imageSequenceFile, type ResolvedPlan } from "./resolve.ts";
export { effectIds } from "./effects/catalog.ts";

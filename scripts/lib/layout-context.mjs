// Face analysis, manual face corrections and the TikTok safe zones for a
// project, in the shape src/engine/layout.ts checkLayout() expects.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { segmentAssets } from "../../src/engine/layout.ts";
import { root } from "./media.mjs";

const readOptionalJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${path.relative(root, file)}: ${error.message}`);
  }
};

export const safeZonesFile = path.join(root, "src/engine/safe-zones/tiktok.json");

export async function loadLayoutContext(projectDir, plan) {
  const analysis = path.join(projectDir, "analysis");
  return {
    assetIds: segmentAssets(plan),
    faces: await readOptionalJson(path.join(analysis, "faces.json")),
    overrides: await readOptionalJson(path.join(analysis, "faces.overrides.json")),
    safeZones: await readOptionalJson(safeZonesFile),
  };
}

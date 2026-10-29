// The plan as the browser plays it: the same engine (loadEditPlan) on a copy
// whose assets point at /media/<project>/<asset> — proxies for footage — so
// the page never loads an original.
import { loadEditPlan, type ResolvedPlan } from "../../src/engine/load.ts";
import type { RawPlan } from "./api.ts";

const jsonCache = new Map<string, Promise<unknown>>();
const readPublicJson = (publicPath: string) => {
  if (!jsonCache.has(publicPath)) {
    jsonCache.set(
      publicPath,
      fetch("/" + publicPath.split("/").map(encodeURIComponent).join("/")).then((response) => {
        if (!response.ok) throw new Error(`Cannot load ${publicPath} (HTTP ${response.status})`);
        return response.json();
      }),
    );
  }
  return jsonCache.get(publicPath)!;
};

export const previewPlan = (plan: RawPlan): RawPlan => {
  const segmentAssets = new Set(plan.segments.map((segment) => segment.asset));
  const assets: RawPlan["assets"] = {};
  for (const [id, asset] of Object.entries(plan.assets)) {
    const media = `media/${plan.id}/${id}`;
    if (asset.path?.startsWith("desk/")) {
      // Desk placeholders (e.g. a missing asset in a storyboard preview).
      assets[id] = { type: asset.type, path: asset.path };
    } else if (asset.type === "imageSequence" && segmentAssets.has(id)) {
      // The proxy is a video at the sequence's frame rate (same as output fps).
      assets[id] = { type: "video", path: media };
    } else if (asset.type === "imageSequence") {
      assets[id] = { ...asset, dir: media };
    } else {
      assets[id] = { type: asset.type, path: media };
    }
  }
  return { ...plan, assets };
};

export async function resolvePreview(plan: RawPlan): Promise<{ preview: RawPlan; resolved: ResolvedPlan }> {
  const preview = previewPlan(plan);
  const { resolved } = await loadEditPlan(preview, readPublicJson);
  return { preview, resolved };
}

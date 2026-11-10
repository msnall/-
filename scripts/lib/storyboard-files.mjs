// Loads the technique library and a project's pre-edit files (project.json,
// assets.json, analysis/beats.json, storyboard/<round>/*) and compiles an
// option with src/engine/storyboard.ts. Shared by scripts and the desk server.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cardSchema, styleSchema, tasteRulesSchema } from "../../src/engine/library.ts";
import { assetsSchema, beatsSchema, compileOption, optionSchema, projectSchema, selectionSchema } from "../../src/engine/storyboard.ts";
import { parseTranscript } from "../../src/engine/transcript.ts";
import { loadLayoutContext } from "./layout-context.mjs";
import { publicDir, root } from "./media.mjs";
import { listJson, projectDir, projectFile, readJson } from "./storage.mjs";

const libraryDir = path.join(root, "library");

const parse = (schema, data, where) => {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${where}:\n${result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`);
  return result.data;
};

export async function loadLibrary() {
  const cards = {};
  for (const name of await listJson(path.join(libraryDir, "techniques"))) {
    const card = parse(cardSchema, await readJson(path.join(libraryDir, "techniques", name)), `library/techniques/${name}`);
    if (`${card.id}.json` !== name) throw new Error(`library/techniques/${name}: file name must be ${card.id}.json`);
    cards[card.id] = card;
  }
  const styles = {};
  for (const name of await listJson(path.join(libraryDir, "styles"))) {
    const style = parse(styleSchema, await readJson(path.join(libraryDir, "styles", name)), `library/styles/${name}`);
    if (`${style.id}.json` !== name) throw new Error(`library/styles/${name}: file name must be ${style.id}.json`);
    styles[style.id] = style;
  }
  const tasteRules = parse(tasteRulesSchema, await readJson(path.join(libraryDir, "taste-rules.json"), { version: 1, rules: [] }), "library/taste-rules.json");
  return { cards, styles, tasteRules };
}

const transcriptCache = new Map();
async function loadTranscript(project) {
  const key = `${project.transcript.words}|${project.transcript.cues}`;
  if (!transcriptCache.has(key)) {
    const read = async (file) => JSON.parse(await readFile(path.join(publicDir, file), "utf8"));
    transcriptCache.set(key, parseTranscript(await read(project.transcript.words), await read(project.transcript.cues), project.transcript));
  }
  return transcriptCache.get(key);
}

export const ROUND = /^r[1-9]\d*$/;
export const OPTION = /^option-[a-z]$/;

export async function loadProjectInputs(projectId) {
  const project = parse(projectSchema, await readJson(projectFile(projectId, "project.json")), `projects/${projectId}/project.json`);
  const assets = parse(assetsSchema, await readJson(projectFile(projectId, "assets.json"), { version: 1, items: [], claims: [] }), `projects/${projectId}/assets.json`);
  const beatsRaw = await readJson(projectFile(projectId, "analysis/beats.json"), null);
  const beats = beatsRaw ? parse(beatsSchema, beatsRaw, `projects/${projectId}/analysis/beats.json`) : null;
  const transcript = await loadTranscript(project);
  return { project, assets, beats, transcript };
}

export async function loadRound(projectId, round) {
  if (!ROUND.test(round)) throw new Error(`Bad round "${round}"`);
  const dir = projectFile(projectId, "storyboard", round);
  const options = [];
  for (const name of await listJson(dir)) {
    if (!OPTION.test(name.replace(/\.json$/, ""))) continue;
    options.push(parse(optionSchema, await readJson(path.join(dir, name)), `projects/${projectId}/storyboard/${round}/${name}`));
  }
  const selection = parse(selectionSchema, await readJson(path.join(dir, "selection.json"), { round }), `projects/${projectId}/storyboard/${round}/selection.json`);
  return { options, selection };
}

// Picture assets the footage comes from, as { id: asset } in edit-plan form:
// from the edit-plan's segments when it exists, otherwise (before a storyboard
// is confirmed) the project's footage in assets.json.
export async function footageAssets(projectId) {
  const plan = await readJson(projectFile(projectId, "edit-plan.json"), null);
  if (plan) {
    const ids = [...new Set(plan.segments.map((segment) => segment.asset))];
    return Object.fromEntries(ids.map((id) => [id, plan.assets[id]]));
  }
  const project = await readJson(projectFile(projectId, "project.json"));
  const assets = await readJson(projectFile(projectId, "assets.json"));
  const item = assets.items.find((entry) => entry.id === project.footage);
  if (!item?.file) throw new Error(`projects/${projectId}: footage "${project.footage}" has no file in assets.json`);
  return { [item.id]: { type: "video", path: item.file, ...(item.sha256 ? { sha256: item.sha256 } : {}) } };
}

// Compile one option. `selection` overrides (style, layout, cards) apply only when
// the selection is for that option.
export async function compileProjectOption(projectId, round, optionId, { selection: selectionOverride, library } = {}) {
  const [inputs, { options, selection: stored }, lib] = await Promise.all([loadProjectInputs(projectId), loadRound(projectId, round), library ?? loadLibrary()]);
  if (!inputs.beats) throw new Error(`projects/${projectId}/analysis/beats.json does not exist yet`);
  const option = options.find((item) => item.id === optionId);
  if (!option) throw new Error(`No ${optionId} in storyboard/${round}`);
  const selection = selectionOverride ?? stored;
  const applies = selection?.option === optionId ? selection : null;
  const mixLayers = await readJson(projectFile(projectId, "storyboard", round, "mix.json"), null);
  if (mixLayers) inputs.project.footage = mixLayers.source.id;
  const layout = await loadLayoutContext(projectDir(projectId), { segments: [] });
  const result = compileOption({
    ...inputs,
    option,
    cards: lib.cards,
    styles: lib.styles,
    selection: applies && mixLayers ? { ...applies, layoutOverrides: Object.fromEntries(Object.entries(applies.layoutOverrides ?? {}).filter(([id]) => id !== "mix-presenter")) } : applies,
    tasteRules: lib.tasteRules,
    layout: { faces: layout.faces, overrides: layout.overrides, safeZones: layout.safeZones },
  });
  if (mixLayers && result.plan) {
    const inherit = mixLayers.inherited;
    if (inherit && inherit.style === result.plan.meta.storyboard.style) {
      if (inherit.captions) result.plan.captions = inherit.captions;
      else if (result.plan.captions) result.plan.captions.box = { ...result.plan.captions.box, y: 840 };
      result.plan.theme = inherit.theme;
      result.plan.layout = inherit.layout;
    } else if (result.plan.captions) {
      result.plan.captions.box = { ...result.plan.captions.box, y: 840 };
    }
    result.plan.assets[mixLayers.actor.id] = { type: "video", path: mixLayers.actor.file };
    const saved = inherit?.presenter;
    const rect = applies?.layoutOverrides?.["mix-presenter"] ?? (saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { x: 590, y: 1060, width: 300, height: 534 });
    result.plan.overlays.push({ id: "mix-presenter", effect: "alpha-video@1", from: { frame: 0 }, until: { fromEnd: 0 }, layer: "below-captions", props: { asset: mixLayers.actor.id, ...rect } });
    result.plan.meta.mix = { variant: mixLayers.variant, revision: mixLayers.revision, round };
  }
  const settings = applies?.videoSettings;
  if (result.plan && settings) {
    if (settings.captions?.enabled === false) delete result.plan.captions;
    else if (result.plan.captions && settings.captions) {
      const { enabled, background, ...values } = settings.captions;
      Object.assign(result.plan.captions, values);
      if (background === null) delete result.plan.captions.background;
      else if (background !== undefined) result.plan.captions.background = background;
      if (values.fontSize) result.plan.captions.lineHeight = Math.round(values.fontSize * 1.2);
    }
    const presenter = result.plan.overlays.find((overlay) => overlay.id === "mix-presenter");
    if (presenter && settings.presenter?.box) Object.assign(presenter.props, settings.presenter.box);
    if (settings.presenter?.enabled === false) result.plan.overlays = result.plan.overlays.filter((overlay) => overlay.id !== "mix-presenter");
    result.plan.meta.videoSettings = settings;
  }
  return result;
}

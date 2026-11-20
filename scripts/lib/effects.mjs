// The one list of effects the director may use (方案表格's drop-downs, the prompts and the JSON schemas are all generated from
// here), the pacing presets, and the hook treatments. Anything the renderer cannot do yet has ready:false and is never offered
// to the model. See docs: 剪辑方案优化 v1.2.
export const EFFECTS = {
  zoom: [
    { id: "z100", scale: 1.0, ready: true, desc: "no zoom (wide/medium)" },
    { id: "z110", scale: 1.1, ready: true, desc: "subtle push" },
    { id: "z115", scale: 1.15, ready: true, desc: "close; alternate with z100 on adjacent talking-head beats for jump-cut feel" },
    { id: "z120", scale: 1.2, ready: true, desc: "tight; hook word or emotional peak" },
    { id: "punch", ready: false, desc: "snap zoom-in at anchor word (keyframe); impact moments" },
  ],
  brollLayout: [
    { id: "full", ready: true, desc: "screen recording covers the creator; creator audio continues" },
    { id: "pip", ready: true, desc: "small window at a slot; creator face stays visible" },
  ],
  pipSlot: ["top-right", "top-left", "lower-right", "lower-left"],
  brollMotion: [
    { id: "static", ready: true, desc: "no motion" },
    { id: "pushIn", ready: false, desc: "slow push-in on the B-roll" },
  ],
  // caption emphasis colours: id -> hex written into cut-script emphasis.color (default = the compiler's own colour)
  emphasisColor: [
    { id: "default", hex: null, ready: true, desc: "the theme's highlight colour" },
    { id: "yellow", hex: "#ffd23f", ready: true, desc: "warm highlight" },
    { id: "red", hex: "#ff5a5f", ready: true, desc: "warning, pain point, number" },
    { id: "green", hex: "#2ee6c8", ready: true, desc: "result, benefit" },
  ],
};
export const ready = (list) => list.filter((x) => x.ready !== false);
export const ZOOM_IDS = ready(EFFECTS.zoom).map((z) => z.id);
export const ZOOM_SCALE = Object.fromEntries(EFFECTS.zoom.filter((z) => z.scale).map((z) => [z.id, z.scale]));
export const zoomIdOf = (scale) => ZOOM_IDS.find((id) => Math.abs(ZOOM_SCALE[id] - scale) < 0.005) ?? null;
export const COLOR_IDS = ready(EFFECTS.emphasisColor).map((c) => c.id);
export const COLOR_HEX = Object.fromEntries(EFFECTS.emphasisColor.map((c) => [c.id, c.hex]));
export const PIP_SLOTS = EFFECTS.pipSlot;

export const HOOK_TREATMENTS = [
  { id: "creator_punch", desc: "creator on screen, tightest zoom (z120) on the hook beat" },
  { id: "pip_hook", desc: "creator on screen; product screen appears as PIP right after noPipBeforeMs" },
  { id: "slow_tension", desc: "creator on screen, zoom builds up step by step until the reveal beat (hook beat starts at z100/z110)" },
  { id: "color_hook", desc: "hook beat emphasizes 2-3 words in a strong colour (not default), creator at z100-z110" },
];

export const PACING_PRESETS = {
  fast: { noFullBrollBeforeMs: 2000, noPipBeforeMs: 1000, minShotMs: 600, maxShotMs: 2500, maxBrollRatio: 0.7, maxStaticMs: 2500, alternateZoom: true },
  medium: { noFullBrollBeforeMs: 2000, noPipBeforeMs: 1500, minShotMs: 800, maxShotMs: 3500, maxBrollRatio: 0.55, maxStaticMs: 3500, alternateZoom: true },
  calm: { noFullBrollBeforeMs: 2500, noPipBeforeMs: 2000, minShotMs: 1000, maxShotMs: 4000, maxBrollRatio: 0.4, maxStaticMs: 5000, alternateZoom: false },
};
export const PACING_IDS = Object.keys(PACING_PRESETS);
export const STRUCTURES = ["problem", "product_demo", "result", "story"];
export const PLACEMENTS = ["front_loaded", "demo_cluster", "spread"];
export const LAYOUT_BIAS = ["full", "pip", "mixed"];
export const ZOOM_PATTERNS = ["alternate", "build_up", "peaks_only"];

// What the prompts show the model (only what is ready)
export const effectsText = () => JSON.stringify({
  zoom: ready(EFFECTS.zoom).map(({ id, desc }) => ({ id, desc })),
  brollLayout: ready(EFFECTS.brollLayout).map(({ id, desc }) => ({ id, desc })),
  pipSlot: EFFECTS.pipSlot,
  emphasisColor: ready(EFFECTS.emphasisColor).map(({ id, desc }) => ({ id, desc })),
}, null, 1);

// ---- JSON schemas (also given to the API as a tool when the relay supports it; the program validates every enum anyway) ----
export const directionsSchema = () => ({
  type: "object", required: ["directions"],
  properties: { directions: { type: "array", minItems: 3, maxItems: 3, items: {
    type: "object",
    required: ["name_zh", "hookTreatment", "structureEmphasis", "pacing", "brollPlacement", "layoutBias", "zoomPattern", "brollRatioTarget", "hookBeat", "climaxBeat", "followsStyleCard", "why_zh", "oneLineSummary_zh"],
    properties: {
      name_zh: { type: "string" }, hookTreatment: { type: "string", enum: HOOK_TREATMENTS.map((h) => h.id) },
      structureEmphasis: { type: "string", enum: STRUCTURES }, pacing: { type: "string", enum: PACING_IDS },
      brollPlacement: { type: "string", enum: PLACEMENTS }, layoutBias: { type: "string", enum: LAYOUT_BIAS },
      zoomPattern: { type: "string", enum: ZOOM_PATTERNS }, brollRatioTarget: { type: "number" },
      hookBeat: { type: "string" }, climaxBeat: { type: "string" }, followsStyleCard: { type: "boolean" },
      why_zh: { type: "string" }, oneLineSummary_zh: { type: "string" },
    } } } },
});

export const planSchema = ({ assetIds, colorIds = COLOR_IDS }) => ({
  type: "object", required: ["direction", "splits", "beats", "broll", "emphasis", "logo", "notes_zh"],
  properties: {
    direction: { type: "string" },
    splits: { type: "array", items: { type: "object", required: ["beat", "word"], properties: { beat: { type: "string" }, word: { type: "integer" } } } },
    beats: { type: "array", description: "one entry per beat AFTER splits, in order", items: { type: "object", required: ["beat", "zoom"], properties: { beat: { type: "string" }, zoom: { type: "string", enum: ZOOM_IDS } } } },
    broll: { type: "array", items: { type: "object", required: ["asset", "beat", "word", "srcStartMs", "durationMs", "layout", "reason_zh"], properties: {
      asset: { type: "string", enum: assetIds }, beat: { type: "string" }, word: { type: "integer" }, srcStartMs: { type: "integer" }, durationMs: { type: "integer" },
      layout: { type: "string", enum: ready(EFFECTS.brollLayout).map((l) => l.id) }, slot: { type: "string", enum: PIP_SLOTS }, reason_zh: { type: "string" } } } },
    emphasis: { type: "array", items: { type: "object", required: ["beat", "word"], properties: { beat: { type: "string" }, word: { type: "integer" }, color: { type: "string", enum: colorIds } } } },
    logo: { type: ["object", "null"] },
    notes_zh: { type: "string" },
  },
});

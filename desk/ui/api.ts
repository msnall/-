// Everything the page knows comes through these calls (rule 1: UI only via API).
import type { FaceAnalysis, FaceOverrides, LayoutWarning, Rect, SafeZones } from "../../src/engine/layout.ts";
export type { FaceAnalysis, FaceOverrides, SafeZones };
import type { PatchOperation } from "../../scripts/lib/json-patch.mjs";
import type { Card, StylePack, TasteRules } from "../../src/engine/library.ts";
import type { Assets, Beats, CompileResult, Selection as StoryboardSelection, StoryboardOption } from "../../src/engine/storyboard.ts";

export type { Assets, Beats, CompileResult, StoryboardSelection, StoryboardOption };

export type RawPlan = {
  schemaVersion: number;
  id: string;
  revision?: number;
  meta?: Record<string, unknown>;
  assets: Record<string, { type: string; path?: string; dir?: string; pattern?: string; sha256?: string; fps?: number; frameCount?: number }>;
  segments: { id: string; asset: string; sourceStartMs: number; sourceEndMs: number; camera?: unknown }[];
  captions?: { box: Rect; fontSize: number; color: string; activeColor: string; background?: string; [key: string]: unknown };
  overlays?: { id: string; effect: string; from: unknown; until?: unknown; durationFrames?: number; layer?: string; props: Record<string, unknown> }[];
  [key: string]: unknown;
};

export type StageState = { state: "pending" | "in-progress" | "waiting-user" | "done" | "blocked"; round?: string; openProposals?: number; note?: string; reason?: string };
export type Status = { project: string; stage: string; stages: Record<string, StageState>; editPlanRevision: number };

export type Proposal = {
  id: string;
  state: "pending" | "accepted" | "rejected" | "stale" | "superseded";
  basedOnRevision: number;
  answers?: string[];
  summary?: string;
  reason?: string;
  changes: (PatchOperation & { before?: unknown })[];
  preview?: { before?: string[]; after?: string[]; clip?: string };
  impact?: { durationDeltaFrames?: number; segments?: string[] };
  createdBy?: string;
  createdAt?: string;
  decidedAt?: string;
  staleReason?: string;
  rejectComment?: string;
  appliedRevision?: number;
  problem: string | null;
};

export type Comment = { id: string; text: string; at?: { frame: number }; proposal?: string; createdAt: string; by: "user" | "claude" };
export type Decision = "keep" | "drop" | "modify" | "undecided";
export type Review = { round: string; editPlanRevision: number; storyboardRound?: string | null; segments: { segment: string; decision: Decision; comments: Comment[] }[]; comments: Comment[]; submittedAt: string | null };

export type Project = {
  id: string;
  revision: number;
  plan: RawPlan;
  status: Status;
  validation: { ok: boolean; problems: string[]; warnings: LayoutWarning[] };
  faces: FaceAnalysis | null;
  faceOverrides: FaceOverrides | null;
  safeZones: SafeZones | null;
  proxies: Record<string, { width: number; height: number; createdAt: string }>;
  proposals: Proposal[];
};

export type Job = { id: string; project: string; type: string; state: "queued" | "running" | "done" | "failed"; phase?: "queued" | "preparing" | "rendering" | "processing" | "quality-check" | "finalizing" | "completed" | "failed"; renderProgress?: { frames: number; total: number; percent: number }; exportId?: string; createdAt: string; startedAt: string | null; finishedAt: string | null; output?: string; error?: string; params: Record<string, unknown> };
export type ExportSettings = { approved: boolean; reason: string | null; projectName: string; storyboardRound: string | null; revision: number; planHash: string; filename: string; width: number; height: number; fps: number; aspectRatio: string; format: string; codec: string; audio: string; outputDirectory: string };
export type ExportRecord = { id: string; projectId: string; storyboardRevision: string | null; editPlanRevision: number; editPlanSha256: string; filename: string; absolutePath: string; relativePath: string; renderedAt: string; qcStatus: string; status: string; video: { durationSeconds: number; width: number; height: number; fps: string; codec: string; audioCodec: string | null }; fileSize: number; thumbnail: string };
export type Version = { revision: number; savedAt: string; by: string; note: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? response.statusText, data.problems ?? []);
  return data as T;
}

const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export type Overview = { coverAsset?: string | null; cleanupConfirmed?: boolean; hasDrafts?: boolean; hasExports?: boolean; hasCatalog?: boolean; mode?: "mix"; editorReady?: boolean; mixEditorConfirmed?: boolean; style?: string; id: string; title: string; productName: string; status: Status; hasPlan: boolean; hasProject: boolean; transcriptReady: boolean; previewReady: boolean; ready: boolean; revision: number | null; updatedAt: string | null; media: { originalName: string; bytes: number; durationMs: number; width: number; height: number } | null };
export type OptionWithCompile = StoryboardOption & {
  compile: Pick<CompileResult, "problems" | "warnings" | "needs" | "claims" | "gate" | "segments">;
};
export type Library = { cards: Record<string, Card>; styles: Record<string, StylePack>; tasteRules: TasteRules };

export const storyboardApi = {
  presets: (id: string) => call<{ round: string; name: string; style: string; confirmedAt: string }[]>("GET", `${p(id)}/storyboard-presets`),
  createPreset: (id: string, input: { name: string; sourceRound?: string }) => call<{round: string}>("POST", `${p(id)}/storyboard-presets`, input),
  projects: () => call<Overview[]>("GET", "/api/projects"),
  overview: (id: string) => call<Overview>("GET", `${p(id)}/overview`),
  library: () => call<Library>("GET", "/api/library"),
  assets: (id: string) => call<{ assets: Assets; beats: Beats | null; footage: string; words: { index: number; text: string; startMs: number }[] }>("GET", `${p(id)}/assets`),
  approve: (id: string, asset: string, file: string) => call<Assets>("POST", `${p(id)}/assets/${asset}/approve`, { file }),
  rejectCandidate: (id: string, asset: string, file: string) => call<Assets>("POST", `${p(id)}/assets/${asset}/reject`, { file }),
  resetAsset: (id: string, asset: string) => call<Assets>("POST", `${p(id)}/assets/${asset}/reset`),
  upload: async (id: string, asset: string, file: File) => {
    const response = await fetch(`${p(id)}/assets/${asset}/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? response.statusText, data.problems ?? []);
    return data as Assets;
  },
  updateClaim: (id: string, claim: string, body: { status: string; evidence?: string; note?: string }) => call<Assets>("PUT", `${p(id)}/claims/${claim}`, body),
  shotList: (id: string) => call<{ id: string; kind: string; label?: string; neededBy: string[]; shotRequest: Record<string, string> | null }[]>("GET", `${p(id)}/shotlist`),
  saveBeats: (id: string, beats: Beats) => call<Beats>("PUT", `${p(id)}/beats`, beats),
  classifyBeats: (id: string) => call<Beats>("POST", `${p(id)}/beats/classify`),
  confirmBeats: (id: string, beats: Beats) => call<Beats>("POST", `${p(id)}/beats/confirm`, beats),
  round: (id: string, round: string) => call<{ round: string; options: OptionWithCompile[]; selection: StoryboardSelection }>("GET", `${p(id)}/storyboard/${round}`),
  rounds: (id: string) => call<string[]>("GET", `${p(id)}/storyboard-rounds`),
  revise: (id: string, round: string) => call<{ round: string }>("POST", `${p(id)}/storyboard/${round}/revise`),
  compile: (id: string, round: string, option: string, selection?: Partial<StoryboardSelection>) => call<CompileResult>("POST", `${p(id)}/storyboard/${round}/${option}/compile`, { selection }),
  saveSelection: (id: string, round: string, selection: Partial<StoryboardSelection>) => call<StoryboardSelection>("PUT", `${p(id)}/storyboard/${round}/selection`, selection),
  confirm: (id: string, round: string) => call<{ revision: number }>("POST", `${p(id)}/storyboard/${round}/confirm`),
  candidateSheets: (id: string) => call<string[]>("GET", `${p(id)}/candidate-sheets`),
  sheetUrl: (id: string, name: string) => `${p(id)}/candidate-sheets/${name}`,
  storyboardFileUrl: (id: string, file: string) => `${p(id)}/files/${file}`,
  thumbAt: (id: string, asset: string, ms: number) => `${p(id)}/thumbs/at/${asset}/${Math.round(ms)}`,
  layoutContext: (id: string) => call<{ faces: FaceAnalysis | null; overrides: FaceOverrides | null; safeZones: SafeZones | null }>("GET", `${p(id)}/layout-context`),
  publicUrl: (file: string) => "/" + file.split("/").map(encodeURIComponent).join("/"),
};

export const api = {
  projects: () => call<{ id: string; revision: number; stage: string; title: string }[]>("GET", "/api/projects"),
  trash: () => call<{ archiveId: string; id: string; title: string; productName: string; archivedAt: string }[]>("GET", "/api/trash"),
  archiveVideo: (id: string) => call<{ archiveId: string }>("POST", `${p(id)}/archive`),
  restoreVideo: (archiveId: string) => call<{ id: string }>("POST", `/api/trash/${encodeURIComponent(archiveId)}/restore`),
  permanentlyDeleteVideo: (archiveId: string) => call<{ archiveId: string; deleted: boolean }>("DELETE", `/api/trash/${encodeURIComponent(archiveId)}`),
  createVideo: async (input: { title: string; productName: string; file: File; language: string }) => {
    const id = `video-${Date.now().toString(36)}`;
    const query = new URLSearchParams({ id, title: input.title, product: input.productName, language: input.language, name: input.file.name });
    const response = await fetch(`/api/projects/new?${query}`, { method: "POST", body: input.file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? response.statusText);
    return data as { id: string; job: string };
  },
  project: (id: string) => call<Project>("GET", p(id)),
  savePlan: (id: string, plan: RawPlan, revision: number, note?: string) =>
    call<{ plan: RawPlan; revision: number; warnings: LayoutWarning[] }>("PUT", `${p(id)}/edit-plan`, { plan, note }, { "if-match": String(revision) }),
  review: (id: string, round: string) => call<Review>("GET", `${p(id)}/review/${round}`),
  saveReview: (id: string, review: Review) => call<Review>("PUT", `${p(id)}/review/${review.round}`, review),
  submitReview: (id: string, round: string) => call<Review>("POST", `${p(id)}/review/${round}/submit`),
  reviewHistory: (id: string) => call<Review[]>("GET", `${p(id)}/review-history`),
  exportSettings: (id: string) => call<ExportSettings>("GET", `${p(id)}/export-settings`),
  exports: (id: string) => call<ExportRecord[]>("GET", `${p(id)}/exports`),
  exportUrl: (id: string, exportId: string, kind: "video" | "thumbnail" | "download") => `${p(id)}/exports/${encodeURIComponent(exportId)}/${kind}`,
  revealExport: (id: string, exportId: string) => call<{ ok: boolean; path: string }>("POST", `${p(id)}/exports/${encodeURIComponent(exportId)}/reveal`),
  accept: (id: string, pid: string) => call<{ revision: number }>("POST", `${p(id)}/proposals/${pid}/accept`),
  reject: (id: string, pid: string, text: string) => call<Proposal>("POST", `${p(id)}/proposals/${pid}/reject`, { text }),
  versions: (id: string) => call<Version[]>("GET", `${p(id)}/versions`),
  restore: (id: string, revision: number, current: number) => call<{ revision: number }>("POST", `${p(id)}/versions/${revision}/restore`, undefined, { "if-match": String(current) }),
  saveFaceOverrides: (id: string, segments: FaceOverrides["segments"]) => call<FaceOverrides>("PUT", `${p(id)}/faces/overrides`, { segments }),
  jobs: (id: string) => call<Job[]>("GET", `${p(id)}/jobs`),
  startJob: (id: string, type: string, params: Record<string, unknown> = {}) => call<Job>("POST", `${p(id)}/jobs`, { type, params }),
  waveform: (id: string) => call<{ fps: number; peaks: number[] }>("GET", `${p(id)}/waveform`),
  thumbUrl: (id: string, segment: string) => `${p(id)}/thumbs/${encodeURIComponent(segment)}`,
  projectFileUrl: (id: string, file: string) => `${p(id)}/files/${file.split("/").map(encodeURIComponent).join("/")}`,
};

export function listen(onEvent: (type: string, data: unknown) => void) {
  const source = new EventSource("/api/events");
  for (const type of ["file", "job", "server"]) source.addEventListener(type, (event) => onEvent(type, JSON.parse((event as MessageEvent).data)));
  return () => source.close();
}

// ---- asset catalog (素材分类) ----
export type CatalogCategory = { id: string; label: string; hint: string };
export type CatalogDraft = { category?: string; description?: string; tags?: string[]; provider?: string; model?: string | null; at?: string; note?: string; editedAt?: string };
export type CatalogItem = {
  id: string; type: "video" | "image" | "text"; title: string; body?: string; file?: string; durationMs: number | null; facts: string[];
  defaultCategory: string; ai: CatalogDraft | null; human: CatalogDraft | null; confirmed: boolean; confirmedAt: string | null;
  category: string; description: string; tags: string[]; descriptionSource: "human" | "ai" | "transcript" | "none"; counted: boolean;
  textCheck: { wordCountFrom: number; wordCountTo: number; changes: { index: number; from: string; to: string; similarity: number; big: boolean }[] } | null;
  context: { assetId?: string };
};
export type Catalog = { id: string; order: string; categories: CatalogCategory[]; provider: { name: string; available: string[]; note: string; model?: string | null; baseUrl?: string | null }; items: CatalogItem[]; reference?: { name: string; text: string }[] };
const cat = (id: string) => `/api/catalogs/${encodeURIComponent(id)}`;
export const catalogApi = {
  list: () => call<{ id: string; order: string; total: number; confirmed: number }[]>("GET", "/api/catalogs"),
  get: (id: string) => call<Catalog>("GET", cat(id)),
  save: (id: string, item: string, body: { category?: string | null; description?: string | null; tags?: string[] | null; note?: string | null; confirmed?: boolean }) => call<CatalogItem>("PUT", `${cat(id)}/items/${encodeURIComponent(item)}`, body),
  confirm: (id: string, item: string, confirmed: boolean) => call<CatalogItem>("POST", `${cat(id)}/items/${encodeURIComponent(item)}/confirm`, { confirmed }),
  confirmMany: (id: string, items: string[], confirmed: boolean) => call<{ changed: number; catalog: Catalog }>("POST", `${cat(id)}/confirm-many`, { items, confirmed }),
  describe: (id: string, items?: string[], force = false) => call<{ described: number; skipped: number; errors: Record<string, string>; catalog: Catalog }>("POST", `${cat(id)}/describe`, { items, force }),
  mediaUrl: (id: string, item: string) => `${cat(id)}/media/${encodeURIComponent(item)}`,
  frameAtUrl: (id: string, item: string, ms: number) => `${cat(id)}/frame-at/${encodeURIComponent(item)}/${Math.round(ms)}`,
  frameUrl: (id: string, item: string, n: number) => `${cat(id)}/frames/${encodeURIComponent(item)}/${n}`,
};

// ---- API settings ----
export type ApiSettings = { baseUrl: string; model: string; format: "anthropic" | "openai"; maxTokens: number; timeoutSec: number; hasKey: boolean; keyHint: string; file: string;
  defaults: { baseUrl: string; model: string; format: "anthropic" | "openai"; maxTokens: number; timeoutSec: number } };
export const settingsApi = {
  get: () => call<ApiSettings>("GET", "/api/settings/api"),
  save: (body: Partial<Omit<ApiSettings, "hasKey" | "keyHint" | "file" | "defaults">> & { apiKey?: string }) => call<ApiSettings>("PUT", "/api/settings/api", body),
  test: () => call<{ ok: boolean; ms?: number; model?: string; reply?: string; error?: string }>("POST", "/api/settings/api/test"),
};

export type DirectorShot = { asset: string; frame: number; atMs: number; durationMs: number; layout: "full" | "pip"; slot: string | null; note: string };
export type DirectorDraft = { variant: string; label: string; blurb: string; direction?: { followsStyleCard?: boolean } | null; stale: boolean; builtAt: string; model: string | null; notes: string; liveRevision: number | null; logo: boolean; totalMs: number;
  stats: { shots: number; full: number; pip: number; fullShare: number }; beats: { id: string; text: string; ms: number; broll: DirectorShot[]; logoAtMs: number | null }[] };
export type DirectorRun = { card?: { id: string; name: string } | null; state: "idle" | "running" | "done" | "failed"; kind?: string; startedAt?: string; finishedAt?: string | null; steps?: { name: string; key?: string; state: "pending" | "running" | "done" | "failed" }[]; error?: string | null; note?: string | null; applied?: { revision: number; variant?: string; at: string } | null; drafts?: DirectorDraft[]; pipAvailable?: boolean };
export const directorApi = {
  status: (id: string) => call<DirectorRun>("GET", `${cat(id)}/director`),
  start: (id: string, card?: string) => call<DirectorRun>("POST", `${cat(id)}/director`, card ? { card } : {}),
  apply: (id: string, variant: string, expectedRevision: number | null) => call<{ revision: number; warnings: number }>("POST", `${cat(id)}/director/apply`, expectedRevision === null ? { variant } : { variant, expectedRevision }),
  options: (id: string, variant: string, body: { logo?: boolean; layout?: "full" | "pip" }) => call<DirectorRun>("POST", `${cat(id)}/director/${variant}/options`, body),
  logUrl: (id: string) => `${cat(id)}/director/log`,
};

// ---- 导入订单素材 ----
export type ImportRun = { state: "idle" | "running" | "done" | "failed"; id?: string; folder?: string; steps?: { name: string; state: "pending" | "running" | "done" | "failed" }[]; error?: string | null; note?: string | null };
export const orderApi = {
  import: (folder: string) => call<ImportRun & { id: string }>("POST", "/api/orders/import", { folder }),
  status: (id: string) => call<ImportRun>("GET", `/api/orders/${encodeURIComponent(id)}/import`),
};

// ---- 剪映草稿 ----
export type CapcutDraft = { name: string; path: string; builtAt: string; planRevision: number | null; tracks: { name: string; kind: string; segments: number }[]; skipped: string[]; durationUs: number | null; installed: boolean };
export type CapcutStatus = { pythonReady: boolean; jianyingRoot: string | null; jianyingRunning: boolean; planRevision: number | null; drafts: CapcutDraft[] };
export const capcutApi = {
  status: (id: string) => call<CapcutStatus>("GET", `${p(id)}/capcut`),
  build: (id: string, name?: string) => call<CapcutStatus>("POST", `${p(id)}/capcut`, { name }),
  install: (id: string, name: string) => call<CapcutStatus>("POST", `${p(id)}/capcut/install`, { name }),
  buildVariants: (id: string, variants: string[], install: boolean) => call<{ results: { variant: string; label: string; name: string; built: boolean; installed: boolean; error: string | null }[]; status: CapcutStatus }>("POST", `${p(id)}/capcut/variants`, { variants, install }),
  reveal: (id: string, name: string) => call<{ ok: boolean; path: string }>("POST", `${p(id)}/capcut/reveal`, { name }),
};

// ---- 风格库 (style cards) ----
export type StyleRole = "hook" | "pain" | "demo" | "proof" | "benefit" | "cta" | "other";
export type StyleCard = {
  id: string; name: string; status: "draft" | "confirmed"; summary: string; model: string | null; createdAt: string; confirmedAt: string | null;
  source: { referenceId: string; title: string; durationMs: number; shots: number };
  structure: { role: StyleRole; label: string; fromMs: number; toMs: number; what: string }[];
  rhythm: { avgCutMs: number; removePauses: boolean; maxPauseMs: number; note: string };
  camera: { zoomOnKeywords: boolean; zoomRange: [number, number]; alternateFraming: boolean; note: string };
  captions: { position: string; yRatio: number; look: string; highlight: string; animation: string; wordsPerChunk: [number, number]; upper: boolean; emoji: boolean; note: string };
  inserts: { layout: "full" | "pip" | "mixed"; firstAtMs: number; shotMs: [number, number]; share: number; triggers: string; logoPersistent: boolean; ending: "fullscreen" | "end-card" | "none"; note: string };
  packaging: { stickers: string; sfx: string; music: string; duckDb: number; note: string };
  support: { area: string; feature: string; level: "supported" | "partial" | "needs-effect"; note: string }[];
  directorRules: string[];
};
export type RoleV2 = "hook" | "problem" | "product_intro" | "demo" | "benefit" | "proof" | "cta";
export type StyleCardV2 = {
  schemaVersion: 2; id: string; name: string; status: "draft" | "confirmed"; summary_zh: string; model: string | null; createdAt: string; confirmedAt: string | null;
  source: { referenceId: string; path: string; title: string; durationMs: number; sha256: string };
  meta: { productType: "app" | "physical"; format: string; language: string; tags_zh: string[] };
  measured: { cutCount: number; avgShotMs: number; medianShotMs: number; maxStaticMs: number; firstBrollMs: number; brollRatio: number; fullRatio: number; pipRatio: number; zoomChangesPerTalkBeat: number };
  direction: { hookTreatment: string; structureEmphasis: string; pacing: string; brollPlacement: string; layoutBias: string; zoomPattern: string; brollRatioTarget: number };
  presetOverrides: { noFullBrollBeforeMs: number; noPipBeforeMs: number; minShotMs: number; maxShotMs: number; maxBrollRatio: number; maxStaticMs: number };
  structure: { role: RoleV2; startMs: number; endMs: number; technique_zh: string }[];
  timeline: { startMs: number; endMs: number; role: RoleV2; visual: "talk" | "broll"; layout?: "full" | "pip"; zoom?: string; assetType?: string; emphasisWords: string[]; what_zh: string }[];
  techniques: { name_zh: string; effectId: string | null; support: "ready" | "partial" | "unsupported"; evidenceMs: number[] }[];
  directorRules: string[]; contentSpecific_zh: string; packaging_zh: string; productTerms: string[];
  captions: { position: string; case: string; wordsPerBlock: number; emphasis: string };
  selfTest: { at: string; brollRatioRef: number; brollRatioPlan: number; zoomSame: number; brollOverlap: number; note: string } | null;
};
export type StyleBrief = { id: string; version?: 1 | 2; name: string; status: "draft" | "confirmed"; summary: string; source: { referenceId: string; title: string; durationMs: number; shots: number }; layout: string; share: number; confirmedAt: string | null; createdAt: string;
  meta?: StyleCardV2["meta"]; pacing?: string; hookTreatment?: string; selfTest?: { brollOverlap: number; zoomSame: number } | null; unsupported?: number };
export type StyleRun = { id: string; state: "running" | "failed" | "done"; title: string; steps: { name: string; state: "pending" | "running" | "done" | "failed" }[]; error: string | null };
export type StyleDetail = { card: StyleCard | StyleCardV2; insights?: { usedBy: string[] } | null; analysis: { facts: { width: number; height: number; durationMs: number }; pacing: { shotCount: number; avgShotMs: number; minShotMs: number; maxShotMs: number }; cuts: number[]; text: string; frames: number[] } | null };
const sc = (id: string) => `/api/style-cards/${encodeURIComponent(id)}`;
export const styleApi = {
  list: () => call<{ cards: StyleBrief[]; runs: StyleRun[] }>("GET", "/api/style-cards"),
  get: (id: string) => call<StyleDetail>("GET", sc(id)),
  save: (id: string, body: Partial<StyleCard> | Partial<StyleCardV2>) => call<StyleCard & StyleCardV2>("PUT", sc(id), body),
  // XHR so the page can show upload progress; the file is kept on this computer for analysis only
  upload: (file: File, onProgress: (done: number) => void) => new Promise<{ file: string; name: string; bytes: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/style-cards/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => { const data = JSON.parse(xhr.responseText || "{}"); if (xhr.status < 300) resolve(data); else reject(new ApiError(xhr.status, data.error ?? xhr.statusText)); };
    xhr.onerror = () => reject(new ApiError(0, "上传中断了，请检查 npm run desk 是否还在运行"));
    xhr.send(file);
  }),
  insights: () => call<{ segments?: { total: number; reference: number; human_edited: number; ai_accepted: number }; toBuild: { key: string; name: string; effectId: string | null; support: string; cards: string[]; count: number }[]; usedBy: Record<string, string[]> }>("GET", "/api/style-cards/insights"),
  selftest: (id: string) => call<StyleDetail>("POST", `${sc(id)}/selftest`),
  confirm: (id: string, name: string) => call<StyleCard>("POST", `${sc(id)}/confirm`, { name }),
  remove: (id: string) => call<{ deleted: boolean }>("DELETE", sc(id)),
  import: (file: string, title: string) => call<{ id: string }>("POST", "/api/style-cards/import", { file, title }),
  dismissRun: (refId: string) => call<{ dismissed: boolean }>("DELETE", `/api/style-cards/references/${encodeURIComponent(refId)}/run`),
  relearn: (refId: string) => call<{ id: string }>("POST", `/api/style-cards/references/${encodeURIComponent(refId)}/relearn`),
  frameUrl: (refId: string, second: number) => `/api/style-cards/references/${encodeURIComponent(refId)}/frames/t${String(Math.max(0, second)).padStart(3, "0")}.jpg`,
};

// ---- 口播清理 ----
export type CleanupEdit = { id: string; type: "pause" | "filler" | "stutter" | "retake" | "slip"; fromMs: number; toMs: number; reason: string; source: "auto" | "model" | "user"; decision: "delete" | "keep"; part?: "head" | "tail"; wordFrom?: number; wordTo?: number };
export type CleanupClip = { name: string; durationMs: number; segments: { id: string; startMs: number; endMs: number }[]; edits: CleanupEdit[]; words: { i: number; text: string; startMs: number; endMs: number }[] };
export type Cleanup = { exists: boolean; confirmedAt?: string | null; createdAt?: string; model?: string | null; stats?: { beforeMs: number; afterMs: number; cuts: number }; clips?: Record<string, CleanupClip>; busy?: boolean };
const pc = (id: string) => `/api/projects/${encodeURIComponent(id)}/cleanup`;
export const cleanupApi = {
  get: (id: string) => call<Cleanup>("GET", pc(id)),
  detect: (id: string, review = false) => call<Cleanup>("POST", `${pc(id)}/detect`, { review }),
  decide: (id: string, clip: string, edit: string, decision: "delete" | "keep") => call<Cleanup>("PUT", `${pc(id)}/edits/${encodeURIComponent(clip)}/${encodeURIComponent(edit)}`, { decision }),
  word: (id: string, clip: string, word: number, cut: boolean) => call<Cleanup>("PUT", `${pc(id)}/words/${encodeURIComponent(clip)}/${word}`, { cut }),
  confirm: (id: string) => call<Cleanup>("POST", `${pc(id)}/confirm`),
};

// ---- 表格方案 ----
export type TableShot = { id?: string; asset: string; srcStartMs: number; atMs: number; durationMs: number; layout: "full" | "pip"; slot: string | null; note?: string };
export type TableRow = { voice: { asset: string; atMs: number }; id: string; text: string; startMs: number; lengthMs: number; words: string[]; emphasis: string[]; broll: TableShot[]; zoom: number | null; logoAtMs: number | null };
export type TableAsset = { id: string; title: string; description: string; durationMs: number; width?: number; height?: number; category: string };
export type PlanTableData = { variant: string; label: string; blurb?: string | null; zoomOptions?: { id: string; scale: number }[]; totalMs: number; logo: boolean; rows: TableRow[]; assets: TableAsset[]; builtAt: string };
export const tableApi = {
  get: (id: string, variant: string) => call<PlanTableData>("GET", `${cat(id)}/director/${variant}/table`),
  save: (id: string, variant: string, body: { rows?: Partial<TableRow>[]; logo?: boolean }) => call<{ table: PlanTableData; status: DirectorRun }>("PUT", `${cat(id)}/director/${variant}/table`, body),
};

// ---- 素材箱：按分类拖入素材 ----
export type InboxFile = { rel: string; name: string; bytes: number };
export type InboxCategory = { id: "talk" | "action" | "screen" | "script" | "official"; label: string; hint: string; files: InboxFile[] };
export type Inbox = { order: string; creator: string; categories: InboxCategory[] };
export const inboxApi = {
  list: () => call<{ order: string; files: number }[]>("GET", "/api/inbox"),
  create: (product: string) => call<Inbox>("POST", "/api/inbox/new", { product }),
  get: (order: string) => call<Inbox>("GET", `/api/inbox/${encodeURIComponent(order)}`),
  remove: (order: string, rel: string) => call<Inbox>("DELETE", `/api/inbox/${encodeURIComponent(order)}/files?rel=${encodeURIComponent(rel)}`),
  import: (order: string) => call<ImportRun & { id: string }>("POST", `/api/inbox/${encodeURIComponent(order)}/import`, {}),
  // XHR rather than fetch so the page can show upload progress for big videos.
  upload: (order: string, category: string, file: File, creator: string, onProgress: (done: number) => void) => new Promise<Inbox>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/inbox/${encodeURIComponent(order)}/files?category=${category}&name=${encodeURIComponent(file.name)}&creator=${encodeURIComponent(creator)}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => { const data = JSON.parse(xhr.responseText || "{}"); if (xhr.status < 300) resolve(data); else reject(new ApiError(xhr.status, data.error ?? xhr.statusText)); };
    xhr.onerror = () => reject(new ApiError(0, "上传中断了，请检查 npm run desk 是否还在运行"));
    xhr.send(file);
  }),
};

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

export type Overview = { mode?: "mix"; editorReady?: boolean; mixEditorConfirmed?: boolean; style?: string; id: string; title: string; productName: string; status: Status; hasPlan: boolean; hasProject: boolean; transcriptReady: boolean; previewReady: boolean; ready: boolean; revision: number | null; updatedAt: string | null; media: { originalName: string; bytes: number; durationMs: number; width: number; height: number } | null };
export type MixAsset = { id: string; group: "wrong" | "detail" | "general"; name: string; durationMs: number; width: number; height: number };
export type MixSlot = { id: string; label: string; group: "wrong" | "detail"; durationMs: number };
export type MixLibrary = { voiceOptions: string[]; actorOptions: string[]; voice: { name: string; durationMs: number; captionsReady: boolean }; actor: { name: string; durationMs: number; transparent: boolean; keyMode?: "green" | "black" | "alpha" | "none" }; assets: MixAsset[]; slots: MixSlot[] };
export type MixVariant = { id: string; name: string; createdAt: string; selections: { slot: string; asset: string }[]; revision: number; preview?: string | null; approvedRevision?: number | null; lockedSlots?: string[]; exports?: { file: string; revision: number; createdAt: string; width: number; height: number; duration: number }[] };
export type MixJob = { id: string; variantId: string; state: "queued" | "running" | "completed" | "failed"; quality?: "preview" | "hd"; phase: string; message: string; preview: string | null; error: string | null };
export const createMixApi = (projectId?: string) => { const base = projectId ? `/api/projects/${projectId}/mix` : "/api/mix"; return {
  library: () => call<MixLibrary>("GET", `${base}/library`),
  variants: () => call<MixVariant[]>("GET", `${base}/variants`),
  create: (count = 3) => call<MixVariant[]>("POST", `${base}/variants`, { count }),
  save: (variant: MixVariant) => call<MixVariant>("PUT", `${base}/variants/${variant.id}`, { name: variant.name, selections: variant.selections, lockedSlots: variant.lockedSlots, revision: variant.revision }),
  render: (id: string, quality: "preview" | "hd" = "preview") => call<MixJob>("POST", `${base}/variants/${id}/render`, { quality }),
  refreshPresenter: () => call<{mode: string; changed: boolean}>("POST", `${base}/presenter-refresh`),
  next: () => call<MixVariant>("POST", `${base}/next`),
  editor: (variant: string) => call<{round: string}>("POST", `${base}/editor`, { variant }),
  approve: (id: string) => call<MixVariant>("POST", `${base}/variants/${id}/approve`),
  unapprove: (id: string) => call<MixVariant>("POST", `${base}/variants/${id}/unapprove`),
  source: (actorName: string) => call("PUT", `${base}/sources`, { actorName }),
  stage: (stage: string) => call<Status>("POST", `${base}/stage`, { stage }),
  jobs: () => call<MixJob[]>("GET", `${base}/jobs`),
  thumb: (id: string) => `${base}/thumbs/${id}`,
  preview: (name: string) => `${base}/previews/${name}`,
}; };
export const mixApi = createMixApi();
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
  inspectMixFolder: (folder: string) => call<MixLibrary>("POST", "/api/mix-projects/inspect", { folder }),
  createMixProject: (input: { title: string; productName: string; folder: string; voiceName?: string; actorName?: string }) => call<{id: string}>("POST", "/api/mix-projects", input),
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

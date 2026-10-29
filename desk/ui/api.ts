// Everything the page knows comes through these calls (rule 1: UI only via API).
import type { FaceAnalysis, FaceOverrides, LayoutWarning, Rect, SafeZones } from "../../src/engine/layout.ts";
import type { PatchOperation } from "../../scripts/lib/json-patch.mjs";

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
export type Review = { round: string; editPlanRevision: number; segments: { segment: string; decision: Decision; comments: Comment[] }[]; comments: Comment[]; submittedAt: string | null };

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

export type Job = { id: string; project: string; type: string; state: "queued" | "running" | "done" | "failed"; createdAt: string; startedAt: string | null; finishedAt: string | null; output?: string; error?: string; params: Record<string, unknown> };
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

export const api = {
  projects: () => call<{ id: string; revision: number; stage: string; title: string }[]>("GET", "/api/projects"),
  project: (id: string) => call<Project>("GET", p(id)),
  savePlan: (id: string, plan: RawPlan, revision: number, note?: string) =>
    call<{ plan: RawPlan; revision: number; warnings: LayoutWarning[] }>("PUT", `${p(id)}/edit-plan`, { plan, note }, { "if-match": String(revision) }),
  review: (id: string, round: string) => call<Review>("GET", `${p(id)}/review/${round}`),
  saveReview: (id: string, review: Review) => call<Review>("PUT", `${p(id)}/review/${review.round}`, review),
  submitReview: (id: string, round: string) => call<Review>("POST", `${p(id)}/review/${round}/submit`),
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

// Project state: status, edit-plan with revisions and history, review rounds,
// proposals. All file access goes through scripts/lib/storage.mjs.
import { stat } from "node:fs/promises";
import { z } from "zod";
import { validatePlan } from "../../scripts/edit-plan.mjs";
import { applyPatch, describePatch, PatchError } from "../../scripts/lib/json-patch.mjs";
import { loadLayoutContext } from "../../scripts/lib/layout-context.mjs";
import { probe, sha256File } from "../../scripts/lib/media.mjs";
import { listJson, projectDir, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { checkLayout } from "../../src/engine/layout.ts";
import { PlanError } from "../../src/engine/load.ts";
import { conflict, HttpError, unprocessable } from "./errors.mjs";

const STAGES = ["asset-prep", "storyboard", "timeline-review", "render-qc"];

// --- One writer at a time per project.
const locks = new Map();
export const withLock = (id, task) => {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(id, next.catch(() => {}));
  return next;
};

// --- Validation with cached hashes/probes (keyed by path, size, mtime), so a
// save does not re-hash a 40 MB original every time.
const cache = new Map();
const cached = (kind, fn) => async (file) => {
  const info = await stat(file);
  const key = `${kind}:${file}:${info.size}:${info.mtimeMs}`;
  if (!cache.has(key)) cache.set(key, await fn(file));
  return cache.get(key);
};
const validationOptions = { hashFile: cached("sha", sha256File), probeFile: cached("probe", probe) };

export async function validate(id, raw) {
  try {
    const { plan, resolved } = await validatePlan(raw, validationOptions);
    const warnings = checkLayout(resolved, await loadLayoutContext(projectDir(id), plan));
    return { plan, resolved, warnings };
  } catch (error) {
    if (error instanceof PlanError) throw unprocessable("edit-plan is invalid", { problems: error.problems });
    throw error;
  }
}

// --- Status.
const now = () => new Date().toISOString();

export async function readStatus(id) {
  const plan = await readJson(projectFile(id, "edit-plan.json"), null);
  // Projects that started before the desk have an edit-plan and no status;
  // new projects start at asset preparation.
  const fallback = plan
    ? {
        stage: "timeline-review",
        stages: {
          "asset-prep": { state: "done", note: "existing project, assets prepared before the desk existed" },
          storyboard: { state: "done", note: "existing project, no storyboard round" },
          "timeline-review": { state: "waiting-user", round: "r1", openProposals: 0 },
          "render-qc": { state: "pending" },
        },
      }
    : {
        stage: "asset-prep",
        stages: {
          "asset-prep": { state: "waiting-user" },
          storyboard: { state: "pending", round: "r1" },
          "timeline-review": { state: "pending", round: "r1", openProposals: 0 },
          "render-qc": { state: "pending" },
        },
      };
  return readJson(projectFile(id, "status.json"), { project: id, ...fallback, editPlanRevision: plan ? (plan.revision ?? 0) : null, updatedAt: now(), updatedBy: "user" });
}

export async function updateStatus(id, change) {
  const status = await readStatus(id);
  change(status);
  status.updatedAt = now();
  await writeJson(projectFile(id, "status.json"), status);
  return status;
}

const statusSchema = z.object({
  stage: z.enum([...STAGES, "delivered"]),
  stages: z.record(z.enum(STAGES), z.object({ state: z.enum(["pending", "in-progress", "waiting-user", "done", "blocked"]) }).loose()),
}).loose();

export async function setStage(id, body) {
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) throw unprocessable("status is invalid", { problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  return withLock(id, () => updateStatus(id, (status) => Object.assign(status, parsed.data, { updatedBy: "user" })));
}

// --- Edit-plan and history.
const versionFile = (id, revision) => projectFile(id, "versions", `edit-plan.r${String(revision).padStart(4, "0")}.json`);
const versionLog = (id) => projectFile(id, "versions/log.json");

export async function readPlan(id) {
  const plan = await readJson(projectFile(id, "edit-plan.json"));
  return { plan, revision: plan.revision ?? 0 };
}

// The edit-plan compiled from a confirmed storyboard option. A project's first
// edit-plan is revision 0; later confirmations go through commitPlan so the
// earlier plan stays in versions/. Call inside withLock.
export async function installCompiledPlan(id, compiled, note) {
  const existing = await readJson(projectFile(id, "edit-plan.json"), null);
  if (existing) return commitPlan(id, compiled, { expectedRevision: existing.revision ?? 0, by: "user", note });
  const plan = { schemaVersion: compiled.schemaVersion, id: compiled.id, revision: 0, ...compiled };
  const { warnings } = await validate(id, plan);
  await writeJson(projectFile(id, "edit-plan.json"), plan);
  await writeJson(versionFile(id, 0), plan);
  await writeJson(versionLog(id), [{ revision: 0, savedAt: now(), by: "user", note }]);
  return { plan, revision: 0, warnings };
}

// The only way the edit-plan changes. Keeps the previous revision in versions/,
// bumps the revision, marks proposals based on older revisions stale.
async function commitPlan(id, nextRaw, { expectedRevision, by, note }) {
  const { plan: current, revision } = await readPlan(id);
  if (expectedRevision !== revision) {
    throw conflict(`edit-plan is at revision ${revision}, not ${expectedRevision}. Reload and reapply your change.`, { revision });
  }
  const next = { ...nextRaw, revision: revision + 1 };
  // Keep "revision" next to "id" so diffs stay readable.
  const ordered = { schemaVersion: next.schemaVersion, id: next.id, revision: next.revision, ...next };
  const { warnings } = await validate(id, ordered);
  const log = await readJson(versionLog(id), []);
  if (!log.some((entry) => entry.revision === revision)) {
    log.push({ revision, savedAt: now(), by: "unknown", note: "state before the review desk first changed it" });
  }
  await writeJson(versionFile(id, revision), current);
  await writeJson(projectFile(id, "edit-plan.json"), ordered);
  await writeJson(versionFile(id, revision + 1), ordered);
  log.push({ revision: revision + 1, savedAt: now(), by, note });
  await writeJson(versionLog(id), log);
  await markStale(id, revision + 1);
  await updateStatus(id, (status) => {
    status.editPlanRevision = revision + 1;
    status.updatedBy = by;
  });
  return { plan: ordered, revision: revision + 1, warnings };
}

export function savePlan(id, raw, { expectedRevision, note }) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw unprocessable("body must be an edit-plan object");
  return withLock(id, () => commitPlan(id, raw, { expectedRevision, by: "user", note: note || "edited in the review desk" }));
}

export async function listVersions(id) {
  return (await readJson(versionLog(id), [])).slice().reverse();
}

export async function readVersion(id, revision) {
  return readJson(versionFile(id, Number(revision)));
}

export function restoreVersion(id, revision, { expectedRevision }) {
  return withLock(id, async () => {
    const old = await readJson(versionFile(id, Number(revision)));
    return commitPlan(id, old, { expectedRevision, by: "user", note: `restored revision ${revision}` });
  });
}

// --- Review rounds.
const ROUND = /^r[1-9]\d*$/;
const comment = z.object({
  id: z.string().regex(/^c-\d{4,}$/),
  text: z.string().min(1),
  at: z.object({ frame: z.number().int().nonnegative() }).optional(),
  proposal: z.string().optional(),
  createdAt: z.string(),
  by: z.enum(["user", "claude"]).default("user"),
});
const reviewSchema = z.object({
  round: z.string().regex(ROUND),
  editPlanRevision: z.number().int().nonnegative(),
  segments: z.array(z.object({ segment: z.string(), decision: z.enum(["keep", "drop", "modify", "undecided"]), comments: z.array(comment).default([]) })),
  comments: z.array(comment).default([]),
  submittedAt: z.string().nullable().default(null),
});

const reviewFile = (id, round) => {
  if (!ROUND.test(round)) throw new HttpError(404, `Unknown review round "${round}"`);
  return projectFile(id, "review", `${round}.json`);
};

export async function readReview(id, round) {
  const { plan, revision } = await readPlan(id);
  const stored = await readJson(reviewFile(id, round), null);
  const review = stored ?? { round, editPlanRevision: revision, segments: [], comments: [], submittedAt: null };
  // Every current segment appears once, in plan order.
  const known = new Map(review.segments.map((entry) => [entry.segment, entry]));
  review.segments = plan.segments.map((segment) => known.get(segment.id) ?? { segment: segment.id, decision: "undecided", comments: [] });
  return review;
}

export function saveReview(id, round, body) {
  const parsed = reviewSchema.safeParse({ ...body, round });
  if (!parsed.success) throw unprocessable("review is invalid", { problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  return withLock(id, async () => {
    const review = { ...parsed.data, updatedAt: now(), updatedBy: "user" };
    await writeJson(reviewFile(id, round), review);
    return review;
  });
}

export function submitReview(id, round) {
  return withLock(id, async () => {
    const review = await readReview(id, round);
    review.submittedAt = now();
    review.updatedAt = review.submittedAt;
    await writeJson(reviewFile(id, round), review);
    await updateStatus(id, (status) => {
      status.stages["timeline-review"] = { ...status.stages["timeline-review"], state: "in-progress", round, note: "comments submitted; waiting for Claude's proposals" };
      status.updatedBy = "user";
    });
    return review;
  });
}

const nextCommentId = (review) => {
  const all = [...review.comments, ...review.segments.flatMap((entry) => entry.comments)];
  const max = all.reduce((highest, item) => Math.max(highest, Number(item.id.slice(2)) || 0), 0);
  return `c-${String(max + 1).padStart(4, "0")}`;
};

// --- Proposals.
const PROPOSAL = /^p-\d{4,}$/;
const proposalFile = (id, pid) => {
  if (!PROPOSAL.test(pid)) throw new HttpError(404, `Unknown proposal "${pid}"`);
  return projectFile(id, "proposals", `${pid}.json`);
};

async function markStale(id, revision) {
  for (const name of await listJson(projectFile(id, "proposals"))) {
    const file = projectFile(id, "proposals", name);
    const proposal = await readJson(file);
    if (proposal.state === "pending" && proposal.basedOnRevision !== revision) {
      proposal.state = "stale";
      proposal.staleReason = `edit-plan moved to revision ${revision} after this proposal was based on ${proposal.basedOnRevision}`;
      proposal.decidedAt = now();
      await writeJson(file, proposal);
    }
  }
}

export async function listProposals(id) {
  const { plan, revision } = await readPlan(id);
  const proposals = [];
  for (const name of await listJson(projectFile(id, "proposals"))) {
    const proposal = await readJson(projectFile(id, "proposals", name));
    // Written by Claude directly: catch an outdated base before showing it.
    if (proposal.state === "pending" && proposal.basedOnRevision !== revision) {
      await withLock(id, () => markStale(id, revision));
      proposal.state = "stale";
    }
    let changes = proposal.changes;
    let problem = null;
    try {
      changes = describePatch(plan, proposal.changes ?? []);
      if (proposal.state === "pending") applyPatch(plan, proposal.changes);
    } catch (error) {
      problem = error.message;
    }
    proposals.push({ ...proposal, changes, problem });
  }
  return proposals.sort((a, b) => b.id.localeCompare(a.id));
}

export function acceptProposal(id, pid) {
  return withLock(id, async () => {
    const file = proposalFile(id, pid);
    const proposal = await readJson(file);
    if (proposal.state !== "pending") throw conflict(`${pid} is ${proposal.state}; only pending proposals can be accepted`);
    const { plan, revision } = await readPlan(id);
    if (proposal.basedOnRevision !== revision) {
      await markStale(id, revision);
      throw conflict(`${pid} was based on revision ${proposal.basedOnRevision}, the edit-plan is now at ${revision}. Ask Claude to redo it.`);
    }
    let patched;
    try {
      patched = applyPatch(plan, proposal.changes);
    } catch (error) {
      if (error instanceof PatchError) throw unprocessable(`${pid} cannot be applied`, { problems: [error.message] });
      throw error;
    }
    // Validation failure leaves both the plan and the proposal untouched.
    const result = await commitPlan(id, patched, { expectedRevision: revision, by: "user", note: `accepted ${pid}: ${proposal.summary ?? ""}`.trim() });
    proposal.state = "accepted";
    proposal.appliedRevision = result.revision;
    proposal.decidedAt = now();
    await writeJson(file, proposal);
    return { proposal, ...result };
  });
}

export function rejectProposal(id, pid, { text }) {
  return withLock(id, async () => {
    const file = proposalFile(id, pid);
    const proposal = await readJson(file);
    if (proposal.state !== "pending" && proposal.state !== "stale") throw conflict(`${pid} is ${proposal.state}`);
    proposal.state = "rejected";
    proposal.decidedAt = now();
    if (text) proposal.rejectComment = text;
    await writeJson(file, proposal);
    if (text) {
      const status = await readStatus(id);
      const round = status.stages["timeline-review"]?.round ?? "r1";
      const review = await readReview(id, round);
      const entry = { id: nextCommentId(review), text, proposal: pid, createdAt: now(), by: "user" };
      const segment = review.segments.find((item) => item.segment === proposal.impact?.segments?.[0]);
      (segment ? segment.comments : review.comments).push(entry);
      await writeJson(reviewFile(id, round), { ...review, updatedAt: now(), updatedBy: "user" });
    }
    return proposal;
  });
}

// --- Everything the page needs on load.
export async function readProject(id) {
  const { plan, revision } = await readPlan(id);
  const status = await readStatus(id);
  const proposals = await listProposals(id);
  const open = proposals.filter((proposal) => proposal.state === "pending").length;
  status.stages["timeline-review"] = { ...status.stages["timeline-review"], openProposals: open };
  let validation;
  try {
    const { warnings } = await validate(id, plan);
    validation = { ok: true, problems: [], warnings };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    validation = { ok: false, problems: error.body.problems ?? [error.message], warnings: [] };
  }
  const context = await loadLayoutContext(projectDir(id), plan);
  const proxies = await readJson(projectFile(id, "analysis/proxies.json"), { assets: {} });
  return {
    id,
    revision,
    plan,
    status,
    assets: await readJson(projectFile(id, "assets.json"), null),
    validation,
    faces: context.faces,
    faceOverrides: context.overrides,
    safeZones: context.safeZones,
    proxies: Object.fromEntries(Object.entries(proxies.assets).map(([assetId, entry]) => [assetId, { width: entry.width, height: entry.height, createdAt: entry.createdAt }])),
    proposals,
  };
}

export function saveFaceOverrides(id, body) {
  const rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
  const parsed = z.object({ segments: z.record(z.string(), rect.nullable()) }).safeParse(body);
  if (!parsed.success) throw unprocessable("face overrides are invalid", { problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  return withLock(id, async () => {
    const overrides = { version: 1, segments: parsed.data.segments, updatedAt: now(), updatedBy: "user" };
    await writeJson(projectFile(id, "analysis/faces.overrides.json"), overrides);
    return overrides;
  });
}

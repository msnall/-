// Before the edit-plan: assets (candidates, uploads, claim verification),
// beats, storyboard rounds (options, selection, compile, confirm) and the
// technique library.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { publicDir, sha256File } from "../../scripts/lib/media.mjs";
import { exists, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { compileProjectOption, loadLibrary, loadProjectInputs, loadRound, ROUND } from "../../scripts/lib/storyboard-files.mjs";
import { assetsSchema, beatsSchema, checkBeats, selectionSchema } from "../../src/engine/storyboard.ts";
import { conflict, HttpError, unprocessable } from "./errors.mjs";
import { installCompiledPlan, readStatus, updateStatus, withLock } from "./projects.mjs";

const now = () => new Date().toISOString();
const issues = (error) => error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);

export async function readOverview(id) {
  const status = await readStatus(id);
  const plan = await readJson(projectFile(id, "edit-plan.json"), null);
  const project = await readJson(projectFile(id, "project.json"), null);
  return { id, title: project?.title ?? plan?.meta?.title ?? id, status, hasPlan: !!plan, hasProject: !!project, revision: plan ? (plan.revision ?? 0) : null };
}

// --- Assets.
const assetsFile = (id) => projectFile(id, "assets.json");

async function editAssets(id, change) {
  return withLock(id, async () => {
    const assets = assetsSchema.parse(await readJson(assetsFile(id), { version: 1, items: [], claims: [] }));
    change(assets);
    const parsed = assetsSchema.safeParse(assets);
    if (!parsed.success) throw unprocessable("assets.json would be invalid", { problems: issues(parsed.error) });
    await writeJson(assetsFile(id), parsed.data);
    return parsed.data;
  });
}

export async function readAssets(id) {
  const { assets, beats, project } = await loadProjectInputs(id);
  return { assets, beats, footage: project.footage };
}

const findItem = (assets, assetId) => {
  const item = assets.items.find((entry) => entry.id === assetId);
  if (!item) throw new HttpError(404, `No asset "${assetId}"`);
  return item;
};

export async function approveCandidate(id, assetId, { file }) {
  const sha = await sha256File(path.join(publicDir, file)).catch(() => null);
  if (!sha) throw new HttpError(404, `public/${file} does not exist`);
  return editAssets(id, (assets) => {
    const item = findItem(assets, assetId);
    const candidate = item.candidates.find((entry) => entry.file === file);
    if (!candidate) throw new HttpError(404, `${file} is not a candidate of ${assetId}`);
    Object.assign(item, { status: "available", file, sha256: sha, approvedBy: "user", source: `原片第 ${candidate.frame} 帧截取${candidate.note ? `：${candidate.note}` : ""}` });
  });
}

export async function rejectCandidate(id, assetId, { file }) {
  return editAssets(id, (assets) => {
    const item = findItem(assets, assetId);
    item.candidates = item.candidates.filter((entry) => entry.file !== file);
    if (item.status === "candidate" && !item.candidates.length) item.status = "missing";
    if (item.file === file && item.status !== "available") delete item.file;
  });
}

export async function resetAsset(id, assetId) {
  return editAssets(id, (assets) => {
    const item = findItem(assets, assetId);
    if (item.kind === "footage") throw unprocessable("footage cannot be reset here");
    item.status = item.candidates.length ? "candidate" : "missing";
    delete item.file;
    delete item.sha256;
    delete item.approvedBy;
  });
}

const UPLOAD_TYPES = { ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image", ".mp4": "video", ".mov": "video", ".wav": "audio", ".mp3": "audio" };

// Raw request body; stored under an ASCII name, original name kept in metadata.
export async function uploadAsset(id, assetId, request, originalName) {
  const extension = path.extname(originalName ?? "").toLowerCase();
  if (!UPLOAD_TYPES[extension]) throw unprocessable(`Unsupported file type "${extension}". Allowed: ${Object.keys(UPLOAD_TYPES).join(", ")}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 200 * 1024 * 1024) throw unprocessable("file too large (200 MB max)");
    chunks.push(chunk);
  }
  const dir = path.join(publicDir, "projects", id, "assets");
  await mkdir(dir, { recursive: true });
  const name = `${assetId}-upload-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}${extension === ".jpeg" ? ".jpg" : extension}`;
  const output = path.join(dir, name);
  await writeFile(output, Buffer.concat(chunks));
  const sha = await sha256File(output);
  const file = path.relative(publicDir, output).split(path.sep).join("/");
  return editAssets(id, (assets) => {
    const item = findItem(assets, assetId);
    Object.assign(item, { status: "available", file, sha256: sha, originalName, approvedBy: "user", source: `用户上传（${originalName}）` });
  });
}

const claimPatch = z.strictObject({ status: z.enum(["unverified", "verified", "rejected"]), evidence: z.string().optional(), note: z.string().optional() });
export async function updateClaim(id, claimId, body) {
  const parsed = claimPatch.safeParse(body);
  if (!parsed.success) throw unprocessable("claim update is invalid", { problems: issues(parsed.error) });
  if (parsed.data.status === "verified" && !parsed.data.evidence?.trim()) throw unprocessable("标记为已核实时必须写明依据");
  return editAssets(id, (assets) => {
    const claim = assets.claims.find((entry) => entry.id === claimId);
    if (!claim) throw new HttpError(404, `No claim "${claimId}"`);
    Object.assign(claim, parsed.data);
  });
}

export async function shotList(id) {
  const { assets } = await loadProjectInputs(id);
  return assets.items.filter((item) => item.status === "missing").map((item) => ({ id: item.id, kind: item.kind, label: item.label, neededBy: item.neededBy, shotRequest: item.shotRequest ?? null }));
}

// --- Beats.
export async function beatTimes(id) {
  const { beats, transcript } = await loadProjectInputs(id);
  if (!beats) return {};
  return Object.fromEntries(
    beats.beats.map((beat) => {
      const first = transcript.words[beat.words[0]];
      const last = transcript.words[beat.words[1]];
      return [beat.id, first && last ? Math.round((first.startMs + last.endMs) / 2) : 0];
    }),
  );
}

export async function saveBeats(id, body, { confirm = false } = {}) {
  const parsed = beatsSchema.safeParse(body);
  if (!parsed.success) throw unprocessable("beats are invalid", { problems: issues(parsed.error) });
  const { transcript } = await loadProjectInputs(id);
  const problems = checkBeats(parsed.data, transcript);
  if (problems.length) throw unprocessable("beats do not match the transcript", { problems });
  return withLock(id, async () => {
    const beats = { ...parsed.data, confirmedAt: confirm ? now() : parsed.data.confirmedAt };
    await writeJson(projectFile(id, "analysis/beats.json"), beats);
    if (confirm) {
      await updateStatus(id, (status) => {
        if (status.stage === "asset-prep") status.stage = "storyboard";
        status.stages["asset-prep"] = { ...status.stages["asset-prep"], state: "done" };
        status.stages.storyboard = { ...status.stages.storyboard, state: "waiting-user" };
      });
    }
    return beats;
  });
}

// --- Storyboard.
const roundOf = (round) => {
  if (!ROUND.test(round)) throw new HttpError(404, `Unknown round "${round}"`);
  return round;
};

export async function readRound(id, round) {
  const library = await loadLibrary();
  const { options, selection } = await loadRound(id, roundOf(round));
  const compiled = [];
  for (const option of options) {
    const result = await compileProjectOption(id, round, option.id, { library });
    compiled.push({ ...option, compile: { problems: result.problems, warnings: result.warnings, needs: result.needs, claims: result.claims, gate: result.gate, segments: result.segments } });
  }
  return { round, options: compiled, selection };
}

export async function compilePreview(id, round, optionId, body) {
  const selection = body?.selection ? selectionSchema.parse({ round, ...body.selection }) : undefined;
  return compileProjectOption(id, roundOf(round), optionId, { selection });
}

const selectionFile = (id, round) => projectFile(id, "storyboard", round, "selection.json");

export async function saveSelection(id, round, body) {
  const parsed = selectionSchema.safeParse({ ...body, round: roundOf(round), state: "draft", confirmedAt: null });
  if (!parsed.success) throw unprocessable("selection is invalid", { problems: issues(parsed.error) });
  return withLock(id, async () => {
    const current = await readJson(selectionFile(id, round), null);
    if (current?.state === "confirmed") throw conflict(`方案已在 ${current.confirmedAt} 确认，edit-plan 已生成；修改请在审阅台进行，或让 Claude 出新一轮方案`);
    const selection = { ...parsed.data, updatedAt: now() };
    await writeJson(selectionFile(id, round), selection);
    return selection;
  });
}

export async function confirmSelection(id, round) {
  roundOf(round);
  return withLock(id, async () => {
    const selection = selectionSchema.parse(await readJson(selectionFile(id, round), { round }));
    if (selection.state === "confirmed") throw conflict("已经确认过了");
    if (!selection.option) throw unprocessable("还没有选择方案");
    const result = await compileProjectOption(id, round, selection.option, { selection });
    if (!result.gate.canConfirm || !result.plan) throw conflict("方案还不能确认", { problems: [...result.problems, ...result.gate.reasons] });
    const installed = await installCompiledPlan(id, result.plan, `compiled from storyboard ${round} ${selection.option}${selection.style ? ` (style ${selection.style})` : ""}`);
    const confirmed = { ...selection, state: "confirmed", confirmedAt: now(), updatedAt: now() };
    await writeJson(selectionFile(id, round), confirmed);
    await updateStatus(id, (status) => {
      status.stage = "timeline-review";
      status.stages.storyboard = { ...status.stages.storyboard, state: "done", round, selected: selection.option };
      status.stages["timeline-review"] = { state: "waiting-user", round: "r1", openProposals: 0 };
      status.editPlanRevision = installed.revision;
      status.updatedBy = "user";
    });
    return { selection: confirmed, revision: installed.revision, warnings: installed.warnings };
  });
}

export async function readLibrary() {
  return loadLibrary();
}

export const hasProjectFile = (id) => exists(projectFile(id, "project.json"));

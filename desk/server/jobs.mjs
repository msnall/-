// Jobs: long-running work (proxies, face detection, stills, render + QC) as
// records in projects/<id>/jobs/<jobId>.json with logs in projects/<id>/logs/.
// One job runs at a time; each record keeps its state, inputs, tool versions
// and log, so a page reload (or another machine later) can see what happened.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { root, run, sha256File } from "../../scripts/lib/media.mjs";
import { exists, listJson, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { unprocessable } from "./errors.mjs";
import { emit } from "./events.mjs";
import { finishTranscription } from "./onboarding.mjs";
import { exportSettings, finalizeExport, validateFilename } from "./exports.mjs";

const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];

const frames = z.array(z.number().int().nonnegative()).min(1).max(12);
const definitions = {
  transcribe: {
    params: z.object({ force: z.boolean().default(false) }),
    commands: async (id, params) => {
      const project = await readJson(projectFile(id, "project.json"));
      const assets = await readJson(projectFile(id, "assets.json"));
      return [node("scripts/transcribe.mjs", path.join("public", assets.items.find((item) => item.id === "source").file), "--language", project.language, ...(params.force ? ["--force"] : []))];
    },
  },
  proxy: { params: z.object({ force: z.boolean().default(false), transcribeAfter: z.boolean().default(false) }), commands: async (id, params) => [node("scripts/make-proxy.mjs", id, ...(params.force ? ["--force"] : []))] },
  faces: { params: z.object({}), commands: async (id) => [node("scripts/detect-faces.mjs", id)] },
  stills: {
    params: z.object({ frames, afterFrames: frames.optional(), proposal: z.string().regex(/^p-\d{4,}$/).optional() }),
    commands: async (id, params) => [
      node("scripts/render-stills.mjs", id, `--frames=${params.frames.join(",")}`, ...(params.afterFrames ? [`--after-frames=${params.afterFrames.join(",")}`] : []), ...(params.proposal ? [`--proposal=${params.proposal}`] : [])),
    ],
  },
  keyframes: {
    params: z.object({ round: z.string().regex(/^r[1-9]\d*$/), option: z.string().regex(/^option-[a-z]$/) }),
    commands: async (id, params) => [node("scripts/render-stills.mjs", id, `--round=${params.round}`, `--option=${params.option}`)],
  },
  candidates: { params: z.object({ every: z.number().positive().default(1) }), commands: async (id, params) => [node("scripts/find-candidates.mjs", id, "--sheet", `--every=${params.every}`)] },
  // Render the current revision to out/desk/<id>/<id>-r<rev>.mp4, then QC it.
  render: {
    params: z.object({ filename: z.string().optional(), planHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
    commands: async (id, _params, record) => {
      const plan = await readJson(projectFile(id, "edit-plan.json"));
      if (await sha256File(projectFile(id, "edit-plan.json")) !== record.inputs.editPlanSha256) throw new Error("排队期间剪辑方案已变化，请重新开始导出。");
      const filename = record.params.filename ?? `${id}-r${plan.revision ?? 0}.mp4`;
      const parsed = path.parse(filename);
      let output = `out/desk/${id}/${filename}`;
      for (let attempt = 2; await exists(path.join(root, output)); attempt++) output = `out/desk/${id}/${parsed.name}-${attempt}${parsed.ext}`;
      record.output = output;
      const planPath = `projects/${id}/edit-plan.export-${record.id}.json`;
      await writeJson(path.join(root, planPath), plan);
      return [node("scripts/render-plan.mjs", planPath, output), node("scripts/verify-render.mjs", planPath, output)];
    },
  },
};
export const jobTypes = Object.keys(definitions);

const queue = [];
let running = false;
let counter = 0;
let tools = null;

const toolVersions = async () => {
  if (!tools) {
    const [{ stdout: ffmpeg }, remotion] = await Promise.all([run("ffmpeg", ["-hide_banner", "-version"]), readJson(path.join(root, "node_modules/remotion/package.json"))]);
    tools = { node: process.version, ffmpeg: ffmpeg.split("\n")[0].trim(), remotion: remotion.version };
  }
  return tools;
};

const jobFile = (record) => projectFile(record.project, "jobs", `${record.id}.json`);
const save = async (record) => {
  await writeJson(jobFile(record), record);
  emit("job", record);
};

export async function createJob(project, type, body = {}) {
  const definition = definitions[type];
  if (!definition) throw unprocessable(`Unknown job type "${type}". Known: ${jobTypes.join(", ")}`);
  const parsed = definition.params.safeParse(body);
  if (!parsed.success) throw unprocessable("job parameters are invalid", { problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  const settings = type === "render" ? await exportSettings(project) : null;
  if (settings && !settings.approved) throw unprocessable(settings.reason);
  if (settings && parsed.data.planHash && parsed.data.planHash !== settings.planHash) throw unprocessable("剪辑方案已更新，请刷新导出设置后重试。");
  if (settings) validateFilename(parsed.data.filename ?? settings.filename);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const id = `j-${stamp}-${String(++counter).padStart(3, "0")}`;
  const record = {
    id,
    project,
    type,
    params: parsed.data,
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    exitCode: null,
    log: `projects/${project}/logs/${id}.log`,
    inputs: { editPlanSha256: settings?.planHash ?? await sha256File(projectFile(project, "edit-plan.json")).catch(() => null) },
    tools: await toolVersions(),
    ...(settings ? { exportId: id.replace(/^j-/, "e-"), storyboardRound: settings.storyboardRound, editPlanRevision: settings.revision, phase: "queued" } : {}),
  };
  await save(record);
  queue.push(record);
  drain();
  return record;
}

const runCommand = ([binary, args], logStream, onOutput = () => {}) =>
  new Promise((resolve) => {
    logStream.write(`$ ${[path.basename(binary), ...args].join(" ")}\n`);
    const child = spawn(binary, args, { cwd: root, windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logStream.write(chunk); onOutput(chunk.toString()); });
    child.on("error", (error) => {
      logStream.write(`${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });

async function drain() {
  if (running) return;
  const record = queue.shift();
  if (!record) return;
  running = true;
  try {
    record.state = "running";
    record.startedAt = new Date().toISOString();
    record.attempts += 1;
    if (record.type === "render") record.phase = "preparing";
    const commands = await definitions[record.type].commands(record.project, record.params, record);
    await save(record);
    await mkdir(projectFile(record.project, "logs"), { recursive: true });
    const logStream = createWriteStream(path.join(root, record.log), { flags: "a" });
    let code = 0;
    let progressTail = "";
    let lastPercent = -1;
    let progressSave = Promise.resolve();
    for (let index = 0; index < commands.length; index++) {
      if (record.type === "render") { record.phase = index === 0 ? "rendering" : "quality-check"; await save(record); }
      code = await runCommand(commands[index], logStream, (chunk) => {
        if (record.type === "render" && chunk.includes("EXPORT_STAGE=processing") && record.phase !== "processing") {
          record.phase = "processing";
          progressSave = progressSave.then(() => save(record));
        }
        if (record.type === "render" && index === 0) {
          progressTail = (progressTail + chunk).slice(-512);
          const matches = [...progressTail.matchAll(/Rendered (\d+)\/(\d+)/g)];
          const match = matches.at(-1);
          if (match) {
            const frames = Number(match[1]);
            const total = Number(match[2]);
            const percent = total ? Math.min(100, Math.floor(frames / total * 100)) : 0;
            if (percent >= lastPercent + 5 || percent === 100) {
              record.renderProgress = { frames, total, percent };
              lastPercent = percent;
              progressSave = progressSave.then(() => save(record));
            }
          }
        }
      });
      await progressSave;
      if (code !== 0) break;
    }
    await new Promise((resolve) => logStream.end(resolve));
    record.exitCode = code;
    if (code === 0 && record.type === "transcribe") await finishTranscription(record.project);
    if (code === 0 && record.type === "render") {
      record.phase = "finalizing";
      await save(record);
      await finalizeExport(record);
      record.phase = "completed";
    }
    record.state = code === 0 ? "done" : "failed";
    if (code !== 0) {
      const qc = record.type === "render" && record.output ? await readJson(path.join(root, record.output.replace(/\.mp4$/i, ".qc/validation.json")), null) : null;
      record.error = qc?.failures?.length ? `自动检查未通过：${qc.failures.join("；")}` : `${record.type} 任务失败（退出码 ${code}），请查看任务日志后重试。`;
    }
  } catch (error) {
    record.state = "failed";
    record.error = error.message;
  } finally {
    if (record.type === "render" && record.state === "failed") record.phase = "failed";
    record.finishedAt = new Date().toISOString();
    await save(record).catch(() => {});
    if (record.state === "done" && record.type === "proxy" && record.params.transcribeAfter) {
      try {
        const jobs = await listJobs(record.project);
        if (!jobs.some((job) => job.type === "transcribe" && job.state !== "failed")) await createJob(record.project, "transcribe");
      } catch (error) {
        record.error = `预览已完成，但无法启动转录：${error.message}`;
        await save(record).catch(() => {});
      }
    }
    running = false;
    drain();
  }
}

export async function readJob(project, id) {
  if (!/^j-[\dT]+-\d{3}$/.test(id)) throw unprocessable(`Bad job id "${id}"`);
  return readJson(projectFile(project, "jobs", `${id}.json`));
}

export async function listJobs(project, limit = 20) {
  const names = (await listJson(projectFile(project, "jobs"))).slice(-limit).reverse();
  return Promise.all(names.map((name) => readJson(projectFile(project, "jobs", name))));
}

export async function readJobLog(project, id) {
  const record = await readJob(project, id);
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(root, record.log), "utf8").catch(() => "");
}

// Jobs left "running" or "queued" by a previous server process never finish.
export async function recoverJobs(projectIds) {
  for (const project of projectIds) {
    for (const record of await listJobs(project, 1000)) {
      if (record.state === "running" || record.state === "queued") {
        record.state = "failed";
        record.error = "interrupted: the desk server stopped before the job finished";
        record.finishedAt = new Date().toISOString();
        await writeJson(jobFile(record), record);
      }
    }
  }
}

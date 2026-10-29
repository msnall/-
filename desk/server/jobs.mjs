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

const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];

const frames = z.array(z.number().int().nonnegative()).min(1).max(12);
const definitions = {
  proxy: { params: z.object({ force: z.boolean().default(false) }), commands: async (id, params) => [node("scripts/make-proxy.mjs", id, ...(params.force ? ["--force"] : []))] },
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
    params: z.object({}),
    commands: async (id, _params, record) => {
      const plan = await readJson(projectFile(id, "edit-plan.json"));
      let output = `out/desk/${id}/${id}-r${plan.revision ?? 0}.mp4`;
      for (let attempt = 2; await exists(path.join(root, output)); attempt++) output = `out/desk/${id}/${id}-r${plan.revision ?? 0}-${attempt}.mp4`;
      record.output = output;
      const planPath = `projects/${id}/edit-plan.json`;
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
    inputs: { editPlanSha256: await sha256File(projectFile(project, "edit-plan.json")).catch(() => null) },
    tools: await toolVersions(),
  };
  await save(record);
  queue.push(record);
  drain();
  return record;
}

const runCommand = ([binary, args], logStream) =>
  new Promise((resolve) => {
    logStream.write(`$ ${[path.basename(binary), ...args].join(" ")}\n`);
    const child = spawn(binary, args, { cwd: root, windowsHide: true });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
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
    const commands = await definitions[record.type].commands(record.project, record.params, record);
    await save(record);
    await mkdir(projectFile(record.project, "logs"), { recursive: true });
    const logStream = createWriteStream(path.join(root, record.log), { flags: "a" });
    let code = 0;
    for (const command of commands) {
      code = await runCommand(command, logStream);
      if (code !== 0) break;
    }
    await new Promise((resolve) => logStream.end(resolve));
    record.exitCode = code;
    record.state = code === 0 ? "done" : "failed";
  } catch (error) {
    record.state = "failed";
    record.error = error.message;
  } finally {
    record.finishedAt = new Date().toISOString();
    await save(record).catch(() => {});
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

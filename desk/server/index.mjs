// Review desk server (stage A): local only, 127.0.0.1.
//
//   npm run desk            builds the page and starts the server
//   npm run desk:serve      starts the server with the last built page
//
// The page talks to this server only through /api and /media; the server is
// the only writer of project files apart from Claude writing proposals.
import { createServer } from "node:http";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { listProjects, NotFound, projectFile } from "../../scripts/lib/storage.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import { emit, subscribe, watchProjects } from "./events.mjs";
import { createJob, listJobs, readJob, readJobLog, recoverJobs } from "./jobs.mjs";
import { mediaFile, publicFile, segmentThumb, sendFile, waveform } from "./media.mjs";
import * as projects from "./projects.mjs";

const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? process.env.DESK_PORT ?? 4310);
const uiDir = path.join(root, "out/desk-ui");

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) reject(badRequest("body too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });

const ifMatch = (request) => {
  const value = request.headers["if-match"]?.replace(/"/g, "");
  if (value === undefined || !/^\d+$/.test(value)) throw new HttpError(428, "If-Match: <revision> header is required");
  return Number(value);
};

// [method, pattern, handler(params, request, response) -> body | undefined]
const routes = [
  ["GET", /^\/api\/projects$/, async () => {
    const ids = await listProjects();
    return Promise.all(ids.map(async (id) => {
      const { plan, revision } = await projects.readPlan(id);
      const status = await projects.readStatus(id);
      return { id, revision, stage: status.stage, title: plan.meta?.title ?? id };
    }));
  }],
  ["GET", /^\/api\/projects\/([^/]+)$/, ([id]) => projects.readProject(id)],
  ["PUT", /^\/api\/projects\/([^/]+)\/edit-plan$/, async ([id], request) => {
    const body = await readBody(request);
    return projects.savePlan(id, body.plan, { expectedRevision: ifMatch(request), note: body.note });
  }],
  ["PUT", /^\/api\/projects\/([^/]+)\/status$/, async ([id], request) => projects.setStage(id, await readBody(request))],
  ["GET", /^\/api\/projects\/([^/]+)\/review\/([^/]+)$/, ([id, round]) => projects.readReview(id, round)],
  ["PUT", /^\/api\/projects\/([^/]+)\/review\/([^/]+)$/, async ([id, round], request) => projects.saveReview(id, round, await readBody(request))],
  ["POST", /^\/api\/projects\/([^/]+)\/review\/([^/]+)\/submit$/, ([id, round]) => projects.submitReview(id, round)],
  ["GET", /^\/api\/projects\/([^/]+)\/proposals$/, ([id]) => projects.listProposals(id)],
  ["POST", /^\/api\/projects\/([^/]+)\/proposals\/([^/]+)\/accept$/, ([id, pid]) => projects.acceptProposal(id, pid)],
  ["POST", /^\/api\/projects\/([^/]+)\/proposals\/([^/]+)\/reject$/, async ([id, pid], request) => projects.rejectProposal(id, pid, await readBody(request))],
  ["GET", /^\/api\/projects\/([^/]+)\/versions$/, ([id]) => projects.listVersions(id)],
  ["GET", /^\/api\/projects\/([^/]+)\/versions\/(\d+)$/, ([id, revision]) => projects.readVersion(id, revision)],
  ["POST", /^\/api\/projects\/([^/]+)\/versions\/(\d+)\/restore$/, ([id, revision], request) => projects.restoreVersion(id, revision, { expectedRevision: ifMatch(request) })],
  ["PUT", /^\/api\/projects\/([^/]+)\/faces\/overrides$/, async ([id], request) => projects.saveFaceOverrides(id, await readBody(request))],
  ["GET", /^\/api\/projects\/([^/]+)\/jobs$/, ([id]) => listJobs(id)],
  ["POST", /^\/api\/projects\/([^/]+)\/jobs$/, async ([id], request) => {
    const body = await readBody(request);
    return createJob(id, body.type, body.params ?? {});
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/jobs\/([^/]+)$/, ([id, jobId]) => readJob(id, jobId)],
  ["GET", /^\/api\/projects\/([^/]+)\/jobs\/([^/]+)\/log$/, async ([id, jobId], _request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(await readJobLog(id, jobId));
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/thumbs\/([^/]+)$/, async ([id, segment], request, response) => sendFile(request, response, await segmentThumb(id, segment), { cache: "max-age=3600" })],
  ["GET", /^\/api\/projects\/([^/]+)\/waveform$/, async ([id]) => {
    const { plan } = await projects.readPlan(id);
    const { resolved } = await projects.validate(id, plan);
    return waveform(id, resolved);
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/files\/proposals\/previews\/([\w.-]+\.jpg)$/, ([id, name], request, response) => sendFile(request, response, projectFile(id, "proposals/previews", name))],
  ["GET", /^\/api\/events$/, (_params, request, response) => subscribe(request, response)],
  ["GET", /^\/media\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/, async ([project, asset, frame], request, response) => sendFile(request, response, await mediaFile(project, asset, frame), { cache: "max-age=60" })],
];

const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const server = createServer(async (request, response) => {
  try {
    // Refuse requests addressed to another host name (DNS rebinding).
    if (!allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;
    const method = request.method === "HEAD" ? "GET" : request.method;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      if (routeMethod !== method) continue;
      const params = match.slice(1).map((part) => (part === undefined ? undefined : decodeURIComponent(part)));
      const result = await handler(params, request, response);
      if (!response.headersSent && !response.writableEnded) json(response, 200, result ?? { ok: true });
      return;
    }
    if (pathname.startsWith("/api/")) throw new HttpError(404, `No route ${request.method} ${pathname}`);
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    // The page, then fonts/transcripts the composition fetches by public path.
    const asUi = path.resolve(uiDir, "." + (pathname === "/" || !path.extname(pathname) ? "/index.html" : decodeURIComponent(pathname)));
    if (asUi.startsWith(uiDir + path.sep)) {
      try {
        return await sendFile(request, response, asUi);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
    }
    const file = publicFile(pathname);
    if (file) return await sendFile(request, response, file, { cache: "max-age=60" });
    throw new HttpError(404, "Not found");
  } catch (error) {
    if (response.headersSent) return response.end();
    if (error instanceof HttpError) return json(response, error.status, { error: error.message, ...error.body });
    if (error instanceof NotFound) return json(response, 404, { error: error.message });
    console.error(error);
    json(response, 500, { error: error.message ?? String(error) });
  }
});

await recoverJobs(await listProjects());
watchProjects();
server.listen(port, "127.0.0.1", () => {
  console.log(`Review desk: http://127.0.0.1:${port}/`);
  emit("server", { started: new Date().toISOString() });
});

// Server-sent events: job progress and project files changed by someone else
// (typically Claude writing a proposal). The page refreshes what it shows.
import { watch } from "node:fs";
import path from "node:path";
import { projectsDir } from "../../scripts/lib/storage.mjs";

const clients = new Set();

export function subscribe(request, response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(": connected\n\n");
  clients.add(response);
  const ping = setInterval(() => response.write(": ping\n\n"), 25000);
  request.on("close", () => {
    clearInterval(ping);
    clients.delete(response);
  });
}

export function emit(type, data) {
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(message);
}

// Files written by the server itself are announced too; the page compares
// revisions, so a redundant refresh is harmless.
export function watchProjects() {
  const pending = new Map();
  watch(projectsDir, { recursive: true }, (_, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.length < 2 || filename.endsWith(".tmp") || parts[1] === "logs" || parts[1] === "jobs") return;
    const key = filename;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        emit("file", { project: parts[0], file: parts.slice(1).join("/") });
      }, 150),
    );
  });
}

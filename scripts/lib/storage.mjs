// The one place that reads and writes project files (projects/<id>/…).
// Writes go to a temporary file first and are then renamed, so an interrupted
// write never leaves half a JSON file. Used by the review desk server and the
// desk scripts; swapping this module is how storage moves off the local disk.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./media.mjs";

export const projectsDir = path.join(root, "projects");
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

export class NotFound extends Error {}

export function projectDir(id) {
  if (!PROJECT_ID.test(id)) throw new NotFound(`Unknown project "${id}"`);
  return path.join(projectsDir, id);
}

// Path of a file inside a project; refuses anything that escapes it.
export function projectFile(id, ...parts) {
  const dir = projectDir(id);
  const file = path.resolve(dir, ...parts);
  if (file !== dir && !file.startsWith(dir + path.sep)) throw new NotFound(`Path escapes project ${id}`);
  return file;
}

export async function listProjects() {
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (entry.isDirectory() && PROJECT_ID.test(entry.name) && (await exists(path.join(projectsDir, entry.name, "edit-plan.json")))) ids.push(entry.name);
  }
  return ids.sort();
}

export async function exists(file) {
  return (await stat(file).catch(() => null)) !== null;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error.code === "ENOENT") throw new NotFound(`${path.relative(root, file)} does not exist`);
    throw new Error(`${path.relative(root, file)}: ${error.message}`);
  }
}

let counter = 0;
// On Windows a rename over a file another reader has open fails with
// EPERM/EACCES/EBUSY for a moment; retry briefly before giving up.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${++counter}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (RETRYABLE.has(error.code) && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function listJson(dir) {
  const names = await readdir(dir).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  return names.filter((name) => name.endsWith(".json")).sort();
}

// Accepts a project id or a path to its edit-plan.json.
export function projectIdFrom(argument) {
  if (PROJECT_ID.test(argument)) return argument;
  const resolved = path.resolve(root, argument);
  const relativeToProjects = path.relative(projectsDir, resolved).split(path.sep);
  if (relativeToProjects.length === 2 && relativeToProjects[1] === "edit-plan.json") return relativeToProjects[0];
  throw new NotFound(`"${argument}" is neither a project id nor projects/<id>/edit-plan.json`);
}

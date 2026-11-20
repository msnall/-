// 素材箱: drag files into the page by category; they are stored in an order-shaped folder under inbox/<order>/ so the normal
// ingest (scripts/ingest-order.mjs) handles them exactly like a TikTok One order folder.
//   inbox/2026-11_Kika-Keyboard/
//     04_达人回片/达人1_<name>/半身_口播A_<原文件名>   (talk)   |   动作_1_<原文件名>   (action)
//     02_官方素材/<原文件名>                                   (screen / official; the choice is kept in intake.json)
//     intake.json                                             { files: { "<relative path>": "talk|action|screen|official" } }
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { root } from "../../scripts/lib/media.mjs";
import { exists, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, unprocessable } from "./errors.mjs";
import { importOrder } from "./orders.mjs";

const inboxRoot = path.join(root, "inbox");
const MAX_BYTES = 8 * 1024 ** 3;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i, IMAGE = /\.(png|jpe?g|webp)$/i;
export const INTAKE = [
  { id: "talk", label: "达人口播", hint: "达人对镜头说话", dir: "04_达人回片", accept: VIDEO },
  { id: "action", label: "达人动作", hint: "达人手部、表情、拿手机等无台词动作", dir: "04_达人回片", accept: VIDEO },
  { id: "screen", label: "游戏录屏", hint: "我们自己录的软件或游戏操作", dir: "02_官方素材", accept: VIDEO },
  { id: "script", label: "口播文本", hint: "发给达人让他读的文本（.txt / .md），素材确认时拿来对照", dir: "03_脚本", accept: /\.(txt|md)$/i },
  { id: "official", label: "官方素材", hint: "品牌方给的视频、logo、截图", dir: "02_官方素材", accept: /\.(mp4|mov|m4v|webm|png|jpe?g|webp)$/i },
];
const byId = new Map(INTAKE.map((c) => [c.id, c]));

const cleanName = (name) => String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
function orderDir(order) {
  const name = cleanName(order);
  if (!name || name !== order || /\.\./.test(name)) throw badRequest("订单名不合法");
  return path.join(inboxRoot, name);
}
const creatorDir = (name) => `达人1_${cleanName(name) || "达人"}`;
const intakeFile = (dir) => path.join(dir, "intake.json");

// New order folder name: 2026-11_Kika-Keyboard (product words joined by hyphens).
export function newOrderName(product) {
  const slug = String(product ?? "").trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw badRequest("请先填写产品名称");
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}_${slug}`;
}

export async function listInboxOrders() {
  const names = (await readdir(inboxRoot).catch(() => [])).sort().reverse();
  const orders = [];
  for (const name of names) if ((await stat(path.join(inboxRoot, name))).isDirectory()) orders.push({ order: name, files: Object.keys((await readJson(intakeFile(path.join(inboxRoot, name)), { files: {} })).files).length });
  return orders;
}

export async function readInbox(order) {
  const dir = orderDir(order);
  const intake = await readJson(intakeFile(dir), { files: {} });
  const groups = Object.fromEntries(INTAKE.map((c) => [c.id, []]));
  for (const [rel, category] of Object.entries(intake.files)) {
    const info = await stat(path.join(dir, rel)).catch(() => null);
    if (info && groups[category]) groups[category].push({ rel, name: path.basename(rel), bytes: info.size });
  }
  return { order, categories: INTAKE.map(({ id, label, hint }) => ({ id, label, hint, files: groups[id] })), creator: intake.creator ?? "" };
}

async function freeName(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let n = 0; n < 100; n += 1) {
    const candidate = n ? `${base}-${n + 1}${ext}` : name;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw badRequest("同名文件太多");
}

// Streams the request body to disk (no buffering of 4K videos in memory).
export async function saveInboxFile(order, params, request) {
  const category = byId.get(params.get("category"));
  if (!category) throw badRequest("未知分类");
  const original = cleanName(params.get("name"));
  if (!category.accept.test(original)) throw unprocessable(`「${category.label}」不接受这种文件：${original || "（没有文件名）"}`);
  const dir = orderDir(order);
  const intake = await readJson(intakeFile(dir), { files: {} });
  if (params.get("creator")) intake.creator = cleanName(params.get("creator"));
  const sub = category.dir === "04_达人回片" ? path.join(category.dir, creatorDir(intake.creator)) : category.dir;
  await mkdir(path.join(dir, sub), { recursive: true });
  let target = original;
  if (category.id === "talk") {
    const used = Object.entries(intake.files).filter(([, c]) => c === "talk").length;
    target = `半身_口播${String.fromCharCode(65 + (used % 26))}${used >= 26 ? used : ""}_${original}`; // 口播A/B/C → separate asset ids downstream
  } else if (category.id === "action") {
    const used = Object.values(intake.files).filter((c) => c === "action").length;
    target = `动作_${used + 1}_${original}`;
  }
  target = await freeName(path.join(dir, sub), target);
  const final = path.join(dir, sub, target), temp = `${final}.part`;
  let size = 0;
  request.on("data", (chunk) => { size += chunk.length; if (size > MAX_BYTES) request.destroy(new Error("文件超过 8 GB")); });
  try { await pipeline(request, createWriteStream(temp)); } catch (error) { await rm(temp, { force: true }); throw error; }
  if (!size) { await rm(temp, { force: true }); throw badRequest("文件是空的"); }
  await rename(temp, final);
  const fresh = await readJson(intakeFile(dir), { files: {} }); // re-read: parallel uploads of other files may have written meanwhile
  fresh.files[path.join(sub, target)] = category.id;
  if (intake.creator) fresh.creator = intake.creator;
  await writeJson(intakeFile(dir), fresh);
  return readInbox(order);
}

export async function removeInboxFile(order, rel) {
  const dir = orderDir(order);
  const intake = await readJson(intakeFile(dir), { files: {} });
  if (!intake.files[rel]) throw badRequest("没有这个文件");
  await rm(path.join(dir, rel), { force: true }); // only ever inside inbox/<order>/
  delete intake.files[rel];
  await writeJson(intakeFile(dir), intake);
  return readInbox(order);
}

export async function importInbox(order) {
  const dir = orderDir(order);
  const inbox = await readInbox(order);
  const total = inbox.categories.reduce((n, c) => n + c.files.length, 0);
  if (!total) throw badRequest("还没有拖入任何素材");
  if (!inbox.categories.find((c) => c.id === "talk").files.length) throw badRequest("至少需要一条达人口播");
  return importOrder({ folder: dir });
}

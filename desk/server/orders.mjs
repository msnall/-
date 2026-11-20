// 导入订单素材: one click from an order folder (TikTok One layout) to a classified-ready project.
//   1 入库（转竖屏、30fps 工作副本）→ 2 达人口播转录（本地 whisper）→ 3 模型描述素材（需要 API Key，没有就用离线草稿）
// Progress goes to projects/<id>/import-run.json and is polled by the page. Order folders are only ever read.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { root } from "../../scripts/lib/media.mjs";
import { exists, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { badRequest, conflict } from "./errors.mjs";
import { describeItems } from "./catalog.mjs";
import { readApiSettings } from "./settings.mjs";

const running = new Set();
const node = (script, ...args) => [process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args]];
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// 2026-10_Kika-Keyboard -> kika-keyboard (the month is appended if that id is already taken)
async function projectIdFor(folder) {
  const name = path.basename(folder);
  const [month, ...rest] = name.split("_");
  const base = slug(rest.join(" ")) || slug(name) || "order";
  for (const candidate of [base, `${base}-${slug(month)}`, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]) {
    const ingest = await readJson(projectFile(candidate, "ingest.json"), null).catch(() => null);
    if (!ingest || path.basename(ingest.orderDir ?? "") === name || ingest.order === name) return candidate;
  }
  throw badRequest("找不到可用的项目名，请重命名订单文件夹");
}

export const importStatus = (id) => readJson(projectFile(id, "import-run.json"), { state: "idle" });

export async function importOrder({ folder }) {
  if (typeof folder !== "string" || !folder.trim()) throw badRequest("请填写订单文件夹的完整路径");
  const dir = path.resolve(folder.trim().replace(/^"|"$/g, ""));
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw badRequest(`找不到文件夹：${dir}`);
  const hasCreator = await exists(path.join(dir, "04_达人回片")), hasOfficial = await exists(path.join(dir, "02_官方素材"));
  if (!hasCreator && !hasOfficial) throw badRequest("这不是 TikTok One 订单文件夹：里面需要有「04_达人回片」或「02_官方素材」");
  const id = await projectIdFor(dir);
  if (running.has(id)) throw conflict("这个订单正在导入");
  await mkdir(projectFile(id), { recursive: true });
  const record = { state: "running", id, folder: dir, startedAt: new Date().toISOString(), finishedAt: null, error: null, note: null,
    steps: [{ name: "入库：转成竖屏工作副本", state: "pending" }, { name: "达人口播转录", state: "pending" }, { name: "模型描述素材", state: "pending" }] };
  await writeJson(projectFile(id, "import-run.json"), record);
  running.add(id);
  (async () => {
    await mkdir(projectFile(id, "logs"), { recursive: true });
    const log = createWriteStream(projectFile(id, "logs", "import.log"), { flags: "w" });
    const save = () => writeJson(projectFile(id, "import-run.json"), record);
    const spawnStep = (command) => new Promise((resolve, reject) => {
      const child = spawn(command[0], command[1], { cwd: root, windowsHide: true });
      let err = "";
      child.stdout.on("data", (d) => log.write(d));
      child.stderr.on("data", (d) => { log.write(d); err = (err + d).slice(-500); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit code ${code}`))));
    });
    let current = 0;
    try {
      record.steps[0].state = "running"; await save();
      await spawnStep(node("scripts/ingest-order.mjs", dir, id)); record.steps[0].state = "done"; current = 1;
      record.steps[1].state = "running"; await save();
      await spawnStep(node("scripts/transcribe-assets.mjs", id)); record.steps[1].state = "done"; current = 2;
      record.steps[2].state = "running"; await save();
      if ((await readApiSettings()).apiKey) {
        const result = await describeItems(id);
        const failed = Object.keys(result.errors).length;
        if (failed) record.note = `${failed} 个素材的模型描述失败，可以在素材分类页逐个重试：${Object.values(result.errors)[0]}`;
      } else record.note = "还没有保存 API Key，素材描述用的是离线草稿。到「API 设置」保存后，在素材分类页点「AI 描述」。";
      record.steps[2].state = "done";
      record.state = "done";
    } catch (error) {
      record.state = "failed"; record.steps[current].state = "failed";
      record.error = `${record.steps[current].name}失败：${error.message}`;
    } finally { log.end(); record.finishedAt = new Date().toISOString(); running.delete(id); await save(); }
  })();
  return record;
}

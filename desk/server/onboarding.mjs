import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { probe, publicDir, sha256File } from "../../scripts/lib/media.mjs";
import { exists, projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { conflict, unprocessable } from "./errors.mjs";
import { updateStatus } from "./projects.mjs";
import { classifyBeats } from "./beat-classifier.mjs";

const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_BYTES = 500 * 1024 * 1024;

export async function createVideo(request, params) {
  const id = params.get("id")?.trim();
  const title = params.get("title")?.trim();
  const productName = params.get("product")?.trim();
  const language = params.get("language")?.trim() || "auto";
  const extension = path.extname(params.get("name") ?? "").toLowerCase();
  if (!ID.test(id ?? "")) throw unprocessable("项目代号需为 3–40 位小写字母、数字或连字符");
  if (!title || title.length > 100 || !productName || productName.length > 100) throw unprocessable("请填写产品名称和视频名称（各不超过 100 字）");
  if (!["auto", "en", "zh"].includes(language)) throw unprocessable("语言必须是自动、英语或中文");
  if (![".mp4", ".mov", ".webm"].includes(extension)) throw unprocessable("请上传 MP4、MOV 或 WebM 口播视频");
  if (await exists(projectFile(id, "project.json"))) throw conflict(`项目代号 ${id} 已存在`);
  const folder = path.join(publicDir, "projects", id);
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `.${id}-source.uploading`);
  const file = path.join(folder, `${id}-source${extension}`);
  let bytes = 0;
  try {
    await pipeline(request, new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_BYTES ? new Error("视频不能超过 500 MB") : null, chunk);
    } }), createWriteStream(temporary, { flags: "wx" }));
    if (!bytes) throw unprocessable("视频文件为空");
    const info = await probe(temporary);
    if (!info.streams.some((stream) => stream.codec_type === "video") || !info.streams.some((stream) => stream.codec_type === "audio")) throw unprocessable("口播视频必须包含画面和声音");
    const sha256 = await sha256File(temporary);
    await rename(temporary, file);
    const prefix = `${id}-source`;
    await writeJson(projectFile(id, "project.json"), {
      id, title, productName, market: "US", language,
      media: { originalName: params.get("name"), bytes, durationMs: Math.round(Number(info.format.duration) * 1000), width: info.streams.find((stream) => stream.codec_type === "video")?.width, height: info.streams.find((stream) => stream.codec_type === "video")?.height },
      output: { width: 1080, height: 1920, fps: 30 }, footage: "source",
      transcript: { words: `transcripts/${prefix}.json`, cues: `transcripts/${prefix}.cues.json` },
    });
    await writeJson(projectFile(id, "assets.json"), {
      version: 1,
      items: [
        { id: "source", kind: "footage", status: "available", label: "口播原片", file: `projects/${id}/${prefix}${extension}`, sha256, source: "用户上传", neededBy: [], candidates: [] },
        { id: "product-front", kind: "image", status: "missing", label: "产品正面图", neededBy: [], candidates: [] },
      ],
      claims: [],
    });
    await writeJson(projectFile(id, "status.json"), {
      project: id, stage: "setup",
      stages: { "asset-prep": { state: "pending" }, storyboard: { state: "pending", round: "r1" }, "timeline-review": { state: "pending", round: "r1", openProposals: 0 }, "render-qc": { state: "pending" } },
      editPlanRevision: null, updatedAt: new Date().toISOString(), updatedBy: "user",
    });
    return { id, title, productName, bytes, durationMs: Math.round(Number(info.format.duration) * 1000) };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function finishTranscription(id) {
  const project = await readJson(projectFile(id, "project.json"));
  const words = await readJson(path.join(publicDir, project.transcript.words));
  const cues = await readJson(path.join(publicDir, project.transcript.cues));
  if (!words.length || !cues.length) throw new Error("转录结果为空");
  const beats = cues.map((cue, index) => {
    const within = words.map((word, wordIndex) => ({ word, wordIndex })).filter(({ word }) => word.startMs >= cue.startMs && word.endMs <= cue.endMs);
    if (!within.length) throw new Error(`第 ${index + 1} 条字幕没有对应词`);
    return { id: `b${index + 1}`, role: "filler", words: [within[0].wordIndex, within[within.length - 1].wordIndex], text: cue.text, claims: [] };
  });
  if (beats[0].words[0] !== 0 || beats[beats.length - 1].words[1] !== words.length - 1 || beats.some((beat, index) => index && beat.words[0] !== beats[index - 1].words[1] + 1)) throw new Error("转录词与字幕范围不连续，请检查转录结果");
  await writeJson(projectFile(id, "analysis", "beats.json"), { version: 1, confirmedAt: null, beats });
  await writeJson(projectFile(id, "storyboard", "r1", "option-a.json"), {
    id: "option-a", round: "r1", title: "基础口播方案", style: "clean-pink@1",
    summary: "按原片顺序保留口播。确认段落角色后，可以逐段选择剪辑技巧。",
    rows: beats.map((beat) => ({ beat: beat.id, keep: true, onScreen: "原片口播与字幕", cards: [] })),
    global: [], keyframes: [], createdBy: "workbench",
  });
  await writeJson(projectFile(id, "storyboard", "r1", "selection.json"), { round: "r1", option: "option-a", state: "draft", style: null, layoutOverrides: {}, draftOption: null, transitions: {}, confirmedAt: null });
  await updateStatus(id, (status) => { status.stage = "asset-prep"; status.stages["asset-prep"] = { state: "waiting-user" }; });
  await classifyBeats(id).catch((error) => console.warn(`段落 AI 分类待重试（${id}）：${error.message}`));
}

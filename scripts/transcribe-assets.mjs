// Transcribe every creator clip of a project (speech detection included).
//
//   node scripts/transcribe-assets.mjs <projectId> [--model <path>] [--force]
//
// Runs scripts/transcribe.mjs on the working copies listed in projects/<id>/ingest.json.
// Clips with no speech (whisper reports only [BLANK_AUDIO]) get an empty transcript and
// `speech: false` in ingest.json, so later steps treat them as visual-only footage.
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { publicDir, root, sha256File } from "./lib/media.mjs";
import { writeJson } from "./lib/storage.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--model");
const force = args.includes("--force");
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : "bin/whisper.cpp/models/ggml-small.en.bin";
if (!projectId) { console.error("Usage: node scripts/transcribe-assets.mjs <projectId> [--model <path>] [--force]"); process.exit(1); }

const ingestFile = path.join(root, "projects", projectId, "ingest.json");
const ingest = JSON.parse(await readFile(ingestFile, "utf8"));
const blank = (text) => !text.trim() || /^\[?\(?(blank_audio|silence|music|noise)\)?\]?$/i.test(text.trim());

for (const asset of ingest.assets.filter((a) => a.group === "creator" && a.file)) {
  const video = path.join(publicDir, asset.file);
  const prefix = path.join(publicDir, "transcripts", asset.transcript?.words ? path.parse(asset.transcript.words).name : `${projectId}--${asset.id}`);
  if (asset.kind !== "talk") { // only 口播 is transcribed; everything else is treated as silent footage
    asset.speech = false; asset.transcript = undefined;
    console.log(`${asset.id}: not a talking clip, treated as silent`);
    continue;
  }
  if (asset.hasAudio === false) { // silent footage (hand / action shots): nothing to transcribe
    asset.speech = false; asset.transcript = undefined;
    console.log(`${asset.id}: no audio track (visual-only footage)`);
    continue;
  }
  try {
    if (!force && asset.speech !== undefined && asset.transcript) { console.log(`${asset.id}: already transcribed (speech=${asset.speech})`); continue; }
    const name = asset.transcript?.words ? path.parse(asset.transcript.words).name : `${projectId}--${asset.id}`;
    const { stdout } = await exec(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/transcribe.mjs", video, "--language", "en", "--model", modelArg, "--name", name, "--force"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 900000, windowsHide: true });
    const meta = JSON.parse(await readFile(`${prefix}.meta.json`, "utf8"));
    asset.speech = true;
    asset.transcript = { words: `transcripts/${path.basename(prefix)}.json`, cues: `transcripts/${path.basename(prefix)}.cues.json`, model: path.basename(modelArg), unitCount: meta.unitCount, reviewed: false };
    console.log(`${asset.id}: ${meta.unitCount} words`);
  } catch (error) {
    // transcribe.mjs rejects an all-blank run with "inspect <whisper.json>"; read that raw file.
    const raw = /inspect (.+?whisper\.json)/.exec(String(error.stderr ?? error.message))?.[1];
    if (!raw) { console.error(`${asset.id}: transcription failed\n${error.stderr ?? error.message}`); process.exitCode = 1; continue; }
    const units = JSON.parse(await readFile(raw, "utf8")).transcription ?? [];
    // Whisper describes non-speech as e.g. "(speaking in foreign language)" or "[music]" (split over several units): that is not speech either.
    const joined = units.map((u) => u.text).join("").replace(/\s+/g, " ").trim();
    const noSpeech = units.every((u) => blank(u.text)) || /^([\[(][^\])]*[\])]\s*)+$/.test(joined);
    if (!noSpeech) { console.error(`${asset.id}: unusable timestamps in ${raw}`); process.exitCode = 1; continue; }
    await mkdir(path.dirname(prefix), { recursive: true });
    await writeFile(`${prefix}.json`, "[]\n"); await writeFile(`${prefix}.cues.json`, "[]\n");
    asset.speech = false;
    asset.transcript = { words: `transcripts/${path.basename(prefix)}.json`, cues: `transcripts/${path.basename(prefix)}.cues.json`, model: path.basename(modelArg), unitCount: 0, reviewed: false };
    console.log(`${asset.id}: no speech (visual-only footage)`);
  }
}
ingest.transcribedAt = new Date().toISOString();
await writeJson(ingestFile, ingest);

// Pin the model by hash, per CLAUDE.md.
const manifestFile = path.join(root, "models", "manifest.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const key = path.parse(modelArg).name.replace(/^ggml-/, "whisper_").replace(/\./g, "_");
if (!manifest[key]) {
  const full = path.resolve(root, modelArg);
  manifest[key] = { file: path.relative(root, full).split(path.sep).join("/"), sha256: await sha256File(full), source: "https://huggingface.co/ggerganov/whisper.cpp (ggml-small.en.bin)", runtime: "whisper.cpp 1.9.5-dev, commit 231638a0717b7822784297e5980965ffcec05810", usedBy: "scripts/transcribe.mjs, scripts/transcribe-assets.mjs" };
  await writeJson(manifestFile, manifest);
  console.log(`recorded ${key} in models/manifest.json`);
}

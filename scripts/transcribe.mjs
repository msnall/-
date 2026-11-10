import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: node scripts/transcribe.mjs <video> [--language auto|en|zh|...] [--model <path>] [--threads 4] [--force]
Outputs: public/transcripts/<video-name>.{json,txt,srt,review.json,meta.json}
Raw audio, Whisper JSON and logs: out/transcriptions/<video-name>/<run-id>/
JSON units are estimated short segments (words in many English cases, tokens/characters in CJK), not guaranteed word alignment.`;

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function parse(args) {
  const options = { language: "auto", threads: 4, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--force") { options.force = true; continue; }
    if (["--language", "--model", "--threads"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = arg === "--threads" ? Number(value) : value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.input) throw new Error(help);
  if (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > 64) {
    throw new Error("--threads must be an integer from 1 to 64");
  }
  return options;
}

async function run(command, args, logFile, timeout = 600_000) {
  try {
    const result = await execute(command, args, {
      cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout,
      encoding: "utf8",
    });
    if (logFile) await writeFile(logFile, result.stdout + result.stderr, "utf8");
    return result;
  } catch (error) {
    if (logFile) await writeFile(logFile, (error.stdout ?? "") + (error.stderr ?? "") + String(error), "utf8");
    throw new Error(`${path.basename(command)} failed (${error.code ?? error.message}). ${logFile ? `Log: ${logFile}` : ""}\n${(error.stderr ?? "").slice(-3000)}`);
  }
}

function stamp(ms) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function joinPieces(pieces) {
  return pieces.map((unit) => unit.originalText).join("").trim().replace(/\s+/gu, " ");
}

function makeCues(units) {
  const cues = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    cues.push({ text: joinPieces(group), startMs: group[0].startMs, endMs: group.at(-1).endMs });
    group = [];
  };
  for (const unit of units) {
    if (group.length && (unit.endMs - group[0].startMs > 3000 ||
        unit.startMs - group.at(-1).endMs > 650 || joinPieces([...group, unit]).length > 48)) {
      // Keep sentence endings with a short lead-in instead of flashing a lone final word.
      const carry = /[.!?。！？]$/u.test(unit.text) && group.length > 3 &&
        unit.startMs - group.at(-1).endMs <= 650 ? group.splice(-2) : [];
      flush();
      group = carry;
    }
    group.push(unit);
    if (/[.!?。！？]$/u.test(unit.text)) flush();
  }
  flush();
  return cues;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const input = path.resolve(options.input);
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`Not a file: ${input}`);
  const cli = path.join(root, "bin/whisper.cpp/build/bin/Release/whisper-cli.exe");
  const model = options.model ? path.resolve(options.model) : path.join(root, "bin/whisper.cpp/models/ggml-base.bin");
  for (const file of [cli, model]) if (!(await exists(file))) throw new Error(`Required file missing: ${file}`);
  const name = path.parse(input).name;
  const output = path.join(root, "public/transcripts", name);
  const extensions = ["json", "cues.json", "txt", "srt", "review.json", "meta.json"];
  if (!options.force) {
    for (const ext of extensions) if (await exists(`${output}.${ext}`)) {
      throw new Error(`Output exists: ${output}.${ext}. Use --force to replace. Raw runs are always preserved.`);
    }
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const work = path.join(root, "out/transcriptions", name, runId);
  await mkdir(work, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(input)) hash.update(chunk);
  const sourceSha256 = hash.digest("hex");
  const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", input], path.join(work, "probe.log"))).stdout);
  await writeFile(path.join(work, "source-probe.json"), JSON.stringify(probe, null, 2) + "\n");
  const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
  if (!audioStream) throw new Error("Input has no audio stream");
  const durationMs = Math.round(Number(probe.format.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Cannot determine source duration");
  const videoStart = Number(probe.streams.find((s) => s.codec_type === "video")?.start_time ?? probe.format.start_time ?? 0);
  const audioStart = Number(audioStream.start_time ?? probe.format.start_time ?? 0);
  const audioOffsetMs = Math.round((audioStart - videoStart) * 1000);
  if (!Number.isFinite(audioOffsetMs) || audioOffsetMs < 0) {
    throw new Error("Unsupported audio start time; normalize source timestamps before transcription");
  }
  const wav = path.join(work, "audio.wav");
  console.log("1/3 Extracting 16kHz mono PCM audio...");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], path.join(work, "ffmpeg.log"));
  console.log(`2/3 Transcribing with language=${options.language} (CPU)...`);
  const rawPrefix = path.join(work, "whisper");
  await run(cli, ["-m", model, "-f", wav, "-l", options.language, "-ng", "-t", String(options.threads),
    "-ml", "1", "-sow", "-ojf", "-otxt", "-osrt", "-of", rawPrefix], path.join(work, "whisper.log"));
  const raw = JSON.parse(await readFile(`${rawPrefix}.json`, "utf8"));
  if (!Array.isArray(raw.transcription)) throw new Error("Missing transcription array in Whisper JSON");
  const warnings = [];
  const units = [];
  let previousEnd = 0;
  for (const [index, segment] of raw.transcription.entries()) {
    const text = segment.text.trim();
    if (!text) continue;
    const startMs = segment.offsets?.from + audioOffsetMs;
    let endMs = segment.offsets?.to + audioOffsetMs;
    if (Number.isInteger(endMs) && endMs > durationMs && endMs <= durationMs + 250 && startMs < durationMs) {
      warnings.push({ index, text, originalEndMs: endMs, endMs: durationMs, reason: "short timestamp overshoot trimmed to source duration; human review needed" });
      endMs = durationMs;
    }
    if (![startMs, endMs].every(Number.isInteger) || startMs < previousEnd ||
        startMs < 0 || endMs < startMs || endMs > durationMs) {
      throw new Error(`Invalid/overlapping timestamp in raw segment ${index}; inspect ${rawPrefix}.json`);
    }
    if (startMs === endMs) warnings.push({ index, text, reason: "zero-duration unit" });
    const probabilities = (segment.tokens ?? [])
      .filter((t) => t.text?.trim() && !/^(?:\[_|<\|)/u.test(t.text.trim()))
      .map((t) => t.p).filter(Number.isFinite);
    const confidence = probabilities.length ? Math.min(...probabilities) : null;
    if (confidence !== null && confidence < 0.65) warnings.push({ index, text, startMs, endMs, confidence, reason: "low token probability; human review needed" });
    units.push({ text, startMs, endMs, originalText: segment.text });
    previousEnd = endMs;
  }
  if (!units.length) throw new Error("No non-empty transcription units; inspect raw audio and logs");
  const cues = makeCues(units);
  const text = joinPieces(units);
  const detectedLanguage = raw.result?.language ?? options.language;
  const meta = {
    input, sourceSha256, sourceBytes: inputStat.size, sourceModifiedAt: inputStat.mtime.toISOString(),
    model, detectedLanguage, requestedLanguage: options.language,
    durationMs, audioOffsetMs, runDirectory: work, unitCount: units.length, cueCount: cues.length,
    timing: "Whisper estimated short segments; not forced alignment or guaranteed linguistic words. Chinese can contain characters/tokens.",
    validation: "finite integer milliseconds, ordered non-overlapping units within source duration",
    humanReviewRequired: true,
  };
  const finalInputStat = await stat(input);
  if (inputStat.size !== finalInputStat.size || inputStat.mtimeMs !== finalInputStat.mtimeMs) {
    throw new Error("Source changed during transcription; outputs were not published. Run again with the final source.");
  }
  const review = {
    status: "unreviewed machine transcript", detectedLanguage,
    instructions: "Verify names, brands, product terms, numbers and claims against the audio. Token probabilities are not calibrated accuracy scores. No spelling was auto-corrected.",
    warnings,
  };
  console.log("3/3 Validating timestamps and writing captions...");
  await writeFile(`${output}.json`, JSON.stringify(units.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })), null, 2) + "\n");
  await writeFile(`${output}.cues.json`, JSON.stringify(cues, null, 2) + "\n");
  await writeFile(`${output}.txt`, text + "\n");
  await writeFile(`${output}.srt`, cues.map((cue, i) => `${i + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join("\n"));
  await writeFile(`${output}.review.json`, JSON.stringify(review, null, 2) + "\n");
  await writeFile(`${output}.meta.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify({ ...meta, warnings: warnings.length, transcript: text, outputPrefix: output }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

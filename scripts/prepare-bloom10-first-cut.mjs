import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const derived = path.join(root, "public/derived/bloom10");
const reportDir = path.join(root, "out/bloom10-first-cut");
const source = path.join(root, "public/recordings/Bloom10/Bloom10-达人素材.mp4");
const duration = 30.3;
const rate = 48000;
const sampleCount = Math.round(duration * rate);
const sourceHash = createHash("sha256").update(await readFile(source)).digest("hex");
if (sourceHash !== "31bf76ef1375c072f53117d2379660d40973ed323d61037d34afc3786a8274c3") throw new Error("The approved source has changed");
await mkdir(derived, { recursive: true });
await mkdir(reportDir, { recursive: true });
await mkdir(path.join(root, "public/fonts"), { recursive: true });
await copyFile(path.join(root, "hyperframes/packaging-label/assets/fonts/Inter-700.woff2"), path.join(root, "public/fonts/Inter-700.woff2"));

async function command(args, logName) {
  try {
    const result = await exec("ffmpeg", ["-hide_banner", ...args], {
      windowsHide: true, cwd: root, timeout: 600000, maxBuffer: 8 * 1024 * 1024,
    });
    await writeFile(path.join(reportDir, logName), result.stdout + result.stderr);
    return result.stderr;
  } catch (error) {
    await writeFile(path.join(reportDir, logName), (error.stdout ?? "") + (error.stderr ?? ""));
    throw error;
  }
}
function loudnessResult(log) {
  const result = log.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!result) throw new Error("No loudnorm measurements");
  return JSON.parse(result);
}
async function wav(file, samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  await writeFile(path.join(derived, file), buffer);
}

if (!process.argv.includes("--audio-only")) {
  console.log("Preparing 909 deterministic picture frames...");
  await mkdir(path.join(derived, "frames"), { recursive: true });
  await command(["-y", "-i", source, "-map", "0:v:0", "-an", "-vf", "scale=842:1498,fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=0.1",
    "-frames:v", "909", "-start_number", "0", "-q:v", "2", path.join(derived, "frames/frame-%04d.jpg")], "proxy.log");
}
if (process.argv.includes("--proxy-only")) process.exit(0);

console.log("Measuring and normalizing the original voice...");
const measured = loudnessResult(await command(["-i", source, "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "NUL"], "voice-measure.log"));
const normalization = `loudnorm=I=-16:TP=-1.5:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=false:print_format=json`;
await command(["-y", "-i", source, "-vn", "-af", `${normalization},aresample=48000,apad,atrim=duration=${duration}`, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", path.join(derived, "voice.wav")], "voice-normalize.log");

console.log("Generating quiet original pad music and two short effects...");
const music = new Float32Array(sampleCount);
const effects = new Float32Array(sampleCount);
const chords = [[48, 55, 60, 64], [45, 52, 59, 60], [41, 48, 55, 57], [43, 50, 57, 59]];
const frequency = (note) => 440 * 2 ** ((note - 69) / 12);
for (let i = 0; i < sampleCount; i++) {
  const t = i / rate;
  let value = 0;
  for (let chord = 0; chord < 4; chord++) {
    const start = chord * (duration / 4);
    const local = t - start;
    const length = duration / 4;
    if (local < 0 || local > length + 0.7) continue;
    const envelope = Math.min(1, local / 0.9) * Math.min(1, Math.max(0, (length + 0.7 - local) / 0.9));
    for (const note of chords[chord]) {
      const f = frequency(note);
      value += (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 1.002 * t)) * envelope / 5;
    }
  }
  const fade = Math.min(1, t / 1.2) * Math.min(1, (duration - t) / 1.2);
  music[i] = value * 0.062 * fade;
}
const events = [{ atFrame: 263, duration: 0.12, amplitude: 0.155, kind: "soft-pop" }, { atFrame: 515, duration: 0.16, amplitude: 0.093, kind: "soft-sweep" }];
for (const event of events) {
  const offset = Math.round(event.atFrame / 30 * rate);
  for (let i = 0; i < Math.round(event.duration * rate); i++) {
    const t = i / rate;
    const progress = t / event.duration;
    const envelope = Math.sin(Math.PI * progress) ** 2 * Math.exp(-progress * 4);
    const phase = 2 * Math.PI * (620 * t - 1400 * t * t);
    if (offset + i < effects.length) effects[offset + i] += Math.sin(phase) * envelope * event.amplitude;
  }
}
await wav("music.wav", music);
await wav("effects.wav", effects);
await command(["-y", "-i", path.join(derived, "voice.wav"), "-i", path.join(derived, "music.wav"), "-i", path.join(derived, "effects.wav"),
  "-filter_complex", `[0:a][1:a][2:a]amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.841395:level=false:latency=true,atrim=duration=${duration}[mix]`,
  "-map", "[mix]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", path.join(derived, "mix.wav")], "mix.log");

const levels = {};
for (const file of ["voice", "music", "effects", "mix"]) {
  levels[file] = loudnessResult(await command(["-i", path.join(derived, `${file}.wav`), "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "NUL"], `${file}-verification.log`));
}
if (Math.abs(Number(levels.voice.input_i) + 16) > 1.5 || Number(levels.mix.input_tp) > -1.3 ||
    Number(levels.voice.input_i) - Number(levels.music.input_i) < 14) throw new Error("Audio mix did not meet first-cut targets");
const report = { sourceSha256: sourceHash, fps: 30, frames: 909, duration, voiceTargetLUFS: -16, levels, events,
  musicSource: "Deterministic original sine-pad synthesis in this script, no external recording", voiceContentCut: false,
  note: "Voice normalized; full original order and spoken repetitions retained. No forced alignment is claimed." };
await writeFile(path.join(reportDir, "audio-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

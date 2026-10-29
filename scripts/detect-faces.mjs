// Face detection for the review desk's face zone and the layout checks.
//
//   node scripts/detect-faces.mjs bloom10-demo [--fps=5]
//
// Samples every picture asset the segments use (preferring the 540p proxy for
// videos), runs MediaPipe's BlazeFace short-range model inside headless Chrome
// (WASM, CPU) and writes projects/<id>/analysis/faces.json. Boxes are
// normalized to the source picture, so the result survives edit changes; it
// only needs re-running when the footage itself changes.
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { imageSequenceFile } from "../src/engine/load.ts";
import { footageAssets } from "./lib/storyboard-files.mjs";
import { publicDir, relative, root, run, sha256File } from "./lib/media.mjs";
import { projectFile, projectIdFrom, readJson, writeJson } from "./lib/storage.mjs";

const chrome = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const manifest = (await readJson(path.join(root, "models/manifest.json"))).blaze_face_short_range;
const visionDir = path.join(root, "node_modules/@mediapipe/tasks-vision");

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { FilesetResolver, FaceDetector } from "/vision/vision_bundle.mjs";
window.detectAll = async (urls) => {
  const fileset = await FilesetResolver.forVisionTasks("/vision/wasm");
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/model.tflite", delegate: "CPU" },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
  const results = [];
  for (const url of urls) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { detections } = detector.detect(image);
    const w = image.naturalWidth, h = image.naturalHeight;
    results.push({ width: w, height: h, faces: detections.map((d) => ({
      x: d.boundingBox.originX / w, y: d.boundingBox.originY / h,
      width: d.boundingBox.width / w, height: d.boundingBox.height / h,
      score: d.categories[0]?.score ?? 0,
    })) });
  }
  detector.close();
  return results;
};
window.ready = true;
</script>`;

const types = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".tflite": "application/octet-stream" };

// Serves the page, the MediaPipe bundle, the model and the sampled frames.
function startServer(frameRoots) {
  const server = createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let file = null;
    if (url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(PAGE);
    }
    if (url === "/model.tflite") file = path.join(root, manifest.file);
    else if (url.startsWith("/vision/")) file = path.join(visionDir, url.slice("/vision/".length));
    else if (url.startsWith("/frames/")) {
      const [key, ...rest] = url.slice("/frames/".length).split("/");
      if (frameRoots[key]) file = path.join(frameRoots[key], ...rest);
    }
    const allowed = file && Object.values({ root, ...frameRoots }).some((base) => path.resolve(file).startsWith(path.resolve(base)));
    if (!allowed) {
      response.writeHead(404);
      return response.end();
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      response.writeHead(404);
      response.end();
    });
    stream.on("open", () => response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }));
    stream.pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export async function detectFaces(projectId, { sampleFps = 5, log = console.log } = {}) {
  if ((await sha256File(path.join(root, manifest.file))) !== manifest.sha256) throw new Error(`${manifest.file} does not match models/manifest.json; re-download it`);
  const footage = await footageAssets(projectId);
  const proxies = await readJson(projectFile(projectId, "analysis/proxies.json"), { assets: {} });
  const cache = path.join(root, "out/desk-cache", projectId, "faces");

  // asset id -> { dir to serve, [{ file, ms }] }
  const jobs = {};
  for (const [assetId, asset] of Object.entries(footage)) {
    if (asset.type === "imageSequence") {
      const step = asset.fps / sampleFps;
      const samples = [];
      for (let k = 0; Math.round(k * step) < asset.frameCount; k++) {
        const index = Math.round(k * step);
        samples.push({ file: path.basename(imageSequenceFile(asset.dir, asset.pattern, index)), ms: (index * 1000) / asset.fps });
      }
      jobs[assetId] = { dir: path.join(publicDir, asset.dir), samples };
      continue;
    }
    const proxy = proxies.assets[assetId]?.file;
    const input = path.join(publicDir, proxy ?? asset.path);
    const dir = path.join(cache, assetId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    log(`faces ${assetId}: sampling ${relative(input)} at ${sampleFps} fps`);
    await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-vf", `fps=${sampleFps},scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'`, "-q:v", "3", path.join(dir, "f-%05d.jpg")]);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jpg")).sort();
    jobs[assetId] = { dir, samples: files.map((file, index) => ({ file, ms: (index * 1000) / sampleFps })) };
  }

  const server = await startServer(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.dir])));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run"] });
  const assets = {};
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction("window.ready === true");
    for (const [assetId, job] of Object.entries(jobs)) {
      const started = Date.now();
      const results = await page.evaluate((urls) => window.detectAll(urls), job.samples.map((sample) => `/frames/${assetId}/${encodeURIComponent(sample.file)}`));
      const withFace = results.filter((result) => result.faces.length).length;
      assets[assetId] = {
        width: results[0].width,
        height: results[0].height,
        sampleFps,
        samples: results.map((result, index) => ({ ms: Math.round(job.samples[index].ms), faces: result.faces.map((face) => ({ ...face, score: Number(face.score.toFixed(3)) })) })),
      };
      log(`faces ${assetId}: ${results.length} samples, face found in ${withFace} (${((withFace / results.length) * 100).toFixed(0)}%), ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  const visionVersion = (await readJson(path.join(visionDir, "package.json"))).version;
  const analysis = {
    version: 1,
    model: { name: "blaze_face_short_range", sha256: manifest.sha256, runtime: `@mediapipe/tasks-vision@${visionVersion} (WASM, CPU)` },
    createdAt: new Date().toISOString(),
    assets,
  };
  const output = projectFile(projectId, "analysis/faces.json");
  await writeJson(output, analysis);
  log(`faces wrote ${relative(output)}`);
  return analysis;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [argument, ...flags] = process.argv.slice(2);
  if (!argument) {
    console.error("Usage: node scripts/detect-faces.mjs <project-id> [--fps=5]");
    process.exit(2);
  }
  const fpsFlag = flags.find((flag) => flag.startsWith("--fps="));
  try {
    await detectFaces(projectIdFrom(argument), { sampleFps: fpsFlag ? Number(fpsFlag.slice(6)) : 5 });
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}

// Write the proofread 文案 (asset catalog) back into per-clip edited transcripts.
//
//   node scripts/sync-transcripts.mjs <projectId>
//
// For every creator clip with a 文案 item, the corrected text is aligned token-by-token to the
// Whisper words and written to public/transcripts/<clip>.edited.json (+ .edited.cues.json,
// one cue per line of text). Word *timings* stay Whisper's; only the text changes.
// Counts must match 1:1 (a corrected line may not add or remove words): that keeps every word's
// timing real. If they differ the clip is reported and left untouched.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readCatalog } from "../desk/server/catalog.mjs";
import { publicDir, root } from "./lib/media.mjs";
import { readJson } from "./lib/storage.mjs";
import { diffWords } from "./lib/wordsim.mjs";
import { transcriptPaths } from "./lib/transcripts.mjs";

const projectId = process.argv[2];
if (!projectId) { console.error("Usage: node scripts/sync-transcripts.mjs <projectId>"); process.exit(1); }
const catalog = await readCatalog(projectId);
let failed = 0;
for (const item of catalog.items.filter((i) => i.type === "text" && i.id.startsWith("script:"))) {
  const assetId = item.context.assetId;
  const ingest = await readJson(path.join(root, "projects", projectId, "ingest.json"));
  const paths = transcriptPaths(ingest.assets.find((a) => a.id === assetId));
  const words = await readJson(path.join(publicDir, paths.raw));
  const lines = item.description.split("\n").map((l) => l.trim()).filter(Boolean);
  const tokens = lines.flatMap((line, lineIndex) => line.split(/\s+/).map((text) => ({ text, lineIndex })));
  if (!item.confirmed) console.log(`${assetId}: warning — 文案 not confirmed in the catalog yet`);
  if (tokens.length !== words.length) {
    console.error(`${assetId}: corrected text has ${tokens.length} words, Whisper has ${words.length}. Keep the same number of words (fix spelling, don't add/remove), or re-time first.`);
    failed++; continue;
  }
  const big = diffWords(words.map((w) => w.text), tokens.map((t) => t.text)).filter((d) => d.big);
  if (big.length && !process.argv.includes("--allow-big-edits")) {
    console.error(`${assetId}: these edits look like slips (cut/paste or accidental typing), not spelling fixes: ${big.map((d) => `#${d.index} "${d.from}" → "${d.to}"`).join(", ")}. Fix them in 素材分类 (or re-run with --allow-big-edits if they are intended).`);
    failed++; continue;
  }
  const edited = words.map((w, i) => ({ text: tokens[i].text, startMs: w.startMs, endMs: w.endMs }));
  const cues = lines.map((_, lineIndex) => {
    const idx = tokens.map((t, i) => (t.lineIndex === lineIndex ? i : -1)).filter((i) => i >= 0);
    return { text: idx.map((i) => edited[i].text).join(" "), startMs: edited[idx[0]].startMs, endMs: edited[idx.at(-1)].endMs };
  });
  await writeFile(path.join(publicDir, paths.edited), JSON.stringify(edited, null, 2) + "\n");
  await writeFile(path.join(publicDir, paths.editedCues), JSON.stringify(cues, null, 2) + "\n");
  const changed = edited.filter((w, i) => w.text !== words[i].text).map((w, i) => `${words[edited.indexOf(w)].text}→${w.text}`);
  console.log(`${assetId}: ${edited.length} words, ${cues.length} lines${changed.length ? `, changed: ${changed.join(", ")}` : ", no text changes"}`);
}
process.exit(failed ? 1 : 0);

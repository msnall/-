// Where a clip's transcript files live. The raw transcript path is recorded in ingest.json (asset.transcript.words);
// the proofread version sits next to it as <name>.edited.json / <name>.edited.cues.json. New projects name the files
// "<projectId>--<assetId>" so two orders can never overwrite each other's transcripts (older projects keep their names).
export const transcriptPaths = (asset) => {
  const words = asset.transcript?.words;
  if (!words) throw new Error(`${asset.id} has no transcript yet (run the transcription step)`);
  const base = words.replace(/\.json$/, "");
  return { raw: words, cues: `${base}.cues.json`, edited: `${base}.edited.json`, editedCues: `${base}.edited.cues.json` };
};

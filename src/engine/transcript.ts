import { z } from "zod";
import { PlanError } from "./schema.ts";

// Transcript files written by scripts/transcribe.mjs (and their reviewed
// ".edited" versions). Times are source-clip milliseconds.

const word = z.strictObject({ text: z.string().min(1), startMs: z.number().nonnegative(), endMs: z.number().nonnegative() });
const cue = z.object({ text: z.string().min(1), startMs: z.number().nonnegative(), endMs: z.number().nonnegative() });

export type TranscriptWord = z.output<typeof word>;
export type TranscriptCue = z.output<typeof cue>;
export type Transcript = { words: TranscriptWord[]; cues: TranscriptCue[] };

export const parseTranscript = (words: unknown, cues: unknown, files: { words: string; cues: string }): Transcript => {
  const problems: string[] = [];
  const parsedWords = z.array(word).safeParse(words);
  const parsedCues = z.array(cue).safeParse(cues);
  if (!parsedWords.success) problems.push(...parsedWords.error.issues.map((issue) => `${files.words} [${issue.path.join(".")}]: ${issue.message}`));
  if (!parsedCues.success) problems.push(...parsedCues.error.issues.map((issue) => `${files.cues} [${issue.path.join(".")}]: ${issue.message}`));
  if (!parsedWords.success || !parsedCues.success) throw new PlanError(problems);
  parsedWords.data.forEach((item, index) => {
    if (item.endMs < item.startMs) problems.push(`${files.words} [${index}]: word "${item.text}" ends before it starts`);
  });
  parsedCues.data.forEach((item, index) => {
    if (item.endMs <= item.startMs) problems.push(`${files.cues} [${index}]: cue ends before it starts`);
  });
  if (problems.length) throw new PlanError(problems);
  return { words: parsedWords.data, cues: parsedCues.data };
};

// Loose comparison used by anchors' "expect": ignores case and punctuation.
export const normalizeWord = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

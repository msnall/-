// Compare a proofread transcript with Whisper's, word by word (same word count is required elsewhere).
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, "");
const lev = (a, b) => {
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
};
// 1 = same letters, 0 = nothing in common
export const wordSimilarity = (a, b) => { const x = norm(a), y = norm(b); return x === y ? 1 : 1 - lev(x, y) / Math.max(x.length, y.length, 1); };

// changes between two token lists of equal length: [{ index, from, to, similarity, big }]
// "big" = so different that it is more likely a slip (cut/paste, accidental typing) than a spelling fix.
export const diffWords = (original, edited) => original.flatMap((from, index) => {
  const to = edited[index];
  if (from === to) return [];
  const similarity = Number(wordSimilarity(from, to).toFixed(2));
  return [{ index, from, to, similarity, big: similarity < 0.34 }];
});
export const tokensOf = (text) => text.split(/\s+/).filter(Boolean);

// Feedback for the Review "repeat after me" drill: how close was what STT
// heard to the target line? Framed as a similarity score, not pass/fail —
// STT noise (especially on unusual katakana names) is expected, so a low
// score may be the transcription's fault, not the learner's.

// Same whitespace/punctuation strip Flow.tsx uses for its own echo-guard
// comparison (normalizeForCompare) — kept local rather than imported so this
// stays a standalone, dependency-free utility.
const normalize = (s: string) => s.replace(/[\s、。！？!?,.]/g, "");

/** Levenshtein edit distance between two strings (unicode-safe via Array.from). */
function levenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const rows = x.length + 1;
  const cols = y.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[rows - 1][cols - 1];
}

/** 1.0 = identical (after normalizing), 0.0 = completely different. */
export function similarity(target: string, heard: string): number {
  const a = normalize(target);
  const b = normalize(heard);
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export type DrillVerdict = "good" | "retry";

/** Compassionate threshold, not a strict grade — see file header. */
export function drillVerdict(target: string, heard: string, threshold = 0.6): DrillVerdict {
  return similarity(target, heard) >= threshold ? "good" : "retry";
}

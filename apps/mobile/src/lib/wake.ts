/**
 * Fuzzy "Hey <assistantName>" detection for the wake-word listener.
 *
 * Speech recognizers often mangle short names ("Nova" → "noah", "nover", "no va"), so we
 * accept a small edit distance on the name, and require a greeting before it ("hey", "hi",
 * "ok", "okay", "hello", "yo") to keep false positives low. Any words after the name are
 * returned as the command, so "Hey Nova add milk to my shopping list" is handled in one go.
 */

const GREETINGS = new Set(["hey", "hi", "hay", "ok", "okay", "hello", "hallo", "yo", "ey"]);

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function nameMatches(candidate: string, name: string): boolean {
  if (!candidate || !name) return false;
  if (candidate === name) return true;
  // 1 edit for very short names, 2 for typical ones, 3 for long ones. Beyond 1 edit the first
  // letter must match ("noah" ≈ "nova", but not "cobra").
  const allowed = name.length <= 3 ? 1 : name.length <= 7 ? 2 : 3;
  if (Math.abs(candidate.length - name.length) > allowed) return false;
  const d = levenshtein(candidate, name);
  return d <= 1 || (d <= allowed && candidate[0] === name[0]);
}

export type WakeMatch = { matched: true; command: string } | { matched: false };

/**
 * @param transcript what the recognizer heard
 * @param assistantName e.g. "Nova" (may be multi-word, e.g. "Captain Nova")
 */
export function matchWakeWord(transcript: string, assistantName: string): WakeMatch {
  const words = normalize(transcript);
  const nameWords = normalize(assistantName);
  if (!words.length || !nameWords.length) return { matched: false };
  const name = nameWords.join("");
  const n = nameWords.length;

  for (let i = 0; i < words.length; i++) {
    // Greeting + name as separate words, or glued ("heynova").
    const glued = words[i];
    for (const g of GREETINGS) {
      if (glued.startsWith(g) && glued.length > g.length && nameMatches(glued.slice(g.length), name)) {
        return { matched: true, command: words.slice(i + 1).join(" ") };
      }
    }
    if (!GREETINGS.has(words[i])) continue;
    // The name may be split by the recognizer ("no va"): try spans of n and n+1 words.
    // Pick the closest span so "no va" consumes both words.
    let best: { span: number; d: number } | null = null;
    for (const span of [n, n + 1]) {
      const cand = words.slice(i + 1, i + 1 + span);
      if (cand.length < span) continue;
      const joined = cand.join("");
      if (!nameMatches(joined, name)) continue;
      const d = levenshtein(joined, name);
      if (!best || d < best.d) best = { span, d };
    }
    if (best) return { matched: true, command: words.slice(i + 1 + best.span).join(" ") };
  }
  return { matched: false };
}

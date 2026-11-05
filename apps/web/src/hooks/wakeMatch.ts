/** Fuzzy "Hey <name>" detection for wake-word transcripts. Pure, so it's easy to reason about. */

const GREETINGS = new Set(["hey", "hay", "hei", "heyy", "hi", "hai", "hello", "ok", "okay", "a", "he", "hell"]);
// Frequent Chrome mishearings of the default name.
const NOVA_ALIASES = new Set(["nova", "nova", "nava", "novah", "noah", "nora", "nowa", "nover", "novak", "no va", "know va"]);

export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`]/g, "'") // LLM text uses curly apostrophes ("didn’t"); speech transcripts don't
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function similar(heard: string, name: string) {
  const h = heard.replace(/'/g, "");
  if (h === name) return true;
  if (name === "nova" && NOVA_ALIASES.has(heard)) return true;
  const tol = name.length <= 4 ? 1 : name.length <= 7 ? 2 : 3;
  return levenshtein(h.replace(/\s/g, ""), name.replace(/\s/g, "")) <= tol;
}

/**
 * If `transcript` contains "hey <name>" (fuzzy), returns the words after it (possibly ""),
 * otherwise null. "hey nila what's the weather" → "what's the weather".
 */
export function matchWakePhrase(transcript: string, assistantName: string): string | null {
  const words = normalize(transcript).split(" ").filter(Boolean);
  const name = normalize(assistantName) || "nova";
  const nameLen = name.split(" ").length;
  for (let i = 0; i < words.length; i++) {
    const greeted = GREETINGS.has(words[i]);
    // Try the name spread over 1..nameLen+1 words ("no va", "jar vis").
    for (let n = Math.max(1, nameLen); n <= nameLen + 1; n++) {
      const start = greeted ? i + 1 : i;
      if (start + n > words.length) continue;
      const heard = words.slice(start, start + n).join(" ");
      // Without a greeting word only accept an exact name at the very start ("nila, what's…").
      const ok = greeted ? similar(heard, name) : i === 0 && heard.replace(/\s/g, "") === name.replace(/\s/g, "");
      if (ok) return words.slice(start + n).join(" ");
    }
  }
  return null;
}

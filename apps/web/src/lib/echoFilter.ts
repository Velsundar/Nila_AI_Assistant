/**
 * Echo filter for "interrupt by voice". On speakers, the mic hears Nila's own voice, and the
 * browser's recognizer happily transcribes it. Treat a transcript as an echo (not a real
 * interruption) when it is too short to mean anything, or when most of its words are words
 * Nila is saying right now. Pure, so it is unit-tested with tsx.
 */
import { normalize } from "../hooks/wakeMatch";

const words = (s: string) => normalize(s).replace(/'/g, "").split(" ").filter(Boolean);

/** Edit distance of at most one (insert, delete or substitute). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * The mic hears Nila through the speakers, so the recognizer garbles her words: "log any" →
 * "login", "no" → "now", "expenses" → "ex", "tasks" → "task". Count a heard word as Nila's when
 * it is a near-miss of a spoken word, not only an exact match.
 */
function soundsSaid(w: string, said: Set<string>): boolean {
  if (said.has(w)) return true;
  for (const s of said) {
    const [short, long] = w.length <= s.length ? [w, s] : [s, w];
    if (short.length >= 2 && long.startsWith(short)) return true;
    if (long.length >= 3 && withinOneEdit(w, s)) return true;
  }
  return false;
}

/** Share (0..1) of the heard words that (nearly) match what Nila is saying. */
export function echoOverlap(heard: string, spoken: string): number {
  const h = words(heard);
  if (!h.length) return 1;
  const said = new Set(words(spoken));
  let hit = 0;
  for (const w of h) if (soundsSaid(w, said)) hit++;
  return hit / h.length;
}

export type EchoVerdict = "echo" | "too-short" | "speech";

export function classifyHeard(heard: string, spoken: string, threshold = 0.6): EchoVerdict {
  const n = words(heard).length;
  if (n < 2) return "too-short";
  return echoOverlap(heard, spoken) >= threshold ? "echo" : "speech";
}

/** True when the transcript should be ignored (echo of Nila's own voice, or a stray word). */
export function isLikelyEcho(heard: string, spoken: string, threshold = 0.6): boolean {
  return classifyHeard(heard, spoken, threshold) !== "speech";
}

/**
 * Remove a leading acknowledgement ("Okay.", "Mm-hmm.") that the mic picked up from Nila's own
 * ack right after an interruption: "okay what's the weather" → "what's the weather".
 */
export function stripAck(transcript: string, acks: readonly string[]): string {
  const t = words(transcript);
  for (const ack of acks) {
    const a = words(ack);
    if (a.length && a.length < t.length && a.every((w, i) => t[i] === w)) {
      // Drop the same number of words from the original text (keeps its punctuation/casing).
      const orig = transcript.trim().split(/\s+/);
      let consumed = 0;
      let k = 0;
      while (k < orig.length && consumed < a.length) consumed += words(orig[k++]).length;
      return orig.slice(k).join(" ").trim();
    }
  }
  return transcript.trim();
}

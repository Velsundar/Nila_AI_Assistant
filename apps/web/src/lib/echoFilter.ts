/**
 * Echo filter for "interrupt by voice". On speakers, the mic hears Nova's own voice, and the
 * browser's recognizer happily transcribes it. Treat a transcript as an echo (not a real
 * interruption) when it is too short to mean anything, or when most of its words are words
 * Nova is saying right now. Pure, so it is unit-tested with tsx.
 */
import { normalize } from "../hooks/wakeMatch";

const words = (s: string) => normalize(s).replace(/'/g, "").split(" ").filter(Boolean);

/** Share (0..1) of the heard words that also occur in what Nova is saying. */
export function echoOverlap(heard: string, spoken: string): number {
  const h = words(heard);
  if (!h.length) return 1;
  const said = new Set(words(spoken));
  let hit = 0;
  for (const w of h) if (said.has(w)) hit++;
  return hit / h.length;
}

export type EchoVerdict = "echo" | "too-short" | "speech";

export function classifyHeard(heard: string, spoken: string, threshold = 0.6): EchoVerdict {
  const n = words(heard).length;
  if (n < 2) return "too-short";
  return echoOverlap(heard, spoken) >= threshold ? "echo" : "speech";
}

/** True when the transcript should be ignored (echo of Nova's own voice, or a stray word). */
export function isLikelyEcho(heard: string, spoken: string, threshold = 0.6): boolean {
  return classifyHeard(heard, spoken, threshold) !== "speech";
}

/**
 * Remove a leading acknowledgement ("Okay.", "Mm-hmm.") that the mic picked up from Nova's own
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

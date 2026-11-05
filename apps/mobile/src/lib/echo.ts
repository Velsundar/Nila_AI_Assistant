/**
 * Echo filter for voice barge-in: while Nila speaks, the microphone also hears Nila. Phone echo
 * cancellation removes much of it, but not all, so recognised text that is mostly Nila's own
 * words is ignored.
 *
 * Rules (pure, unit-checked in scripts/check-voice-logic.ts):
 *  - fewer than 2 words → ignore (coughs, "uh", a stray word from the speaker);
 *  - ≥ 60% of the transcript's words appear in what Nila is saying → echo, ignore;
 *  - except: if the transcript *ends* with ≥ 3 words Nila isn't saying, the user talked over the
 *    echo, so that tail is the question.
 */

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export type EchoVerdict =
  | { echo: true; reason: "too-short" | "overlap"; overlap: number }
  | { echo: false; overlap: number; /** The user's words (the whole transcript, or the non-echo tail). */ question: string };

export const ECHO_OVERLAP = 0.6;
const MIN_TAIL = 3;

export function checkEcho(transcript: string, spoken: string | string[]): EchoVerdict {
  const words = normalizeWords(transcript);
  if (words.length < 2) return { echo: true, reason: "too-short", overlap: 0 };
  const spokenSet = new Set((Array.isArray(spoken) ? spoken : [spoken]).flatMap(normalizeWords));
  if (spokenSet.size === 0) return { echo: false, overlap: 0, question: transcript.trim() };

  const inSpoken = words.map((w) => spokenSet.has(w));
  const overlap = inSpoken.filter(Boolean).length / words.length;
  if (overlap < ECHO_OVERLAP) {
    // Strip a leading run of ≥ 3 echoed words ("your budget has … what's the weather").
    let lead = 0;
    while (lead < words.length && inSpoken[lead]) lead++;
    const question = lead >= MIN_TAIL ? words.slice(lead).join(" ") : transcript.trim();
    return { echo: false, overlap, question };
  }

  // Trailing run of words that are mostly not Nila's (allow one shared word, e.g. "the").
  let start = words.length;
  let shared = 0;
  for (let i = words.length - 1; i >= 0; i--) {
    if (inSpoken[i]) {
      if (shared >= 1) break;
      shared++;
    }
    start = i;
  }
  // Drop a leading shared word from the tail ("... rupees what is the weather" → keep from "what").
  while (start < words.length && inSpoken[start]) start++;
  const tail = words.slice(start);
  const novel = tail.filter((_, i) => !inSpoken[start + i]).length;
  if (novel >= MIN_TAIL) return { echo: false, overlap, question: tail.join(" ") };
  return { echo: true, reason: "overlap", overlap };
}

/** Quick check used on interim results: is this clearly the user talking (≥ minWords of their own)? */
export function looksLikeUser(transcript: string, spoken: string | string[], minWords = 3): boolean {
  const v = checkEcho(transcript, spoken);
  return !v.echo && normalizeWords(v.question).length >= minWords;
}

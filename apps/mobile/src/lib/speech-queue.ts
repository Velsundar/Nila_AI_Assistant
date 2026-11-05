/**
 * Pure parts of natural-voice playback (unit-checked in scripts/check-voice-logic.ts):
 *  - `playChunks`: fetch chunk 1, then while chunk i plays fetch chunk i+1; stop as soon as
 *    `alive()` is false; on any failure report the unspoken remainder (for the phone-voice fallback).
 *  - `naturalFailurePolicy`: how long to stay on the phone voice after an error, and the notice.
 */

export type ChunkDeps<C> = {
  fetch: (chunk: string) => Promise<C>;
  /** Resolves true when the clip played to the end, false if it failed or was stopped. */
  play: (clip: C) => Promise<boolean>;
  /** False once stop() was called or a newer utterance started. */
  alive: () => boolean;
  onStart?: () => void;
  onChunk?: (chunk: string) => void;
  onDone?: () => void;
  onError?: (error: unknown, remaining: string) => void;
};

export async function playChunks<C>(chunks: string[], d: ChunkDeps<C>): Promise<void> {
  if (!chunks.length) {
    if (d.alive()) d.onDone?.();
    return;
  }
  let next: Promise<C> | null = d.fetch(chunks[0]!);
  let started = false;
  for (let i = 0; i < chunks.length; i++) {
    let clip: C;
    try {
      clip = await next!;
    } catch (e) {
      if (d.alive()) d.onError?.(e, chunks.slice(i).join(" "));
      return;
    }
    if (!d.alive()) return;
    next = i + 1 < chunks.length ? d.fetch(chunks[i + 1]!) : null;
    next?.catch(() => {}); // handled when awaited
    if (!started) {
      started = true;
      d.onStart?.();
    }
    d.onChunk?.(chunks[i]!);
    const ok = await d.play(clip);
    if (!d.alive()) return;
    if (!ok) {
      d.onError?.(new Error("Couldn't play the natural voice audio."), chunks.slice(i).join(" "));
      return;
    }
  }
  if (d.alive()) d.onDone?.();
}

/** Minimal shape of the shared ApiError (kept structural so this file has no imports). */
type ApiLike = { status: number; code: string; details?: unknown };
const isApi = (e: unknown): e is ApiLike =>
  typeof e === "object" && e !== null && typeof (e as ApiLike).status === "number" && typeof (e as ApiLike).code === "string";

export type FailurePolicy = {
  /** Phone voice until this time (ms since epoch); Infinity = rest of the session. */
  downUntil: number;
  /** One-time notice key and text. */
  kind: "limit" | "unavailable" | "other";
  text: string;
};

export function naturalFailurePolicy(e: unknown, now: number, describe: (e: unknown) => string): FailurePolicy {
  if (isApi(e) && e.status === 429) {
    // TTS_RATE_LIMITED or DAILY_LIMIT: no retries; until retryAfter, else for the session.
    const raw = (e.details as { retryAfter?: unknown } | undefined)?.retryAfter;
    const secs = typeof raw === "number" ? raw : Number(raw);
    const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
    const until = ms ? ` for about ${Math.max(1, Math.ceil(ms / 60000))} min` : " for the rest of this session";
    return {
      downUntil: ms ? now + ms : Infinity,
      kind: "limit",
      text:
        e.code === "DAILY_LIMIT"
          ? `Today's free AI voice quota is used up, so Nila is using your phone's voice${until}.`
          : `The natural voice hit the free tier's rate limit, so Nila is using your phone's voice${until}.`,
    };
  }
  if (isApi(e) && (e.status === 503 || e.code === "TTS_UNAVAILABLE")) {
    return {
      downUntil: Infinity,
      kind: "unavailable",
      text: "The natural voice isn't available on the server right now, so Nila is using your phone's voice.",
    };
  }
  // 502 TTS_FAILED, 504 TTS_TIMEOUT, other HTTP errors, network: this reply falls back; retry later.
  return {
    downUntil: now + 30_000,
    kind: "other",
    text: `The natural voice didn't answer (${describe(e)}), so Nila finished with your phone's voice.`,
  };
}

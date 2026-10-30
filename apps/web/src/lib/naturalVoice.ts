"use client";

import { ApiError, type NaturalVoicesResult } from "@nova/shared";
import { api } from "./api";
import { trimAndNormalize } from "./audioClip";

/**
 * Natural (server, Groq Orpheus) voice: clip fetching, a small LRU of blob URLs, and a
 * "temporarily down" switch so a failing service isn't retried on every sentence.
 * Module-level on purpose: Settings' preview and the assistant page share one cache.
 */

const MAX_CLIPS = 24;
const lru = new Map<string, string>(); // (voice, text) → blob URL, oldest first
const pinned = new Map<string, string>(); // interrupt acks: never evicted
const inflight = new Map<string, Promise<string>>();
const inUse = new Set<string>(); // URLs loaded into an <audio> right now
const revokeLater = new Set<string>();

const key = (voice: string, text: string) => `${voice}\u0000${text}`;

/** "data:audio/wav;base64,…" → Blob, decoded locally (fetching a data: URL would need connect-src data:). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("Bad audio data");
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(";")[0] || "audio/wav";
  const body = dataUrl.slice(comma + 1);
  if (!meta.includes(";base64")) return new Blob([decodeURIComponent(body)], { type });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function evict() {
  while (lru.size > MAX_CLIPS) {
    const first = lru.entries().next().value;
    if (!first) break;
    const [k, url] = first;
    lru.delete(k);
    if (inUse.has(url)) revokeLater.add(url);
    else URL.revokeObjectURL(url);
  }
}

/** Mark a clip URL as loaded in / released from an audio element (evicted URLs are revoked on release). */
export function setClipInUse(url: string, used: boolean) {
  if (used) inUse.add(url);
  else {
    inUse.delete(url);
    if (revokeLater.delete(url)) URL.revokeObjectURL(url);
  }
}

/** Cached clip URL, or undefined (no network). */
export function peekClip(text: string, voice: string): string | undefined {
  const k = key(voice, text);
  return pinned.get(k) ?? lru.get(k);
}

/** Blob URL of `text` spoken in `voice` ("" = server default), from cache or POST /api/speak. */
export function getClip(text: string, voice: string, opts: { pin?: boolean } = {}): Promise<string> {
  const k = key(voice, text);
  const hit = pinned.get(k) ?? lru.get(k);
  if (hit) {
    if (lru.has(k)) {
      lru.delete(k); // refresh recency
      lru.set(k, hit);
    }
    return Promise.resolve(hit);
  }
  let p = inflight.get(k);
  if (!p) {
    p = api.voice
      .speak({ text, voice: voice || undefined })
      .then((r) => {
        const url = URL.createObjectURL(dataUrlToBlob(r.audio));
        if (opts.pin) pinned.set(k, url);
        else {
          lru.set(k, url);
          evict();
        }
        return url;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

// ---- Interrupt acks: fetched once per browser (Cache Storage), trimmed + normalised ----

const ACK_CACHE = "nova-acks-v1";
const ackRequest = (voice: string, text: string) => new Request(`/__nova-ack/${encodeURIComponent(voice || "default")}/${encodeURIComponent(text)}`);

async function openAckCache(): Promise<Cache | null> {
  try {
    return typeof caches !== "undefined" ? await caches.open(ACK_CACHE) : null;
  } catch {
    return null; // insecure context / storage blocked: memory only
  }
}

/** True when this ack clip is ready to play instantly. */
export function hasAck(text: string, voice: string) {
  return pinned.has(key(voice, text));
}

/**
 * Make the ack clip available in memory: from Cache Storage if a previous visit stored it
 * (no request), else POST /api/speak once, trim + normalise, and persist it.
 */
export async function loadAck(text: string, voice: string, opts: { network: boolean }): Promise<boolean> {
  const k = key(voice, text);
  if (pinned.has(k)) return true;
  const cache = await openAckCache();
  const req = ackRequest(voice, text);
  const stored = await cache?.match(req).catch(() => undefined);
  if (stored) {
    pinned.set(k, URL.createObjectURL(await stored.blob()));
    return true;
  }
  if (!opts.network) return false;
  const r = await api.voice.speak({ text, voice: voice || undefined });
  const clip = await trimAndNormalize(dataUrlToBlob(r.audio));
  await cache?.put(req, new Response(clip, { headers: { "Content-Type": clip.type || "audio/wav" } })).catch(() => undefined);
  pinned.set(k, URL.createObjectURL(clip));
  return true;
}

// ---- Availability ----

export type NaturalFailure = "TTS_UNAVAILABLE" | "TTS_RATE_LIMITED" | "DAILY_LIMIT" | "NETWORK" | "PLAYBACK" | "OTHER";

let down: { until: number; code: NaturalFailure } | null = null;

export function failureCode(err: unknown): NaturalFailure {
  if (err instanceof ApiError) {
    if (err.code === "TTS_UNAVAILABLE" || err.status === 503) return "TTS_UNAVAILABLE";
    if (err.code === "DAILY_LIMIT") return "DAILY_LIMIT";
    if (err.code === "TTS_RATE_LIMITED" || err.status === 429) return "TTS_RATE_LIMITED";
    return "OTHER";
  }
  if (err instanceof TypeError) return "NETWORK";
  if (err instanceof DOMException) return "PLAYBACK";
  return "OTHER";
}

// Rate limits: the whole account has ~100 requests/day, so stay on the device voice for the rest
// of the session unless the server says when to retry (details.retryAfter, seconds).
const DOWN_MS: Record<NaturalFailure, number> = {
  TTS_UNAVAILABLE: 5 * 60_000,
  DAILY_LIMIT: Infinity,
  TTS_RATE_LIMITED: Infinity,
  NETWORK: 30_000,
  PLAYBACK: 60_000,
  OTHER: 60_000, // incl. 504 TTS_TIMEOUT, 502 TTS_FAILED
};

function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== "object") return undefined;
  const d = err.details as { retryAfter?: unknown; retryAfterMs?: unknown };
  if (typeof d.retryAfterMs === "number" && d.retryAfterMs > 0) return d.retryAfterMs;
  if (typeof d.retryAfter === "number" && d.retryAfter > 0) return d.retryAfter * 1000;
  return undefined;
}

/** Record a failure; the device voice is used until it expires. Returns the failure code. */
export function markNaturalDown(err: unknown): NaturalFailure {
  const code = failureCode(err);
  const ms = (code === "TTS_RATE_LIMITED" || code === "DAILY_LIMIT" ? retryAfterMs(err) : undefined) ?? DOWN_MS[code];
  down = { code, until: Date.now() + ms };
  return code;
}

/** Current failure code while the natural voice is considered down, else null. */
export function naturalDown(): NaturalFailure | null {
  if (down && Date.now() < down.until) return down.code;
  down = null;
  return null;
}

export const FALLBACK_NOTICE: Record<NaturalFailure, string> = {
  TTS_UNAVAILABLE: "The natural voice isn't available right now, so I'm using this device's voice.",
  DAILY_LIMIT: "Natural voice limit reached for today, using the device voice.",
  TTS_RATE_LIMITED: "Natural voice limit reached for now, using the device voice.",
  NETWORK: "Couldn't reach the natural voice service, so I'm using this device's voice.",
  PLAYBACK: "This browser blocked the natural voice audio, so I'm using this device's voice.",
  OTHER: "The natural voice had a problem, so I finished in this device's voice.",
};

let voicesCache: { at: number; p: Promise<NaturalVoicesResult> } | null = null;

/** GET /api/speak/voices, cached for 60 s. A result with available=false marks the voice down briefly. */
export function loadNaturalVoices(force = false): Promise<NaturalVoicesResult> {
  if (!force && voicesCache && Date.now() - voicesCache.at < 60_000) return voicesCache.p;
  const p = api.voice.naturalVoices().then((r) => {
    if (!r.available) down = { code: "TTS_UNAVAILABLE", until: Date.now() + 60_000 };
    else if (down?.code === "TTS_UNAVAILABLE") down = null;
    return r;
  });
  p.catch(() => {
    voicesCache = null;
  });
  voicesCache = { at: Date.now(), p };
  return p;
}

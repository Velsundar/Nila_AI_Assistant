/**
 * Natural voice: server text-to-speech via Groq Orpheus (OpenAI-compatible /audio/speech).
 *
 * - Voices are discovered at runtime: a request with a deliberately invalid voice returns an error
 *   that lists the valid ones. Success is cached ~1 h, failure ~1 min (so accepting the model terms
 *   in the Groq console takes effect quickly).
 * - Text longer than one Groq request allows is split at sentence/clause boundaries and the WAVs joined.
 * - Results are kept in an in-memory LRU (voice + text), so repeated acks and briefings are free.
 */
import type { NaturalVoice, NaturalVoicesResult, SpeakResult } from "@nova/shared";
import { config } from "../config";
import { HttpError } from "../errors";
import { rateLimitWaitMs } from "../agent/llm";

const GROQ_BASE = "https://api.groq.com/openai/v1";
/** Never a real voice name: makes Groq answer with the list of valid ones. */
export const PROBE_VOICE = "nova-voice-probe";
const VOICES_TTL_MS = 60 * 60_000;
const VOICES_FAILURE_TTL_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Known Orpheus voice names -> gender (Groq's English set plus the original Orpheus set). */
const VOICE_GENDERS: Record<string, "female" | "male"> = {
  autumn: "female",
  diana: "female",
  hannah: "female",
  tara: "female",
  leah: "female",
  jess: "female",
  mia: "female",
  zoe: "female",
  austin: "male",
  daniel: "male",
  troy: "male",
  leo: "male",
  dan: "male",
  zac: "male",
};

export type TtsConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  preferredVoice?: string;
  maxInputChars: number;
  timeoutMs: number;
};

type Overrides = { cfg?: TtsConfig | null; fetchImpl?: typeof fetch; now?: () => number };
let overrides: Overrides = {};

/** Tests: inject config / fetch / clock. Also resets all caches. */
export function setTtsOverrides(o: Overrides = {}): void {
  overrides = o;
  resetTtsState();
}

export function ttsConfig(): TtsConfig | null {
  if (overrides.cfg !== undefined) return overrides.cfg;
  const { provider, apiKey, baseUrl } = config.llm;
  // Orpheus is hosted on Groq; mock mode or another provider means no natural voice.
  if (provider !== "groq" || !apiKey) return null;
  return {
    baseUrl: (baseUrl ?? GROQ_BASE).replace(/\/+$/, ""),
    apiKey,
    model: config.tts.model,
    preferredVoice: config.tts.voice,
    maxInputChars: config.tts.maxInputChars,
    timeoutMs: config.tts.timeoutMs,
  };
}

const log = (...a: unknown[]) => {
  if (!config.isTest) console.log(...a);
};
const warn = (...a: unknown[]) => {
  if (!config.isTest) console.warn(...a);
};
const now = () => (overrides.now ?? Date.now)();
const doFetch = (...args: Parameters<typeof fetch>) => (overrides.fetchImpl ?? fetch)(...args);

// ---------- Voice discovery ----------

/** Pull voice ids out of Groq's "invalid voice" error message. */
export function parseVoiceList(message: string): string[] {
  const clean = (ids: string[]) =>
    [...new Set(ids.map((s) => s.trim()).filter((s) => /^[A-Za-z][\w.-]{0,39}$/.test(s) && s !== PROBE_VOICE))].filter(
      (s) => !/^(and|or|one|of|the|are|is|be|must|voice|voices)$/i.test(s),
    );
  const bracket = /\[([^\]]+)\]/.exec(message)?.[1];
  if (bracket) {
    const ids = clean(bracket.split(/[\s,'"`]+/));
    if (ids.length) return ids;
  }
  const quoted = [...message.matchAll(/['"`]([A-Za-z][\w.-]{0,39})['"`]/g)].map((m) => m[1]!);
  if (clean(quoted).length >= 2) return clean(quoted);
  const tail = /(?:one of|valid voices(?: are)?|supported voices(?: are)?|available voices(?: are)?)\s*:?\s*(.+)$/is.exec(message)?.[1];
  if (tail) return clean(tail.replace(/\.\s*$/, "").split(/[\s,'"`]+/));
  return [];
}

function errorInfo(body: string): { code?: string; message: string } {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error;
    return { code: e?.code, message: e?.message ?? body };
  } catch {
    return { message: body };
  }
}

export function voiceGender(id: string): NaturalVoice["gender"] {
  return VOICE_GENDERS[id.toLowerCase()];
}

export function pickDefaultVoice(voices: NaturalVoice[], preferred?: string): string | undefined {
  if (preferred) {
    const match = voices.find((v) => v.id.toLowerCase() === preferred.toLowerCase());
    if (match) return match.id;
  }
  return (voices.find((v) => v.gender === "female") ?? voices[0])?.id;
}

function available(ids: string[], cfg: TtsConfig): NaturalVoicesResult {
  const voices = ids.map((id) => {
    const gender = voiceGender(id);
    return gender ? { id, gender } : { id };
  });
  return { available: true, voices, defaultVoice: pickDefaultVoice(voices, cfg.preferredVoice) };
}

const unavailable = (reason: NonNullable<NaturalVoicesResult["reason"]>): NaturalVoicesResult => ({ available: false, reason, voices: [] });

async function discover(cfg: TtsConfig): Promise<NaturalVoicesResult> {
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, voice: PROBE_VOICE, input: "Hi.", response_format: "wav" }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (e) {
    warn(`[tts] voice discovery failed: ${(e as Error).message}`);
    return unavailable("UNAVAILABLE");
  }
  const body = await res.text().catch(() => "");
  if (res.ok) {
    // The probe voice was accepted, so the model doesn't validate names: offer the known set.
    warn("[tts] probe voice accepted; falling back to the known Orpheus voice list");
    return available(Object.keys(VOICE_GENDERS).slice(0, 6), cfg);
  }
  const err = errorInfo(body);
  if (err.code === "model_terms_required" || /terms acceptance/i.test(err.message)) {
    warn(`[tts] ${cfg.model}: model terms not accepted yet (Groq console)`);
    return unavailable("TERMS_REQUIRED");
  }
  const ids = res.status === 400 ? parseVoiceList(err.message) : [];
  if (ids.length) {
    log(`[tts] discovered ${ids.length} voices for ${cfg.model}: ${ids.join(", ")}`);
    return available(ids, cfg);
  }
  warn(`[tts] voice discovery got ${res.status}: ${err.message.slice(0, 200)}`);
  return unavailable("UNAVAILABLE");
}

let voicesCache: { result: NaturalVoicesResult; expiresAt: number } | undefined;
let voicesInflight: Promise<NaturalVoicesResult> | undefined;

/** Mark the voices as unusable (e.g. a speak call hit model_terms_required) for the short failure TTL. */
function cacheVoices(result: NaturalVoicesResult): void {
  voicesCache = { result, expiresAt: now() + (result.available ? VOICES_TTL_MS : VOICES_FAILURE_TTL_MS) };
}

export async function getNaturalVoices(): Promise<NaturalVoicesResult> {
  const cfg = ttsConfig();
  if (!cfg) return unavailable("NO_KEY");
  if (voicesCache && voicesCache.expiresAt > now()) return voicesCache.result;
  voicesInflight ??= discover(cfg)
    .then((result) => {
      cacheVoices(result);
      return result;
    })
    .finally(() => {
      voicesInflight = undefined;
    });
  return voicesInflight;
}

// ---------- Text splitting and WAV joining ----------

function pack(pieces: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && (cur + p).trim().length > max) {
      out.push(cur.trim());
      cur = "";
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split text into chunks of at most `max` chars, preferring sentence, then clause, then word boundaries. */
export function splitForTts(text: string, max: number): string[] {
  const t = text.trim();
  if (t.length <= max) return [t];
  const levels = [/[^.!?…]+(?:[.!?…]+["')\]]*\s*|$)/g, /[^,;:—–]+(?:[,;:—–]\s*|$)/g, /\S+\s*/g];
  const split = (s: string, level: number): string[] => {
    if (s.trim().length <= max) return [s];
    if (level >= levels.length) {
      const hard: string[] = [];
      for (let i = 0; i < s.length; i += max) hard.push(s.slice(i, i + max));
      return hard;
    }
    const parts = (s.match(levels[level]!) ?? [s]).filter(Boolean);
    return parts.flatMap((p) => split(p, level + 1));
  };
  return pack(split(t, 0), max).filter(Boolean);
}

type Wav = { fmt: Buffer; data: Buffer };

export function parseWav(buf: Buffer): Wav | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt: Buffer | undefined;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === "data") {
      // Streamed WAVs often carry 0 / 0xFFFFFFFF as the data size: take the rest of the buffer.
      const end = size === 0 || start + size > buf.length ? buf.length : start + size;
      return fmt ? { fmt, data: buf.subarray(start, end) } : null;
    }
    if (start + size > buf.length) return null;
    if (id === "fmt ") fmt = buf.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  return null;
}

/** Join same-format WAVs into one with correct RIFF/data sizes. */
export function concatWav(parts: Buffer[]): Buffer {
  const parsed = parts.map(parseWav);
  if (parsed.some((p) => !p)) throw new HttpError(502, "TTS_FAILED", "Voice service returned unreadable audio");
  const wavs = parsed as Wav[];
  const fmt = wavs[0]!.fmt;
  if (wavs.some((w) => !w.fmt.equals(fmt))) throw new HttpError(502, "TTS_FAILED", "Voice service returned mismatched audio");
  const data = Buffer.concat(wavs.map((w) => w.data));
  const fmtPad = fmt.length % 2;
  const header = Buffer.alloc(12 + 8 + fmt.length + fmtPad + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write("data", 20 + fmt.length + fmtPad, "ascii");
  header.writeUInt32LE(data.length, 24 + fmt.length + fmtPad);
  return Buffer.concat([header, data]);
}

// ---------- Audio cache (LRU by entries and bytes) ----------

export class LruCache {
  private map = new Map<string, string>();
  private bytes = 0;
  constructor(
    private maxEntries: number,
    private maxBytes: number,
  ) {}
  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: string): void {
    if (value.length > this.maxBytes) return;
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, v] = this.map.entries().next().value as [string, string];
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
  get size() {
    return this.map.size;
  }
  get totalBytes() {
    return this.bytes;
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

export const audioCache = new LruCache(200, 25 * 1024 * 1024);
/** Set after a Groq 429: requests fail fast (without spending budget) until then. */
let rateLimitedUntil = 0;

export function resetTtsState(): void {
  voicesCache = undefined;
  voicesInflight = undefined;
  audioCache.clear();
  rateLimitedUntil = 0;
}

// ---------- Speak ----------

function rateLimited(waitMs: number | undefined): HttpError {
  const ms = Math.max(1000, Math.ceil(waitMs ?? 10_000));
  return new HttpError(429, "TTS_RATE_LIMITED", "The natural voice is busy, try again shortly", {
    retryAfter: Math.ceil(ms / 1000),
    retryAfterMs: ms,
  });
}

const UNAVAILABLE_MESSAGES: Record<NonNullable<NaturalVoicesResult["reason"]>, string> = {
  NO_KEY: "The natural voice needs a Groq API key on the server",
  TERMS_REQUIRED: "The natural voice isn't enabled yet: the Groq account must accept the Orpheus model terms",
  UNAVAILABLE: "The natural voice is unavailable right now",
};

async function synthesize(cfg: TtsConfig, voice: string, input: string, signal: AbortSignal): Promise<Buffer> {
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, voice, input, response_format: "wav" }),
      signal,
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "TTS_TIMEOUT", "The natural voice took too long");
    throw new HttpError(502, "TTS_FAILED", `Voice service unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = errorInfo(body);
    if (res.status === 429) {
      const wait = rateLimitWaitMs(res.headers, body);
      rateLimitedUntil = now() + Math.max(1000, wait ?? 10_000);
      throw rateLimited(wait);
    }
    if (err.code === "model_terms_required" || /terms acceptance/i.test(err.message)) {
      cacheVoices(unavailable("TERMS_REQUIRED"));
      throw new HttpError(503, "TTS_UNAVAILABLE", UNAVAILABLE_MESSAGES.TERMS_REQUIRED);
    }
    if (res.status === 401 || res.status === 403) {
      cacheVoices(unavailable("UNAVAILABLE"));
      throw new HttpError(503, "TTS_UNAVAILABLE", "The natural voice is unavailable: the server's Groq key was rejected");
    }
    if (res.status === 400 && /voice/i.test(err.message) && parseVoiceList(err.message).length) {
      voicesCache = undefined; // the voice list changed: rediscover next time
      throw new HttpError(400, "VALIDATION_ERROR", `Unknown voice "${voice}"`, { voice });
    }
    warn(`[tts] Groq ${res.status}: ${err.message.slice(0, 200)}`);
    throw new HttpError(502, "TTS_FAILED", `Voice service error ${res.status}`);
  }
  let audio: Buffer;
  try {
    audio = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "TTS_TIMEOUT", "The natural voice took too long");
    throw new HttpError(502, "TTS_FAILED", "Voice service connection dropped");
  }
  if (audio.length < 44) throw new HttpError(502, "TTS_FAILED", "Voice service returned no audio");
  return audio;
}

export async function speak(
  input: { text: string; voice?: string },
  opts: { consumeBudget?: () => Promise<void> } = {},
): Promise<SpeakResult> {
  const cfg = ttsConfig();
  if (!cfg) throw new HttpError(503, "TTS_UNAVAILABLE", UNAVAILABLE_MESSAGES.NO_KEY, { reason: "NO_KEY" });
  const voices = await getNaturalVoices();
  if (!voices.available) {
    const reason = voices.reason ?? "UNAVAILABLE";
    throw new HttpError(503, "TTS_UNAVAILABLE", UNAVAILABLE_MESSAGES[reason], { reason });
  }
  let voice = voices.defaultVoice!;
  if (input.voice !== undefined) {
    const match = voices.voices.find((v) => v.id.toLowerCase() === input.voice!.trim().toLowerCase());
    if (!match) {
      throw new HttpError(400, "VALIDATION_ERROR", `Unknown voice "${input.voice}"`, { voice: input.voice, voices: voices.voices.map((v) => v.id) });
    }
    voice = match.id;
  }

  const text = input.text.trim();
  const key = `${voice}\n${text}`;
  const hit = audioCache.get(key);
  if (hit) return { audio: hit, voice };

  if (rateLimitedUntil > now()) throw rateLimited(rateLimitedUntil - now());
  await opts.consumeBudget?.();

  const started = now();
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const chunks = splitForTts(text, cfg.maxInputChars);
  const parts: Buffer[] = [];
  for (const chunk of chunks) parts.push(await synthesize(cfg, voice, chunk, signal));
  const wav = parts.length === 1 && !parseWav(parts[0]!) ? parts[0]! : concatWav(parts);
  const audio = `data:audio/wav;base64,${wav.toString("base64")}`;
  audioCache.set(key, audio);
  log(`[tts] ${cfg.model} voice=${voice} chars=${text.length} chunks=${chunks.length} bytes=${wav.length} ms=${now() - started}`);
  return { audio, voice };
}

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioSample, type AudioStatus } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";

import { api } from "@/lib/api";
import { splitIntoChunks } from "@/lib/chunk";
import { LruIndex, type LruEntry } from "@/lib/lru";
import { playChunks } from "@/lib/speech-queue";
import { base64ToBytes, trimLeadingSilence } from "@/lib/wav";

/**
 * Natural voice playback: Groq Orpheus through `POST /api/speak` (the free daily AI quota).
 *
 * - The free tier is ~100 requests/day for the whole account, so a reply of ≤ 400 chars is ONE
 *   request; only longer text is split (fewest chunks of ≤ 380 chars at sentence boundaries).
 *   Chunk 1 is fetched first; while a chunk plays, the next one is fetched.
 * - Each base64 WAV (leading silence trimmed) is written to a file in the cache directory and
 *   played with expo-audio.
 *   Files are kept in a small LRU cache keyed by (voice, text) so repeats and the interrupt acks
 *   play instantly; evicted files are deleted.
 * - `stopNatural()` halts the player immediately; fetches already in flight still finish (and get
 *   cached) but are never played (generation counter).
 * - Errors are reported with the unspoken remainder so the caller can finish with the phone voice.
 */

const MAX_ENTRIES = 40;
const MAX_BYTES = 16 * 1024 * 1024; // ~ 5 minutes of 24 kHz mono 16-bit audio
const LOAD_TIMEOUT_MS = 8000;

const dir = new Directory(Paths.cache, "nova-tts");
const indexFile = () => new File(dir, "index.json");

let index: LruIndex<string> | null = null;
const inflight = new Map<string, Promise<string>>();

function deleteFiles(entries: LruEntry<string>[]) {
  for (const e of entries) {
    try {
      const f = new File(dir, e.value);
      if (f.exists) f.delete();
    } catch {}
  }
}

function getIndex(): LruIndex<string> {
  if (index) return index;
  index = new LruIndex<string>(MAX_ENTRIES, MAX_BYTES);
  try {
    dir.create({ intermediates: true, idempotent: true });
    const f = indexFile();
    if (f.exists) {
      const saved = JSON.parse(f.textSync()) as LruEntry<string>[];
      if (Array.isArray(saved)) deleteFiles(index.load(saved.filter((e) => e && typeof e.key === "string" && typeof e.value === "string")));
    }
    // Remove orphans (files written before a crash, or by an older index).
    const known = new Set(index.entries().map((e) => e.value));
    for (const item of dir.list()) {
      if (item instanceof File && item.name.endsWith(".wav") && !known.has(item.name)) {
        try {
          item.delete();
        } catch {}
      }
    }
  } catch {
    // The cache is an optimisation; an unreadable index just starts empty.
  }
  return index;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistIndex() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      indexFile().write(JSON.stringify(getIndex().entries()));
    } catch {}
  }, 500);
}

const cacheKey = (voice: string, text: string) => `${voice}\n${text.trim()}`;

/** FNV-1a, for readable-ish unique file names. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
let seq = 0;

export function isClipCached(text: string, voice: string): boolean {
  const name = getIndex().entries().find((e) => e.key === cacheKey(voice, text))?.value;
  if (!name) return false;
  try {
    return new File(dir, name).exists;
  } catch {
    return false;
  }
}

/** The local file URI for (voice, text): from the cache, or fetched from the API and cached. */
export function getClip(text: string, voice: string, pin = false): Promise<string> {
  const key = cacheKey(voice, text);
  const idx = getIndex();
  const cached = idx.get(key);
  if (cached) {
    try {
      const f = new File(dir, cached);
      if (f.exists) {
        if (pin) idx.set(key, cached, f.size, true);
        return Promise.resolve(f.uri);
      }
    } catch {}
    idx.delete(key);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await api.voice.speak({ text: text.trim(), ...(voice ? { voice } : {}) });
    const b64 = res.audio.slice(res.audio.indexOf(",") + 1);
    if (!b64) throw new Error("Empty audio from /api/speak");
    const name = `${hash(key)}-${Date.now().toString(36)}${(seq++).toString(36)}.wav`;
    const f = new File(dir, name);
    try {
      dir.create({ intermediates: true, idempotent: true });
    } catch {}
    // Strip the ~0.3–0.45 s of leading silence Orpheus adds (faster acks and first words).
    let bytes: Uint8Array | null = null;
    try {
      bytes = trimLeadingSilence(base64ToBytes(b64)).bytes;
    } catch {}
    if (bytes) await f.write(bytes);
    else await f.write(b64, { encoding: "base64" });
    deleteFiles(idx.set(key, name, bytes?.length ?? Math.floor((b64.length * 3) / 4), pin));
    persistIndex();
    return f.uri;
  })();
  inflight.set(key, p);
  p.then(
    () => inflight.delete(key),
    () => inflight.delete(key),
  );
  return p;
}

// ---------- Audio session ----------

let keepMic = false;
/**
 * Voice barge-in keeps the recognizer running while Nova talks. On iOS that needs the
 * playAndRecord category for playback too (routed to the loudspeaker, not the earpiece).
 */
export function setPlaybackKeepsMic(on: boolean) {
  keepMic = on;
}

async function configureAudio() {
  try {
    await setAudioModeAsync({
      // Audible with the iOS ring/silent switch on silent.
      playsInSilentMode: true,
      // playAndRecord only when the recognizer must keep listening; otherwise plain playback so the
      // loudspeaker is used. The recorder (server STT) and recognizer set their own mode on start.
      allowsRecording: keepMic,
      shouldRouteThroughEarpiece: false,
      interruptionMode: "mixWithOthers",
      shouldPlayInBackground: false,
    });
  } catch {}
}

// ---------- Playback ----------

let gen = 0;
let current: { player: AudioPlayer; finish: (ok: boolean) => void } | null = null;

function rms(sample: AudioSample) {
  const frames = sample.channels[0]?.frames;
  if (!frames?.length) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(frames.length / 256));
  let n = 0;
  for (let i = 0; i < frames.length; i += step) {
    const v = frames[i]!;
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / n);
}

/** Plays one file to the end. Resolves true when it finished, false if it failed or was stopped. */
function playFile(uri: string, onLevel?: (v: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let player: AudioPlayer | null = null;
    const subs: { remove: () => void }[] = [];
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      subs.forEach((s) => s.remove());
      try {
        player?.pause();
        player?.remove();
      } catch {}
      if (current?.player === player) current = null;
      onLevel?.(0);
      resolve(ok);
    };
    try {
      player = createAudioPlayer({ uri }, { updateInterval: 100 });
    } catch {
      finish(false);
      return;
    }
    current = { player, finish };
    timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    let armed = false;
    subs.push(
      player.addListener("playbackStatusUpdate", (s: AudioStatus) => {
        if (s.didJustFinish) return finish(true);
        if (!armed && s.isLoaded && s.duration > 0) {
          // Safety net in case the finish event is missed.
          armed = true;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish(true), (s.duration - s.currentTime) * 1000 + 1500);
        }
      }),
    );
    if (onLevel) {
      try {
        if (player.isAudioSamplingSupported) {
          player.setAudioSamplingEnabled(true);
          subs.push(player.addListener("audioSampleUpdate", (sample: AudioSample) => onLevel(Math.min(1, rms(sample) * 3.5))));
        }
      } catch {
        // No metering here: the orb keeps its built-in speaking animation.
      }
    }
    try {
      player.play();
    } catch {
      finish(false);
    }
  });
}

export type NaturalHandlers = {
  /** First audio starts. */
  onStart?: () => void;
  /** A chunk starts playing (for the echo filter). */
  onChunk?: (chunk: string) => void;
  onDone?: () => void;
  /** Fetch or playback failed; `remaining` is the text not yet spoken. */
  onError?: (error: unknown, remaining: string) => void;
  /** Output level 0..1 while playing, when the player exposes samples. */
  onLevel?: (v: number) => void;
};

/** Speaks `text` with the natural voice. Any previous natural playback is stopped. */
export function playNatural(text: string, voice: string, h: NaturalHandlers) {
  stopNatural();
  const my = gen;
  const alive = () => my === gen;
  void configureAudio().then(() =>
    playChunks(splitIntoChunks(text), {
      fetch: (chunk) => getClip(chunk, voice),
      play: (uri) => playFile(uri, h.onLevel),
      alive,
      onStart: h.onStart,
      onChunk: h.onChunk,
      onDone: h.onDone,
      onError: h.onError,
    }),
  );
}

/** Halts natural playback now. In-flight fetches are ignored (but still cached). */
export function stopNatural() {
  gen++;
  current?.finish(false);
  current = null;
}

/** Fetches clips into the cache (sequentially, to be gentle on the rate limit). */
export async function prefetchClips(texts: readonly string[], voice: string, pin = false) {
  for (const t of texts) await getClip(t, voice, pin);
}

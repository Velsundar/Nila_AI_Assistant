import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import {
  ApiError,
  DEFAULT_VOICE_STYLE,
  guessVoiceGender,
  INTERRUPT_ACKS,
  pickVoice,
  type NaturalVoicesResult,
  type VoiceStyle,
} from "@nova/shared";

import { api, errorMessage } from "@/lib/api";
import { isClipCached, playNatural, prefetchClips, stopNatural } from "@/lib/natural-voice";
import { naturalFailurePolicy } from "@/lib/speech-queue";

/**
 * Everything Nila says goes through `speak()` / `stop()` here, whichever engine runs:
 *
 *  - "device": the phone's voice via expo-speech. The user picks a style (female by default) and
 *    can pin an exact voice.
 *  - "natural": Groq Orpheus via `POST /api/speak` (lib/natural-voice.ts). On any error (any
 *    non-200: 503 TTS_UNAVAILABLE, 429 TTS_RATE_LIMITED/DAILY_LIMIT, 502 TTS_FAILED, 504 TTS_TIMEOUT,
 *    or network) the rest of that reply is finished with the device voice and a one-time notice is
 *    emitted. 429s keep the phone voice until `details.retryAfter` (or for the session).
 *
 * Prefs persist in SecureStore like the other prefs.
 */

const STYLE_KEY = "nova.voiceStyle";
const VOICE_KEY = "nova.voiceId";
const ENGINE_KEY = "nova.voiceEngine";
const NATURAL_VOICE_KEY = "nova.naturalVoice";
const LANG = "en-IN";

export type VoiceEngine = "device" | "natural";

type TtsState = {
  style: VoiceStyle;
  voiceId: string;
  voices: Speech.Voice[];
  engine: VoiceEngine;
  /** Saved natural voice id ("" = server default). */
  naturalVoice: string;
  /** Last GET /api/speak/voices answer (null = not checked yet this session). */
  natural: NaturalVoicesResult | null;
  naturalChecking: boolean;
  /** Couldn't reach the API to check. */
  naturalCheckError: string | null;
};

let state: TtsState = {
  style: DEFAULT_VOICE_STYLE,
  voiceId: "",
  voices: [],
  engine: "device",
  naturalVoice: "",
  natural: null,
  naturalChecking: false,
  naturalCheckError: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<TtsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

let loading: Promise<void> | null = null;
let prefsLoaded = false;

/** Loads prefs and the device's voice list. Android can return [] until its TTS engine is up, so an empty list is retried next time. */
function load(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const [style, voiceId, engine, naturalVoice, voices] = await Promise.all([
      SecureStore.getItemAsync(STYLE_KEY).catch(() => null),
      SecureStore.getItemAsync(VOICE_KEY).catch(() => null),
      SecureStore.getItemAsync(ENGINE_KEY).catch(() => null),
      SecureStore.getItemAsync(NATURAL_VOICE_KEY).catch(() => null),
      Speech.getAvailableVoicesAsync().catch(() => [] as Speech.Voice[]),
    ]);
    set({
      style: style === "female" || style === "male" || style === "any" ? style : DEFAULT_VOICE_STYLE,
      voiceId: voiceId ?? "",
      voices,
      ...(prefsLoaded ? {} : { engine: engine === "natural" ? "natural" : "device", naturalVoice: naturalVoice ?? "" }),
    });
    prefsLoaded = true;
    if (!voices.length) loading = null;
  })();
  return loading;
}
void load();

/** English voices on this device that match the style ("any" = all of them). */
export function voicesForStyle(voices: Speech.Voice[], style: VoiceStyle) {
  return voices
    .filter((v) => v.language.toLowerCase().startsWith("en"))
    .filter((v) => style === "any" || guessVoiceGender({ id: v.identifier, name: v.name }) === style);
}

/** The voice identifier to speak with, or undefined for the platform default. */
function resolveVoice(): string | undefined {
  const { style, voiceId, voices } = state;
  if (voiceId && voices.some((v) => v.identifier === voiceId)) return voiceId;
  const mapped = voices.map((v) => ({ id: v.identifier, name: v.name, lang: v.language, quality: v.quality }));
  return pickVoice(mapped, style, LANG)?.id;
}

// ---------- Natural voice availability ----------

/** Natural voice is skipped until this time (ms) after a failure; Infinity = for this app session. */
let naturalDownUntil = 0;
const noticesShown = new Set<string>();
const noticeListeners = new Set<(text: string) => void>();

function notice(kind: string, text: string) {
  if (noticesShown.has(kind)) return;
  noticesShown.add(kind);
  noticeListeners.forEach((l) => l(text));
}

/** Subscribe to one-time notices ("the natural voice failed, using the phone voice"). */
export function subscribeTtsNotice(fn: (text: string) => void) {
  noticeListeners.add(fn);
  return () => void noticeListeners.delete(fn);
}

/** Any non-200 or network error → this reply finishes with the phone voice; the policy says for how long after. */
function noteNaturalFailure(e: unknown) {
  const p = naturalFailurePolicy(e, Date.now(), errorMessage);
  naturalDownUntil = Math.max(naturalDownUntil, p.downUntil);
  notice(p.kind, p.text);
}

function naturalUsable() {
  return Platform.OS !== "web" && state.natural?.available !== false && Date.now() >= naturalDownUntil;
}

/** The engine the next reply will use. */
export function effectiveEngine(): VoiceEngine {
  return state.engine === "natural" && naturalUsable() ? "natural" : "device";
}

/** Saved natural voice if the server still offers it, else the server default. */
function naturalVoiceId(): string {
  const n = state.natural;
  if (n?.voices.length) return n.voices.some((v) => v.id === state.naturalVoice) ? state.naturalVoice : (n.defaultVoice ?? n.voices[0]!.id);
  return state.naturalVoice;
}

let checking: Promise<NaturalVoicesResult | null> | null = null;
/** GET /api/speak/voices (needs to be signed in). A success clears earlier failures. */
export function checkNaturalVoices(): Promise<NaturalVoicesResult | null> {
  if (checking) return checking;
  set({ naturalChecking: true, naturalCheckError: null });
  checking = api.voice
    .naturalVoices()
    .then((res) => {
      if (res.available) naturalDownUntil = 0;
      set({ natural: res, naturalChecking: false });
      return res;
    })
    .catch((e) => {
      set({ naturalChecking: false, naturalCheckError: errorMessage(e) });
      return null;
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

// ---------- speak / stop ----------

export type SpeakOptions = Speech.SpeechOptions & {
  /** Force an engine (Settings previews); default = the user's choice. */
  engine?: VoiceEngine;
  /** Natural voice id override. */
  naturalVoice?: string;
};

type Active = { id: number; opts: SpeakOptions; text: string; chunk: string };
let active: Active | null = null;
let nextJob = 1;
let levelSink: ((v: number) => void) | null = null;

/** Where the natural player's output level goes (the orb). Only when metering exists. */
export function setSpeakingLevelSink(fn: ((v: number) => void) | null) {
  levelSink = fn;
}

/** What Nila is saying right now: [current chunk, whole utterance] (for the barge-in echo filter). */
export function getSpokenText(): string[] {
  return active ? [active.chunk, active.text].filter(Boolean) : [];
}

export function isSpeakingNow() {
  return !!active;
}

const isMine = (id: number) => active?.id === id;

function speakDevice(id: number, text: string, o: SpeakOptions) {
  const { engine: _e, naturalVoice: _n, onStart, onDone, onStopped, onError, ...rest } = o;
  const go = () => {
    if (!isMine(id)) return;
    Speech.speak(text, {
      language: LANG,
      ...rest,
      voice: rest.voice ?? resolveVoice(),
      onStart: () => {
        if (isMine(id)) onStart?.();
      },
      onDone: () => {
        if (!isMine(id)) return;
        active = null;
        onDone?.();
      },
      onStopped: () => {
        // stop() reports onStopped itself; this is only for stops from elsewhere.
        if (!isMine(id)) return;
        active = null;
        onStopped?.();
      },
      onError: (err) => {
        if (!isMine(id)) return;
        active = null;
        onError?.(err);
      },
    });
  };
  // Voices normally load at startup; if not yet, wait briefly rather than speak in the wrong voice.
  if (state.voices.length) go();
  else void Promise.race([load(), new Promise((r) => setTimeout(r, 800))]).then(go);
}

function speakNatural(id: number, text: string, o: SpeakOptions) {
  playNatural(text, o.naturalVoice ?? naturalVoiceId(), {
    onStart: () => {
      if (isMine(id)) o.onStart?.();
    },
    onChunk: (c) => {
      if (active?.id === id) active.chunk = c;
    },
    onLevel: (v) => {
      if (isMine(id)) levelSink?.(v);
    },
    onDone: () => {
      if (!isMine(id)) return;
      active = null;
      levelSink?.(0);
      o.onDone?.();
    },
    onError: (e, remaining) => {
      if (!isMine(id)) return;
      levelSink?.(0);
      noteNaturalFailure(e);
      // Finish this reply with the phone voice.
      speakDevice(id, remaining, { ...o, onStart: undefined });
    },
  });
}

/** Speak with the user's engine and voice. Stops anything already playing. */
export function speak(text: string, options: SpeakOptions = {}) {
  stop();
  if (!text.trim()) return;
  const id = nextJob++;
  active = { id, opts: options, text, chunk: "" };
  // An explicit device voice (Settings preview) always means the device engine.
  const engine = options.engine ?? (options.voice ? "device" : effectiveEngine());
  if (engine === "natural") speakNatural(id, text, options);
  else speakDevice(id, text, options);
}

/** Halt all speech immediately (phone voice and natural-voice queue). Fires the active onStopped. */
export function stop() {
  const a = active;
  active = null;
  stopNatural();
  void Speech.stop();
  levelSink?.(0);
  a?.opts.onStopped?.();
}

// ---------- Interrupt acknowledgements ----------

let ackIndex = 0;
let ackPrefetchedFor: string | null = null;

/**
 * Plays the next short acknowledgement ("Mm-hmm.", "Okay."...). Uses the cached natural clip when
 * one is ready (instant), otherwise the phone voice. `onEnd` runs once it finishes or is cut off.
 */
export function playAck(onEnd?: () => void) {
  const text = INTERRUPT_ACKS[ackIndex++ % INTERRUPT_ACKS.length]!;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd?.();
  };
  const natural = effectiveEngine() === "natural" && isClipCached(text, naturalVoiceId());
  speak(text, { engine: natural ? "natural" : "device", rate: 1.05, onDone: end, onStopped: end, onError: end });
  if (!natural && effectiveEngine() === "natural") void prefetchAcks();
}

/** Caches the ack clips for the natural voice (pinned; never evicted). Safe to call often. */
export async function prefetchAcks() {
  if (effectiveEngine() !== "natural") return;
  const voice = naturalVoiceId();
  if (ackPrefetchedFor === voice) return;
  // Persisted across restarts in the file cache: only missing clips cost a request.
  if (INTERRUPT_ACKS.every((t) => isClipCached(t, voice))) {
    ackPrefetchedFor = voice;
    return;
  }
  ackPrefetchedFor = voice;
  try {
    await prefetchClips(INTERRUPT_ACKS, voice, true);
  } catch (e) {
    ackPrefetchedFor = null;
    if (e instanceof ApiError && (e.status === 503 || e.status === 429)) noteNaturalFailure(e);
  }
}

/**
 * Assistant screen focus: when the natural voice is selected, check it's available (once per
 * session; needs auth, so never at import time) and make sure the ack clips are cached.
 */
export async function prepareNaturalVoice() {
  await load();
  if (state.engine !== "natural") return;
  if (!state.natural) await checkNaturalVoices();
  await prefetchAcks();
}

// ---------- Settings hook ----------

export function useTtsVoice() {
  const [snap, setSnap] = useState(state);
  useEffect(() => {
    const l = () => setSnap(state);
    listeners.add(l);
    l();
    void load();
    return () => void listeners.delete(l);
  }, []);

  const setStyle = useCallback((style: VoiceStyle) => {
    set({ style, voiceId: "" });
    void SecureStore.setItemAsync(STYLE_KEY, style).catch(() => {});
    void SecureStore.deleteItemAsync(VOICE_KEY).catch(() => {});
  }, []);

  const setVoiceId = useCallback((voiceId: string) => {
    set({ voiceId });
    void SecureStore.setItemAsync(VOICE_KEY, voiceId).catch(() => {});
  }, []);

  const setEngine = useCallback((engine: VoiceEngine) => {
    set({ engine });
    void SecureStore.setItemAsync(ENGINE_KEY, engine).catch(() => {});
  }, []);

  const setNaturalVoice = useCallback((naturalVoice: string) => {
    set({ naturalVoice });
    void SecureStore.setItemAsync(NATURAL_VOICE_KEY, naturalVoice).catch(() => {});
  }, []);

  const current = snap.voices.find((v) => v.identifier === resolveVoice());
  return {
    ...snap,
    current,
    /** The natural voice id in use (saved, or the server default). */
    naturalVoiceId: naturalVoiceId(),
    setStyle,
    setVoiceId,
    setEngine,
    setNaturalVoice,
    checkNaturalVoices,
  };
}

/** One-time notices from the speech engine, for a banner. */
export function useTtsNotice() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => subscribeTtsNotice(setText), []);
  return [text, setText] as const;
}

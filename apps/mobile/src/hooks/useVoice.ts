import { requireOptionalNativeModule } from "expo";
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { ApiError } from "@nova/shared";

import { api, errorMessage } from "@/lib/api";
import { matchWakeWord } from "@/lib/wake";

/**
 * Voice I/O for the assistant — all free:
 *
 * Speech-to-text, best option first:
 *  1. "native": `expo-speech-recognition` (the phone's own recognizer, live interim text). Needs a
 *     dev build — it is NOT in Expo Go, so it's feature-detected and never imported eagerly.
 *  2. "server": record m4a with `expo-audio` (works in Expo Go), send it as a base64 data URL to
 *     `POST /api/transcribe` (the API's free Groq Whisper tier). If the server answers
 *     503 STT_UNAVAILABLE we drop to text mode with a notice.
 *  3. "none": text input only.
 *
 * Text-to-speech: `expo-speech` (works everywhere).
 *
 * Wake word ("Hey <name>"): optional, native recognizer only (continuous listening isn't
 * possible over the server path). Runs short recognition sessions back-to-back while `active`,
 * the app is in the foreground and nothing else is using the mic/speaker.
 */

type SRModule = typeof import("expo-speech-recognition").ExpoSpeechRecognitionModule;
type Subscription = { remove: () => void };

let cachedModule: SRModule | null | undefined;

/** Returns the speech-recognition module, or null when its native side is missing (e.g. Expo Go). */
function getRecognizer(): SRModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Check for the native module first: requiring the JS package in Expo Go would throw.
    if (Platform.OS !== "web" && !requireOptionalNativeModule("ExpoSpeechRecognition")) {
      cachedModule = null;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("expo-speech-recognition") as typeof import("expo-speech-recognition");
      cachedModule = mod.ExpoSpeechRecognitionModule ?? null;
    }
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

function recognizerUsable(mod: SRModule | null): boolean {
  if (!mod) return false;
  try {
    return mod.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/** expo-audio ships in Expo Go and in any dev build made after it was added. */
function recorderUsable(): boolean {
  return Platform.OS !== "web" && !!requireOptionalNativeModule("ExpoAudio");
}

/** Set (for this app session) once the server says it has no STT configured. */
let serverSttDown = false;

export type VoiceMode = "native" | "server" | "none";

/** Which speech-to-text path this device will use. Cheap; usable outside the hook (Settings). */
export function getVoiceMode(): VoiceMode {
  if (recognizerUsable(getRecognizer())) return "native";
  if (recorderUsable() && !serverSttDown) return "server";
  return "none";
}

/** True when the native recognizer is present, i.e. the wake word can work (dev builds only). */
export function isWakeWordSupported(): boolean {
  return recognizerUsable(getRecognizer());
}

/** Kept for existing callers. */
export function isVoiceInputAvailable(): boolean {
  return getVoiceMode() !== "none";
}

export const VOICE_MODE_LABEL: Record<VoiceMode, string> = {
  native: "On-device speech recognition",
  server: "Server speech-to-text (record → /api/transcribe)",
  none: "Unavailable — text only",
};

const BENIGN_ERRORS = new Set(["aborted", "no-speech", "speech-timeout", "nomatch"]);

/** Mono AAC in an .m4a container — small (~16 KB/s) and accepted by Whisper. */
const RECORDING_OPTIONS: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 64000 },
};

const MAX_RECORDING_MS = 30_000;
const MIN_RECORDING_MS = 450;

export type WakeWordOptions = {
  /** User setting. */
  enabled: boolean;
  /** The screen wants it right now (focused, not busy). AppState is handled inside the hook. */
  active: boolean;
  /** The name to listen for, e.g. "Nova". */
  name: string;
  /** "Hey Nova, <command>" in one utterance. */
  onCommand: (command: string) => void;
  /** Just "Hey Nova": the hook starts a normal listening turn by itself; this is for UI feedback. */
  onWake?: () => void;
};

export type UseVoiceOptions = {
  /** Called once per utterance with the final transcript (not called if cancelled or empty). */
  onFinalTranscript: (text: string) => void;
  lang?: string;
  wakeWord?: WakeWordOptions;
};

type SessionKind = "ptt" | "wake" | null;

export function useVoice({ onFinalTranscript, lang = "en-IN", wakeWord }: UseVoiceOptions) {
  const [recognizer] = useState(getRecognizer);
  const [mode, setMode] = useState<VoiceMode>(getVoiceMode);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Wake-word listener is currently running (for a subtle UI indicator). */
  const [wakeListening, setWakeListening] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  /** Normalised mic level 0..1, written from native events / recorder metering, read by the orb on the UI thread. */
  const volume = useSharedValue(0);

  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const wakeRef = useRef(wakeWord);
  wakeRef.current = wakeWord;
  const finalTextRef = useRef("");
  const latestTextRef = useRef("");
  const cancelledRef = useRef(false);
  const sessionRef = useRef<SessionKind>(null);
  const permissionGrantedRef = useRef(false);
  const recordingRef = useRef(false);
  /** Recorder is between "start requested" and "recording" (permission prompt, prepare). */
  const startingRef = useRef(false);
  /** The user released / tapped stop while we were still starting. */
  const stopWhileStartingRef = useRef(false);
  const meterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordStartedAt = useRef(0);
  const mountedRef = useRef(true);
  /** Set when "Hey Nova" (no command) was heard: start a normal turn once the wake session ends. */
  const startPttAfterWake = useRef(false);
  const startListeningRef = useRef<() => Promise<boolean>>(async () => false);
  const wakeStartedAt = useRef(0);
  const wakeFailures = useRef(0);
  const [wakeTick, setWakeTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);

  const ensureNativePermission = useCallback(async () => {
    if (!recognizer) return false;
    if (permissionGrantedRef.current) return true;
    try {
      const perm = await recognizer.requestPermissionsAsync();
      permissionGrantedRef.current = perm.granted;
    } catch {
      permissionGrantedRef.current = false;
    }
    return permissionGrantedRef.current;
  }, [recognizer]);

  // ---------- Native recognizer events (only when the module exists) ----------
  useEffect(() => {
    if (!recognizer) return;
    const subs: Subscription[] = [];
    const on = (event: Parameters<SRModule["addListener"]>[0], fn: (ev: never) => void) => {
      try {
        subs.push(recognizer.addListener(event, fn as never) as Subscription);
      } catch {
        // ignore — older native side without this event
      }
    };

    on("start", () => {
      if (sessionRef.current === "ptt") setListening(true);
      else if (sessionRef.current === "wake") setWakeListening(true);
    });
    on("result", (ev: { isFinal: boolean; results: { transcript: string }[] }) => {
      const text = ev.results?.[0]?.transcript?.trim() ?? "";
      if (!text) return;
      if (sessionRef.current === "wake") {
        if (!ev.isFinal) {
          // Cheap early exit: as soon as the bare wake word is heard, keep listening for the command
          // within the same utterance (the final result will carry it).
          return;
        }
        const w = wakeRef.current;
        if (!w) return;
        const m = matchWakeWord(text, w.name);
        if (!m.matched) return;
        if (m.command.length >= 2) {
          w.onCommand(m.command);
        } else {
          startPttAfterWake.current = true;
          w.onWake?.();
        }
        try {
          recognizer.abort();
        } catch {}
        return;
      }
      latestTextRef.current = text;
      if (ev.isFinal) finalTextRef.current = text;
      setInterim(text);
    });
    on("volumechange", (ev: { value: number }) => {
      if (sessionRef.current !== "ptt") return;
      // Native range is -2..10; anything below 0 is inaudible.
      volume.value = Math.min(1, Math.max(0, ev.value / 10));
    });
    on("error", (ev: { error: string; message: string }) => {
      if (sessionRef.current === "wake" || BENIGN_ERRORS.has(ev.error)) return;
      if (ev.error === "not-allowed") setError("Microphone / speech permission was denied. Enable it in Settings.");
      else if (ev.error === "network") setError("Speech recognition needs a connection on this device. Try again or type.");
      else if (ev.error === "language-not-supported") setError(`Speech recognition doesn't support ${lang} here.`);
      else setError(ev.message || "Speech recognition failed. Try again or type.");
    });
    on("end", () => {
      const kind = sessionRef.current;
      sessionRef.current = null;
      if (kind === "wake") {
        setWakeListening(false);
        // Sessions that die instantly (busy recognizer, no service) back off exponentially.
        if (Date.now() - wakeStartedAt.current < 1000) wakeFailures.current = Math.min(wakeFailures.current + 1, 5);
        else wakeFailures.current = 0;
        if (startPttAfterWake.current) {
          startPttAfterWake.current = false;
          setTimeout(() => void startListeningRef.current(), 150);
        } else {
          setWakeTick((n) => n + 1); // loop: start the next wake session
        }
        return;
      }
      setListening(false);
      volume.value = 0;
      const text = (finalTextRef.current || latestTextRef.current).trim();
      const cancelled = cancelledRef.current;
      finalTextRef.current = "";
      latestTextRef.current = "";
      cancelledRef.current = false;
      setInterim("");
      if (!cancelled && text) onFinalRef.current(text);
    });

    return () => {
      subs.forEach((s) => s.remove());
      if (sessionRef.current) {
        try {
          recognizer.abort();
        } catch {}
      }
      // The "end" listener is gone, so reset here or startListening would think a session is still live.
      sessionRef.current = null;
      startPttAfterWake.current = false;
      finalTextRef.current = "";
      latestTextRef.current = "";
      cancelledRef.current = false;
      volume.value = 0;
      setListening(false);
      setWakeListening(false);
      setInterim("");
    };
  }, [recognizer, lang, volume]);

  // ---------- Server path: expo-audio recorder ----------
  const clearRecorderTimers = useCallback(() => {
    if (meterTimer.current) clearInterval(meterTimer.current);
    if (maxTimer.current) clearTimeout(maxTimer.current);
    meterTimer.current = null;
    maxTimer.current = null;
  }, []);

  const releaseAudioSession = useCallback(() => {
    // Back to playback mode so TTS uses the loudspeaker (iOS routes to the earpiece while recording is allowed).
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  const stopRecording = useCallback(
    async (send: boolean) => {
      if (!recordingRef.current) return;
      recordingRef.current = false;
      clearRecorderTimers();
      volume.value = 0;
      const duration = Date.now() - recordStartedAt.current;
      try {
        await recorder.stop();
      } catch {}
      releaseAudioSession();
      setListening(false);
      const uri = recorder.uri;
      const cleanup = () => {
        if (!uri) return;
        try {
          const f = new File(uri);
          if (f.exists) f.delete();
        } catch {}
      };
      if (!send || !uri) {
        cleanup();
        return;
      }
      if (duration < MIN_RECORDING_MS) {
        cleanup();
        setError("Too short — hold the mic while you speak, or tap once to start and again to send.");
        return;
      }
      setTranscribing(true);
      try {
        const b64 = await new File(uri).base64();
        const { text } = await api.voice.transcribe({ audio: `data:audio/m4a;base64,${b64}`, language: lang.slice(0, 2) });
        if (!mountedRef.current) return;
        const t = text.trim();
        if (t) onFinalRef.current(t);
        else setError("I didn't catch that. Try again a little closer to the mic, or type.");
      } catch (e) {
        if (!mountedRef.current) return;
        if (e instanceof ApiError && (e.code === "STT_UNAVAILABLE" || e.status === 503)) {
          serverSttDown = true;
          setMode(getVoiceMode());
          setError("Server speech-to-text isn't available right now, so voice is off. Type your message below.");
        } else {
          setError(`Couldn't transcribe: ${errorMessage(e)}`);
        }
      } finally {
        cleanup();
        if (mountedRef.current) setTranscribing(false);
      }
    },
    [recorder, lang, volume, clearRecorderTimers, releaseAudioSession],
  );

  const startRecording = useCallback(async () => {
    if (recordingRef.current || startingRef.current) return true;
    startingRef.current = true;
    stopWhileStartingRef.current = false;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        startingRef.current = false;
        setError("Microphone permission was denied. Enable it in your phone's Settings, or type instead.");
        return false;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      recordStartedAt.current = Date.now();
      setListening(true);
      meterTimer.current = setInterval(() => {
        try {
          const db = recorder.getStatus().metering;
          // dBFS: about -60 (quiet room) .. 0 (very loud).
          if (typeof db === "number") volume.value = Math.min(1, Math.max(0, (db + 55) / 50));
        } catch {}
      }, 80);
      maxTimer.current = setTimeout(() => void stopRecording(true), MAX_RECORDING_MS);
      startingRef.current = false;
      if (stopWhileStartingRef.current) {
        // Released before the mic was even live (e.g. during the first permission prompt): nothing to send.
        stopWhileStartingRef.current = false;
        void stopRecording(false);
        return false;
      }
      return true;
    } catch (e) {
      startingRef.current = false;
      recordingRef.current = false;
      clearRecorderTimers();
      releaseAudioSession();
      setListening(false);
      setError(e instanceof Error ? `Couldn't start the microphone: ${e.message}` : "Couldn't start the microphone.");
      return false;
    }
  }, [recorder, volume, stopRecording, clearRecorderTimers, releaseAudioSession]);

  // Release the mic if the screen unmounts mid-recording.
  useEffect(
    () => () => {
      if (recordingRef.current) void stopRecording(false);
    },
    [stopRecording],
  );

  // Stop any speech when the screen using the hook unmounts.
  useEffect(() => () => void Speech.stop(), []);

  const stopSpeaking = useCallback(() => {
    void Speech.stop();
    setSpeaking(false);
  }, []);

  const abortWake = useCallback(() => {
    if (recognizer && sessionRef.current === "wake") {
      startPttAfterWake.current = false;
      try {
        recognizer.abort();
      } catch {}
    }
  }, [recognizer]);

  const startListening = useCallback(async () => {
    setError(null);
    // Barge-in: the user talking always wins over TTS.
    stopSpeaking();

    if (mode === "server") return startRecording();

    if (mode === "none" || !recognizer) {
      setError(
        serverSttDown
          ? "Voice input is unavailable (no on-device recognizer and the server has no speech-to-text). Type below."
          : "Voice input isn't available on this device. You can type below.",
      );
      return false;
    }
    if (sessionRef.current === "ptt") return true;
    if (sessionRef.current === "wake") {
      // Hand the mic over from the wake listener to a real turn.
      try {
        recognizer.abort();
      } catch {}
      sessionRef.current = null;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!(await ensureNativePermission())) {
      setError("Microphone / speech permission was denied. Enable it in Settings.");
      return false;
    }
    finalTextRef.current = "";
    latestTextRef.current = "";
    cancelledRef.current = false;
    setInterim("");
    try {
      sessionRef.current = "ptt";
      recognizer.start({
        lang,
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        maxAlternatives: 1,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
      });
      setListening(true);
      return true;
    } catch (e) {
      sessionRef.current = null;
      setError(e instanceof Error ? e.message : "Couldn't start the microphone.");
      return false;
    }
  }, [mode, recognizer, lang, stopSpeaking, startRecording, ensureNativePermission]);
  startListeningRef.current = startListening;

  /** Finish the utterance; the final transcript is delivered via onFinalTranscript. */
  const stopListening = useCallback(() => {
    if (startingRef.current) {
      stopWhileStartingRef.current = true;
      return;
    }
    if (recordingRef.current) {
      void stopRecording(true);
      return;
    }
    if (!recognizer || sessionRef.current !== "ptt") return;
    try {
      recognizer.stop();
    } catch {}
  }, [recognizer, stopRecording]);

  /** Abort without sending anything. */
  const cancelListening = useCallback(() => {
    if (startingRef.current) {
      stopWhileStartingRef.current = true;
      return;
    }
    if (recordingRef.current) {
      void stopRecording(false);
      return;
    }
    if (!recognizer || sessionRef.current !== "ptt") return;
    cancelledRef.current = true;
    try {
      recognizer.abort();
    } catch {}
  }, [recognizer, stopRecording]);

  const speak = useCallback(
    (text: string, opts?: { onDone?: () => void }) => {
      if (!text.trim()) return;
      void Speech.stop();
      setSpeaking(true);
      const done = () => {
        setSpeaking(false);
        opts?.onDone?.();
      };
      Speech.speak(text, {
        language: lang,
        rate: 1.0,
        pitch: 1.0,
        onStart: () => setSpeaking(true),
        onDone: done,
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      });
    },
    [lang],
  );

  // ---------- Wake word loop ----------
  const wakeWanted =
    !!wakeWord?.enabled &&
    wakeWord.active &&
    appActive &&
    mode === "native" &&
    !listening &&
    !transcribing &&
    !speaking;
  const wakeName = wakeWord?.name ?? "";

  useEffect(() => {
    if (!recognizer) return;
    if (!wakeWanted) {
      abortWake();
      return;
    }
    if (sessionRef.current) return; // a session is running; "end" bumps the tick to restart
    let cancelled = false;
    const delay = Math.min(5000, 250 * 2 ** wakeFailures.current);
    const t = setTimeout(async () => {
      if (cancelled || sessionRef.current) return;
      if (!(await ensureNativePermission())) return;
      if (cancelled || sessionRef.current) return;
      try {
        sessionRef.current = "wake";
        wakeStartedAt.current = Date.now();
        recognizer.start({
          lang,
          interimResults: true,
          continuous: false,
          addsPunctuation: false,
          maxAlternatives: 1,
          contextualStrings: [wakeName, `hey ${wakeName}`],
        });
      } catch {
        sessionRef.current = null;
        wakeFailures.current = Math.min(wakeFailures.current + 1, 5);
        setWakeTick((n) => n + 1);
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [recognizer, wakeWanted, wakeName, lang, wakeTick, abortWake, ensureNativePermission]);

  // Stop it immediately on blur/background (the effect above also aborts, this is belt and braces).
  useEffect(() => {
    if (!appActive) abortWake();
  }, [appActive, abortWake]);

  const clearError = useCallback(() => setError(null), []);

  return {
    /** Which STT path is in use. */
    mode,
    /** True when any voice input works (native or server). */
    available: mode !== "none",
    listening,
    /** Server path: audio is being uploaded / transcribed. */
    transcribing,
    speaking,
    interim,
    volume,
    error,
    clearError,
    /** Wake-word listener is running. */
    wakeListening,
    startListening,
    stopListening,
    cancelListening,
    speak,
    stopSpeaking,
  };
}

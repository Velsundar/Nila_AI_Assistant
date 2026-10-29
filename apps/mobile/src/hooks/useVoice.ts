import { requireOptionalNativeModule } from "expo";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";

/**
 * Voice I/O for the assistant — 100% on-device / free:
 *  - Speech-to-text: `expo-speech-recognition` (the phone's native recognizer). Needs a dev build;
 *    it is NOT in Expo Go, so we feature-detect at runtime and never import it eagerly.
 *  - Text-to-speech: `expo-speech` (works everywhere, including Expo Go).
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

/** Cheap check usable outside the hook (e.g. Settings diagnostics). */
export function isVoiceInputAvailable(): boolean {
  return recognizerUsable(getRecognizer());
}

const BENIGN_ERRORS = new Set(["aborted", "no-speech", "speech-timeout", "nomatch"]);

export type UseVoiceOptions = {
  /** Called once per utterance with the final transcript (not called if cancelled or empty). */
  onFinalTranscript: (text: string) => void;
  lang?: string;
};

export function useVoice({ onFinalTranscript, lang = "en-IN" }: UseVoiceOptions) {
  const [recognizer] = useState(getRecognizer);
  const [available] = useState(() => recognizerUsable(recognizer));
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Normalised mic level 0..1, written from native events and read on the UI thread by the orb. */
  const volume = useSharedValue(0);

  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const finalTextRef = useRef("");
  const latestTextRef = useRef("");
  const cancelledRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const permissionGrantedRef = useRef(false);

  // Native event wiring (only when the module exists).
  useEffect(() => {
    if (!recognizer) return;
    const subs: Subscription[] = [];
    const on = <E extends Parameters<SRModule["addListener"]>[0]>(
      event: E,
      fn: Parameters<SRModule["addListener"]>[1],
    ) => {
      try {
        subs.push(recognizer.addListener(event, fn as never) as Subscription);
      } catch {
        // ignore — older native side without this event
      }
    };

    on("start", (() => setListening(true)) as never);
    on("result", ((ev: { isFinal: boolean; results: { transcript: string }[] }) => {
      const text = ev.results?.[0]?.transcript?.trim() ?? "";
      if (!text) return;
      latestTextRef.current = text;
      if (ev.isFinal) finalTextRef.current = text;
      setInterim(text);
    }) as never);
    on("volumechange", ((ev: { value: number }) => {
      // Native range is -2..10; anything below 0 is inaudible.
      volume.value = Math.min(1, Math.max(0, ev.value / 10));
    }) as never);
    on("error", ((ev: { error: string; message: string }) => {
      if (BENIGN_ERRORS.has(ev.error)) return;
      if (ev.error === "not-allowed") setError("Microphone / speech permission was denied. Enable it in Settings.");
      else if (ev.error === "network") setError("Speech recognition needs a connection on this device. Try again or type.");
      else if (ev.error === "language-not-supported") setError(`Speech recognition doesn't support ${lang} here.`);
      else setError(ev.message || "Speech recognition failed. Try again or type.");
    }) as never);
    on("end", (() => {
      sessionActiveRef.current = false;
      setListening(false);
      volume.value = 0;
      const text = (finalTextRef.current || latestTextRef.current).trim();
      const cancelled = cancelledRef.current;
      finalTextRef.current = "";
      latestTextRef.current = "";
      cancelledRef.current = false;
      setInterim("");
      if (!cancelled && text) onFinalRef.current(text);
    }) as never);

    return () => {
      subs.forEach((s) => s.remove());
      if (sessionActiveRef.current) {
        try {
          recognizer.abort();
        } catch {}
      }
    };
  }, [recognizer, lang, volume]);

  // Stop any speech when the screen using the hook unmounts.
  useEffect(() => () => void Speech.stop(), []);

  const stopSpeaking = useCallback(() => {
    void Speech.stop();
    setSpeaking(false);
  }, []);

  const startListening = useCallback(async () => {
    setError(null);
    if (!recognizer || !available) {
      setError("Voice input needs a development build. You can type to Nova below.");
      return false;
    }
    // Barge-in: the user talking always wins over TTS.
    stopSpeaking();
    if (sessionActiveRef.current) return true;
    if (!permissionGrantedRef.current) {
      try {
        const perm = await recognizer.requestPermissionsAsync();
        permissionGrantedRef.current = perm.granted;
      } catch {
        permissionGrantedRef.current = false;
      }
      if (!permissionGrantedRef.current) {
        setError("Microphone / speech permission was denied. Enable it in Settings.");
        return false;
      }
    }
    finalTextRef.current = "";
    latestTextRef.current = "";
    cancelledRef.current = false;
    setInterim("");
    try {
      recognizer.start({
        lang,
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        maxAlternatives: 1,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
      });
      sessionActiveRef.current = true;
      setListening(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the microphone.");
      return false;
    }
  }, [recognizer, available, lang, stopSpeaking]);

  /** Finish the utterance; the final transcript is delivered via onFinalTranscript. */
  const stopListening = useCallback(() => {
    if (!recognizer || !sessionActiveRef.current) return;
    try {
      recognizer.stop();
    } catch {}
  }, [recognizer]);

  /** Abort without sending anything. */
  const cancelListening = useCallback(() => {
    if (!recognizer || !sessionActiveRef.current) return;
    cancelledRef.current = true;
    try {
      recognizer.abort();
    } catch {}
  }, [recognizer]);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      void Speech.stop();
      setSpeaking(true);
      Speech.speak(text, {
        language: lang,
        rate: 1.0,
        pitch: 1.0,
        onStart: () => setSpeaking(true),
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      });
    },
    [lang],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    /** True when native speech-to-text can be used (dev build with a recognizer on the device). */
    available,
    listening,
    speaking,
    interim,
    volume,
    error,
    clearError,
    startListening,
    stopListening,
    cancelListening,
    speak,
    stopSpeaking,
  };
}

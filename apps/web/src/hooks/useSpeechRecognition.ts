"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Minimal Web Speech API typings (not in TypeScript's DOM lib). */
type SRAlternative = { transcript: string; confidence: number };
type SRResult = { isFinal: boolean; length: number; [i: number]: SRAlternative };
export type SRResultEvent = Event & { resultIndex: number; results: { length: number; [i: number]: SRResult } };
export type SRErrorEvent = Event & { error: string; message?: string };
export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onresult: ((e: SRResultEvent) => void) | null;
  onspeechstart: ((e: Event) => void) | null;
}
type SRConstructor = new () => SpeechRecognitionLike;

export function getCtor(): SRConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type RecognitionError =
  | "not-allowed" // mic permission denied / blocked by policy
  | "no-speech"
  | "audio-capture" // no microphone
  | "network" // the browser's speech service is unreachable
  | "aborted"
  | "unknown";

export type UseSpeechRecognitionOptions = {
  lang?: string;
  /** Called once per listening session with the final transcript (if anything was heard). */
  onFinal?: (transcript: string) => void;
  /** Called when the user actually starts speaking (e.g. to cancel TTS). */
  onSpeechStart?: () => void;
  /** Auto-stop after this much silence once something has been heard (ms). 0 disables. */
  silenceMs?: number;
};

/**
 * Browser speech-to-text via the Web Speech API (Chrome/Edge/Safari; not Firefox).
 * `supported` is null until mounted (so SSR markup is stable), then true/false.
 */
export function useSpeechRecognition({ lang = "en-IN", onFinal, onSpeechStart, silenceMs = 1800 }: UseSpeechRecognitionOptions = {}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<RecognitionError | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cbRef = useRef({ onFinal, onSpeechStart });
  cbRef.current = { onFinal, onSpeechStart };

  useEffect(() => {
    setSupported(getCtor() !== null);
    // Tab hidden mid-turn: drop the session (and its mic) rather than leave it dangling.
    const onVis = () => {
      if (document.visibilityState !== "hidden" || !recRef.current) return;
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      finalRef.current = interimRef.current = "";
      try {
        recRef.current.abort();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      const rec = recRef.current;
      if (rec) {
        rec.onend = rec.onresult = rec.onerror = rec.onstart = rec.onspeechstart = null;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const clearSilence = () => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = null;
  };

  const stop = useCallback(() => {
    clearSilence();
    try {
      recRef.current?.stop();
    } catch {
      /* not started */
    }
  }, []);

  const abort = useCallback(() => {
    clearSilence();
    finalRef.current = "";
    interimRef.current = "";
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setSupported(false);
      return false;
    }
    // Tear down any previous session first.
    if (recRef.current) {
      recRef.current.onend = recRef.current.onresult = recRef.current.onerror = null;
      try {
        recRef.current.abort();
      } catch {
        /* ignore */
      }
    }
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true; // keep listening through short pauses; we stop on release / silence
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    finalRef.current = "";
    interimRef.current = "";
    setInterim("");
    setError(null);

    rec.onstart = () => setListening(true);
    rec.onspeechstart = () => cbRef.current.onSpeechStart?.();
    rec.onresult = (e) => {
      let fin = "";
      let int = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else int += r[0].transcript;
      }
      finalRef.current = fin;
      interimRef.current = int;
      setInterim((fin + " " + int).trim());
      if (silenceMs > 0) {
        clearSilence();
        silenceTimer.current = setTimeout(() => {
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
        }, silenceMs);
      }
    };
    rec.onerror = (e) => {
      const known: RecognitionError[] = ["not-allowed", "no-speech", "audio-capture", "network", "aborted"];
      const code = e.error === "service-not-allowed" ? "not-allowed" : (known.find((k) => k === e.error) ?? "unknown");
      if (code !== "aborted") setError(code);
    };
    rec.onend = () => {
      clearSilence();
      setListening(false);
      // Chrome sometimes ends before promoting the last interim chunk to final — use it.
      const text = (finalRef.current + " " + interimRef.current).replace(/\s+/g, " ").trim();
      finalRef.current = "";
      interimRef.current = "";
      setInterim("");
      if (recRef.current === rec) recRef.current = null;
      if (text) cbRef.current.onFinal?.(text);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      return true;
    } catch {
      setError("unknown");
      setListening(false);
      return false;
    }
  }, [lang, silenceMs]);

  return { supported, listening, interim, error, start, stop, abort, clearError: () => setError(null) };
}

"use client";

import { DEFAULT_VOICE_STYLE, type VoiceStyle } from "@nova/shared";
import { useCallback, useEffect, useState } from "react";

export type VoicePrefs = {
  /** SpeechSynthesisVoice.voiceURI, or "" for the browser default. */
  voiceURI: string;
  /** Female/male/any; picks a matching voice when voiceURI is "". */
  voiceStyle: VoiceStyle;
  rate: number;
  /** Speak replies aloud. */
  speak: boolean;
  /** BCP-47 language for speech recognition. */
  lang: string;
  /** Listen for "Hey <assistantName>" in the background while the assistant page is open (Chrome/Edge). */
  wakeWord: boolean;
  /** Speak the daily briefing the first time the assistant opens each day. */
  autoBriefing: boolean;
  /** "device" = browser speechSynthesis (default); "natural" = server AI voice (Groq Orpheus), falls back to device. */
  engine: VoiceEngine;
  /** Natural voice id from GET /api/speak/voices, or "" for the server default. */
  naturalVoice: string;
  /** While Nova is speaking, keep listening so the user can interrupt by talking (Chrome/Edge). */
  bargeIn: boolean;
};

export type VoiceEngine = "device" | "natural";

const KEY = "nova.voicePrefs";
export const DEFAULT_PREFS: VoicePrefs = { voiceURI: "", voiceStyle: DEFAULT_VOICE_STYLE, rate: 1, speak: true, lang: "en-IN", wakeWord: false, autoBriefing: false, engine: "device", naturalVoice: "", bargeIn: true };
const EVENT = "nova:prefs";

/** Current prefs straight from localStorage (client only). */
export function readVoicePrefs(): VoicePrefs {
  return read();
}

function read(): VoicePrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<VoicePrefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Per-browser voice preferences (localStorage), synced across components and tabs. */
export function useVoicePrefs() {
  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULT_PREFS);

  useEffect(() => {
    setPrefs(read());
    const sync = () => setPrefs(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<VoicePrefs>) => {
    const next = { ...read(), ...patch };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: keep in memory only */
    }
    setPrefs(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [prefs, update] as const;
}

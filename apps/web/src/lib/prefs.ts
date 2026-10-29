"use client";

import { useCallback, useEffect, useState } from "react";

export type VoicePrefs = {
  /** SpeechSynthesisVoice.voiceURI, or "" for the browser default. */
  voiceURI: string;
  rate: number;
  /** Speak replies aloud. */
  speak: boolean;
  /** BCP-47 language for speech recognition. */
  lang: string;
};

const KEY = "nova.voicePrefs";
export const DEFAULT_PREFS: VoicePrefs = { voiceURI: "", rate: 1, speak: true, lang: "en-IN" };
const EVENT = "nova:prefs";

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

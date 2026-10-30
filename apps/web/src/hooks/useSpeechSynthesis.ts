"use client";

import { pickVoice, type VoiceStyle } from "@nova/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { speakable } from "@/lib/speechText";

export type SpeakOptions = {
  /** Exact voice chosen in Settings; wins over `style`. */
  voiceURI?: string;
  /** Used when no exact voice is chosen. */
  style?: VoiceStyle;
  rate?: number;
  lang?: string;
  onEnd?: () => void;
  /** Fired as each sentence chunk starts playing (used by the barge-in echo filter). */
  onChunkStart?: (text: string) => void;
};

/** Split long replies into sentence chunks: Chrome silently stops utterances after ~15s. */
function chunk(text: string, max = 180): string[] {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?।]+[.!?।]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveVoice(opts: SpeakOptions): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis.getVoices();
  return (
    (opts.voiceURI && all.find((v) => v.voiceURI === opts.voiceURI)) ||
    pickVoice(
      all.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, voice: v })),
      opts.style ?? "any",
      opts.lang ?? "en-IN",
    )?.voice ||
    all.find((v) => v.default) ||
    null
  );
}

/** Browser text-to-speech via window.speechSynthesis (free, on-device or browser-provided voices). */
export function useSpeechSynthesis() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  // Keep references to queued utterances: Chrome can GC them and never fire onend.
  const queueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const sessionRef = useRef(0);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => {
      synth.removeEventListener?.("voiceschanged", load);
      if (safetyTimer.current) clearTimeout(safetyTimer.current);
      sessionRef.current++;
      synth.cancel();
    };
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    sessionRef.current++;
    queueRef.current = [];
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string, opts: SpeakOptions = {}) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        opts.onEnd?.();
        return;
      }
      const synth = window.speechSynthesis;
      synth.cancel();
      const session = ++sessionRef.current;
      const parts = chunk(speakable(text));
      if (!parts.length) {
        opts.onEnd?.();
        return;
      }
      const voice = resolveVoice(opts);

      let finished = false;
      const finish = () => {
        if (finished || session !== sessionRef.current) return;
        finished = true;
        queueRef.current = [];
        setSpeaking(false);
        opts.onEnd?.();
      };

      const utterances = parts.map((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        if (voice) u.voice = voice;
        u.lang = voice?.lang ?? opts.lang ?? "en-IN";
        u.rate = opts.rate ?? 1;
        u.onstart = () => {
          if (session !== sessionRef.current) return;
          setSpeaking(true);
          opts.onChunkStart?.(p);
        };
        u.onerror = () => finish();
        if (i === parts.length - 1) u.onend = () => finish();
        return u;
      });
      queueRef.current = utterances;
      setSpeaking(true);
      utterances.forEach((u) => synth.speak(u));
      // Safari occasionally starts paused.
      if (synth.paused) synth.resume();
      // Safety net in case onend never fires (known Chrome/Safari bugs).
      const budget = 4000 + parts.join(" ").length * 90;
      if (safetyTimer.current) clearTimeout(safetyTimer.current);
      safetyTimer.current = setTimeout(() => {
        if (!synth.speaking) finish();
      }, budget);
    },
    [],
  );

  /**
   * A short one-off phrase (the interrupt acknowledgement) that never flips `speaking`, so it
   * doesn't re-enter the speaking state or wake the barge-in listener. Cancels anything queued.
   */
  const speakQuiet = useCallback((text: string, opts: SpeakOptions = {}) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    sessionRef.current++;
    queueRef.current = [];
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    synth.cancel();
    setSpeaking(false);
    const u = new SpeechSynthesisUtterance(text);
    const voice = resolveVoice(opts);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? opts.lang ?? "en-IN";
    u.rate = Math.max(1, opts.rate ?? 1);
    u.onend = u.onerror = () => opts.onEnd?.();
    queueRef.current = [u];
    synth.speak(u);
    if (synth.paused) synth.resume();
  }, []);

  return { supported, voices, speaking, speak, speakQuiet, cancel };
}

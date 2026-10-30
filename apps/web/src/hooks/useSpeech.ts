"use client";

import { INTERRUPT_ACKS } from "@nova/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { FALLBACK_NOTICE, loadAck, markNaturalDown, naturalDown, peekClip, type NaturalFailure } from "@/lib/naturalVoice";
import { readVoicePrefs, type VoiceEngine } from "@/lib/prefs";
import { useNaturalSpeech } from "./useNaturalSpeech";
import { useSpeechSynthesis, type SpeakOptions } from "./useSpeechSynthesis";

export type UnifiedSpeakOptions = SpeakOptions & {
  /** Defaults to the Settings choice. */
  engine?: VoiceEngine;
  /** Natural voice id; defaults to the Settings choice. */
  naturalVoice?: string;
};

// One notice per failure kind per page load, shared by every component.
const noticed = new Set<NaturalFailure>();

/**
 * One `speak / cancel / speaking` interface over both engines. With the natural (server) voice
 * selected it plays that, and on any failure finishes the rest of the reply with the device voice
 * and raises a one-time `notice`. Callers pass the same `{ voiceURI, style, rate, lang }` as before.
 */
export function useSpeech() {
  const device = useSpeechSynthesis();
  const natural = useNaturalSpeech();
  const [notice, setNotice] = useState<string | null>(null);
  /** The sentence chunk being spoken plus the one before it (barge-in echo filter input). */
  const spokenRef = useRef("");
  const lastChunk = useRef("");
  const ackBusy = useRef(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const raise = useCallback((code: NaturalFailure) => {
    if (noticed.has(code)) return;
    noticed.add(code);
    setNotice(FALLBACK_NOTICE[code]);
  }, []);

  const { speak: deviceSpeak, cancel: deviceCancel, speakQuiet } = device;
  const { speak: naturalSpeak, cancel: naturalCancel, playQuiet, stopAck } = natural;

  const cancel = useCallback(() => {
    deviceCancel();
    naturalCancel();
    stopAck();
    spokenRef.current = lastChunk.current = "";
  }, [deviceCancel, naturalCancel, stopAck]);

  const speak = useCallback(
    (text: string, opts: UnifiedSpeakOptions = {}) => {
      const prefs = readVoicePrefs();
      const engine = opts.engine ?? prefs.engine;
      const voice = opts.naturalVoice ?? prefs.naturalVoice;
      deviceCancel();
      naturalCancel();
      stopAck();
      spokenRef.current = lastChunk.current = "";
      const onChunkStart = (t: string) => {
        spokenRef.current = `${lastChunk.current} ${t}`.trim();
        lastChunk.current = t;
        opts.onChunkStart?.(t);
      };
      const viaDevice = (t: string) => deviceSpeak(t, { ...opts, onChunkStart });
      if (engine !== "natural") return viaDevice(text);
      const downCode = naturalDown();
      if (downCode) {
        raise(downCode);
        return viaDevice(text);
      }
      naturalSpeak(text, {
        voice,
        rate: opts.rate,
        onEnd: opts.onEnd,
        onChunkStart,
        onError: (err, rest) => {
          raise(markNaturalDown(err));
          viaDevice(rest);
        },
      });
    },
    [deviceSpeak, deviceCancel, naturalSpeak, naturalCancel, stopAck, raise],
  );

  /**
   * Say a short acknowledgement right after an interruption. Uses a cached natural clip when there
   * is one (instant), else the device voice. Never queues: a second ack while one plays is dropped.
   */
  const ack = useCallback(
    (text: string) => {
      if (ackBusy.current) return;
      ackBusy.current = true;
      if (ackTimer.current) clearTimeout(ackTimer.current);
      const done = () => {
        ackBusy.current = false;
        if (ackTimer.current) clearTimeout(ackTimer.current);
      };
      ackTimer.current = setTimeout(done, 1500);
      const p = readVoicePrefs();
      if (p.engine === "natural" && !naturalDown()) {
        const url = peekClip(text, p.naturalVoice);
        if (url) return void playQuiet(url, p.rate).then(done);
      }
      speakQuiet(text, { voiceURI: p.voiceURI, style: p.voiceStyle, rate: p.rate, lang: p.lang, onEnd: done });
    },
    [playQuiet, speakQuiet],
  );

  /**
   * Get the interrupt acks in the natural voice ready: from Cache Storage when a previous visit
   * stored them (no requests), else fetched once per browser, one at a time, stopping at the
   * first failure.
   */
  const prefetchAcks = useCallback(async (voice: string) => {
    for (const a of INTERRUPT_ACKS) {
      try {
        await loadAck(a, voice, { network: !naturalDown() });
      } catch (err) {
        markNaturalDown(err);
        return;
      }
    }
  }, []);

  const speaking = device.speaking || natural.speaking;
  return useMemo(
    () => ({
      supported: device.supported,
      voices: device.voices,
      speaking,
      speak,
      cancel,
      ack,
      prefetchAcks,
      /** Real audio level of the natural voice (0..1), or -1 when not measurable (device voice). */
      levelRef: natural.levelRef,
      spokenRef,
      notice,
      dismissNotice: () => setNotice(null),
    }),
    [device.supported, device.voices, speaking, speak, cancel, ack, prefetchAcks, natural.levelRef, notice],
  );
}

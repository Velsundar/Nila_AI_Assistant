"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClip, setClipInUse } from "@/lib/naturalVoice";
import { speakable, splitForNatural } from "@/lib/speechText";

export type NaturalSpeakOptions = {
  /** Natural voice id ("" = server default). */
  voice?: string;
  rate?: number;
  onEnd?: () => void;
  onChunkStart?: (text: string) => void;
  /** Any failure: the caller finishes `rest` (this chunk onwards) with another engine. */
  onError?: (err: unknown, rest: string) => void;
};

type Graph = { ctx: AudioContext; src: MediaElementAudioSourceNode; analyser: AnalyserNode };

const AC = () =>
  typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

/**
 * Server AI voice playback: splits the reply into sentence chunks, requests chunk 1 at once and
 * prefetches chunk i+1 while chunk i plays, through one <audio> element routed into an
 * AnalyserNode so `levelRef` (0..1, or -1 when no analyser) follows the real audio for the orb.
 */
export function useNaturalSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const levelRef = useRef(-1);
  const sessionRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const rafRef = useRef(0);
  const waitersRef = useRef(new Set<() => void>());
  const ackRef = useRef<HTMLAudioElement | null>(null);

  /** Stop playback and release the element, the AudioContext and its nodes. */
  const release = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const a = audioRef.current;
    audioRef.current = null;
    if (a) {
      a.onended = a.onerror = a.onplaying = null;
      a.pause();
      if (a.src) setClipInUse(a.src, false);
      a.removeAttribute("src");
      a.load();
    }
    const g = graphRef.current;
    graphRef.current = null;
    if (g) {
      try {
        g.src.disconnect();
        g.analyser.disconnect();
      } catch {
        /* already disconnected */
      }
      void g.ctx.close().catch(() => undefined);
    }
    levelRef.current = -1;
    // Unblock any `play()` awaiting an ended event that will now never come.
    waitersRef.current.forEach((w) => w());
    waitersRef.current.clear();
  }, []);

  const stopAck = useCallback(() => {
    const a = ackRef.current;
    ackRef.current = null;
    if (a) {
      a.onended = a.onerror = null;
      a.pause();
    }
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current++;
    release();
    setSpeaking(false);
  }, [release]);

  useEffect(
    () => () => {
      sessionRef.current++;
      release();
      stopAck();
    },
    [release, stopAck],
  );

  /** Lazily build the element + analyser graph. Without a running AudioContext, play the element directly. */
  const ensureAudio = useCallback(async () => {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = "auto";
    audioRef.current = a;
    const Ctor = AC();
    if (Ctor) {
      let ctx: AudioContext | null = null;
      try {
        ctx = new Ctor();
        if (ctx.state !== "running") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
        if (ctx.state !== "running") throw new Error("AudioContext suspended");
        const src = ctx.createMediaElementSource(a);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        graphRef.current = { ctx, src, analyser };
        const buf = new Uint8Array(analyser.fftSize);
        levelRef.current = 0;
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const target = Math.min(1, Math.pow(Math.sqrt(sum / buf.length) * 5, 0.8));
          levelRef.current += (target - levelRef.current) * (target > levelRef.current ? 0.55 : 0.15);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // Autoplay policy kept the context suspended: plain element playback, synthetic orb motion.
        void ctx?.close().catch(() => undefined);
        graphRef.current = null;
        levelRef.current = -1;
      }
    }
    return audioRef.current ?? a;
  }, []);

  const play = useCallback(
    async (url: string, rate: number, session: number) => {
      const a = await ensureAudio();
      if (session !== sessionRef.current || a !== audioRef.current) return;
      if (a.src) setClipInUse(a.src, false);
      a.src = url;
      setClipInUse(url, true);
      a.playbackRate = rate;
      a.defaultPlaybackRate = rate;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          waitersRef.current.delete(done);
          resolve();
        };
        waitersRef.current.add(done);
        a.onended = done;
        a.onerror = () => {
          waitersRef.current.delete(done);
          reject(new DOMException("Audio failed to play", "MediaError"));
        };
        a.play().catch((e) => {
          waitersRef.current.delete(done);
          reject(e instanceof DOMException ? e : new DOMException(String(e), "NotAllowedError"));
        });
      });
    },
    [ensureAudio],
  );

  const speak = useCallback(
    (text: string, opts: NaturalSpeakOptions = {}) => {
      const session = ++sessionRef.current;
      audioRef.current?.pause();
      const parts = splitForNatural(speakable(text));
      if (!parts.length) {
        setSpeaking(false);
        opts.onEnd?.();
        return;
      }
      setSpeaking(true);
      const voice = opts.voice ?? "";
      const rate = opts.rate ?? 1;
      void (async () => {
        let next = getClip(parts[0], voice);
        for (let i = 0; i < parts.length; i++) {
          let url: string;
          try {
            url = await next;
          } catch (err) {
            if (session !== sessionRef.current) return;
            sessionRef.current++;
            release();
            setSpeaking(false);
            return opts.onError?.(err, parts.slice(i).join(" "));
          }
          if (session !== sessionRef.current) return; // cancelled: ignore this in-flight result
          if (i + 1 < parts.length) {
            next = getClip(parts[i + 1], voice); // prefetch while this one plays
            next.catch(() => undefined);
          }
          opts.onChunkStart?.(parts[i]);
          try {
            await play(url, rate, session);
          } catch (err) {
            if (session !== sessionRef.current) return;
            sessionRef.current++;
            release();
            setSpeaking(false);
            return opts.onError?.(err, parts.slice(i).join(" "));
          }
          if (session !== sessionRef.current) return;
        }
        setSpeaking(false);
        opts.onEnd?.();
      })();
    },
    [play, release],
  );

  /** Play a cached clip once on a separate element (interrupt acks): no speaking state, no analyser. */
  const playQuiet = useCallback(
    (url: string, rate = 1) =>
      new Promise<void>((resolve) => {
        stopAck();
        const a = new Audio(url);
        ackRef.current = a;
        a.playbackRate = Math.max(1, rate);
        a.onended = a.onerror = () => {
          if (ackRef.current === a) ackRef.current = null;
          resolve();
        };
        a.play().catch(() => resolve());
      }),
    [stopAck],
  );

  return { speaking, levelRef, speak, cancel, playQuiet, stopAck };
}

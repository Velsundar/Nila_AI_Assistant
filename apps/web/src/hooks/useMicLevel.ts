"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live microphone loudness (0..1) via Web Audio AnalyserNode, sampled every frame into a ref
 * (no re-renders). Opens the mic only while `active` and releases it afterwards.
 */
export function useMicLevel(active: boolean) {
  const levelRef = useRef(0);
  const [error, setError] = useState<"denied" | "unavailable" | null>(null);

  useEffect(() => {
    if (!active) {
      levelRef.current = 0;
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("unavailable");
      return;
    }
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        setError(null);
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AC();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          // Perceptual-ish curve; speech RMS is typically 0.02–0.3.
          const target = Math.min(1, Math.pow(rms * 4, 0.8));
          levelRef.current += (target - levelRef.current) * (target > levelRef.current ? 0.5 : 0.12);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name;
        setError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      levelRef.current = 0;
    };
  }, [active]);

  return { levelRef, error };
}

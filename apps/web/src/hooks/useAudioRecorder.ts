"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
/** Hard cap so a forgotten recording never exceeds the API's ~10 MB limit. */
const MAX_MS = 60_000;

export type RecorderError = "denied" | "unavailable" | "unknown";

function pickType() {
  if (typeof MediaRecorder === "undefined") return undefined;
  return TYPES.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/**
 * Push-to-talk audio capture with MediaRecorder, used when the browser has no SpeechRecognition.
 * `stop()` resolves with the recorded Blob (or null if nothing usable was captured).
 */
export function useAudioRecorder() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<RecorderError | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveRef = useRef<((b: Blob | null) => void) | null>(null);
  const startingRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    setSupported(typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia);
    // Never keep recording in a hidden tab: discard the clip and release the mic.
    const onVis = () => {
      if (document.visibilityState !== "hidden" || !recRef.current) return;
      resolveRef.current?.(null);
      resolveRef.current = null;
      chunksRef.current = [];
      try {
        recRef.current.stop();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      resolveRef.current = null;
      if (capTimer.current) clearTimeout(capTimer.current);
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const release = () => {
    if (capTimer.current) clearTimeout(capTimer.current);
    capTimer.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
  };

  const start = useCallback(async () => {
    if (recRef.current) return true;
    setError(null);
    const p = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streamRef.current = stream;
        const mimeType = pickType();
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
        rec.onstop = () => {
          const type = rec.mimeType || mimeType || "audio/webm";
          const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null;
          const tooShort = performance.now() - startedAt.current < 400;
          release();
          resolveRef.current?.(tooShort ? null : blob);
          resolveRef.current = null;
        };
        recRef.current = rec;
        startedAt.current = performance.now();
        rec.start(250);
        setRecording(true);
        capTimer.current = setTimeout(() => {
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
        }, MAX_MS);
        return true;
      } catch (err) {
        const name = (err as DOMException)?.name;
        setError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "unavailable" : "unknown");
        release();
        return false;
      }
    })();
    startingRef.current = p;
    const ok = await p;
    startingRef.current = null;
    return ok;
  }, []);

  /** Resolves with the clip, null if it was too short/empty, or undefined if nothing was recording. */
  const stop = useCallback(async (): Promise<Blob | null | undefined> => {
    // Released before getUserMedia resolved: wait for it, then stop.
    if (startingRef.current) await startingRef.current;
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return undefined;
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      try {
        rec.stop();
      } catch {
        release();
        resolve(null);
      }
    });
  }, []);

  const cancel = useCallback(() => {
    resolveRef.current = null;
    chunksRef.current = [];
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    release();
  }, []);

  return { supported, recording, error, start, stop, cancel, clearError: () => setError(null) };
}

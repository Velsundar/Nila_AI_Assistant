"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCtor, type SpeechRecognitionLike } from "./useSpeechRecognition";
import { matchWakePhrase } from "./wakeMatch";

export type WakeWordStatus =
  | "off" // disabled, unsupported, page hidden, or paused (TTS speaking, a turn in progress)
  | "listening" // continuous recognition running, waiting for "hey <name>"
  | "blocked" // mic permission denied
  | "error"; // speech service failing repeatedly (network)

export type UseWakeWordOptions = {
  /** Feature on (settings) AND nothing else currently needs the mic/speaker. */
  active: boolean;
  assistantName: string;
  lang?: string;
  /**
   * Fired once per detection. `command` is whatever followed the wake phrase in the same
   * utterance ("" when the user only said "hey nova"). Recognition has already ended.
   */
  onWake: (command: string) => void;
  /**
   * Custom detector over the current utterance: return the command to act on, or null to keep
   * waiting. Defaults to "Hey <name>" matching. The barge-in listener passes an echo filter here.
   */
  match?: (text: string) => string | null;
  /** Called once per session as soon as `match` hits on an interim result (before the final one). */
  onCandidate?: (text: string) => void;
  /** Wait this long after the last interim result for the final one (ms). */
  trailingMs?: number;
};

/** How long to wait after hearing "hey nova…" for the rest of the sentence before acting. */
const TRAILING_MS = 1300;

/**
 * Background "Hey <name>" listener using continuous Web Speech recognition (Chrome/Edge only).
 * Runs only while `active` and the page is visible; restarts on `onend` because Chrome ends
 * continuous sessions on its own (after silence, ~60 s, or network hiccups), with backoff on errors.
 */
export function useWakeWord({ active, assistantName, lang = "en-IN", onWake, match, onCandidate, trailingMs = TRAILING_MS }: UseWakeWordOptions) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [visible, setVisible] = useState(true);
  const [status, setStatus] = useState<WakeWordStatus>("off");

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const runRef = useRef(false); // should be running right now
  const errorsRef = useRef(0); // consecutive failures, for backoff
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef<string | null>(null); // detected command waiting for onend
  const candidateRef = useRef(false); // onCandidate already fired this session
  const cfg = useRef({ assistantName, lang, onWake, match, onCandidate, trailingMs });
  cfg.current = { assistantName, lang, onWake, match, onCandidate, trailingMs };

  useEffect(() => {
    setSupported(getCtor() !== null);
    const onVis = () => setVisible(document.visibilityState === "visible");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const clearTimers = () => {
    if (restartTimer.current) clearTimeout(restartTimer.current);
    if (trailingTimer.current) clearTimeout(trailingTimer.current);
    restartTimer.current = trailingTimer.current = null;
  };

  const teardown = useCallback(() => {
    clearTimers();
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onstart = rec.onspeechstart = null;
      // Keep onend so a pending detection can fire once the mic is really released.
      try {
        rec.abort();
      } catch {
        /* not started */
      }
    }
  }, []);

  const startSession = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor || !runRef.current) return;
    const rec = new Ctor();
    rec.lang = cfg.current.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    firedRef.current = null;
    candidateRef.current = false;

    const fire = (command: string) => {
      if (firedRef.current !== null) return;
      firedRef.current = command.trim();
      if (trailingTimer.current) clearTimeout(trailingTimer.current);
      trailingTimer.current = null;
      try {
        rec.abort(); // onend delivers it once Chrome has released the mic
      } catch {
        /* ignore */
      }
    };

    rec.onstart = () => {
      errorsRef.current = 0;
      setStatus("listening");
    };
    rec.onresult = (e) => {
      // Only look at the current utterance (results since the last final one).
      let text = "";
      let allFinal = true;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript + " ";
        if (!e.results[i].isFinal) allFinal = false;
      }
      const c = cfg.current;
      const cmd = c.match ? c.match(text) : matchWakePhrase(text, c.assistantName);
      if (cmd === null) return;
      if (!candidateRef.current) {
        candidateRef.current = true;
        c.onCandidate?.(cmd);
      }
      if (allFinal) return fire(cmd);
      // Heard the wake phrase mid-sentence: give the rest of the command a moment to arrive.
      if (trailingTimer.current) clearTimeout(trailingTimer.current);
      trailingTimer.current = setTimeout(() => fire(cmd), c.trailingMs);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        runRef.current = false;
        setStatus("blocked");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        errorsRef.current++;
      }
    };
    rec.onend = () => {
      if (trailingTimer.current) clearTimeout(trailingTimer.current);
      trailingTimer.current = null;
      if (recRef.current === rec) recRef.current = null;
      const fired = firedRef.current;
      firedRef.current = null;
      if (fired !== null) {
        cfg.current.onWake(fired);
        // The caller normally pauses us (active=false) for the turn. If nothing happened, resume.
        restartTimer.current = setTimeout(() => {
          if (runRef.current && !recRef.current) startSession();
        }, 1500);
        return;
      }
      if (!runRef.current) return;
      // Chrome ends continuous sessions on its own: restart, backing off if it keeps failing.
      const n = errorsRef.current;
      if (n >= 6) {
        setStatus("error");
        runRef.current = false;
        return;
      }
      const delay = n === 0 ? 250 : Math.min(10_000, 500 * 2 ** n);
      restartTimer.current = setTimeout(() => {
        if (runRef.current && !recRef.current) startSession();
      }, delay);
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      recRef.current = null;
      errorsRef.current++;
      restartTimer.current = setTimeout(() => runRef.current && !recRef.current && startSession(), 1000);
    }
  }, []);

  const shouldRun = active && visible && supported === true;

  useEffect(() => {
    if (!shouldRun) {
      runRef.current = false;
      teardown();
      setStatus((s) => (s === "blocked" || s === "error" ? s : "off"));
      return;
    }
    runRef.current = true;
    errorsRef.current = 0;
    setStatus((s) => (s === "blocked" ? s : "off"));
    // Small delay so we don't grab the mic in the same tick another recognizer releases it.
    restartTimer.current = setTimeout(() => {
      if (runRef.current && !recRef.current) startSession();
    }, 400);
    return () => {
      runRef.current = false;
      teardown();
    };
  }, [shouldRun, startSession, teardown]);

  // Restart with the new language / name when they change.
  useEffect(() => {
    if (!runRef.current || !recRef.current) return;
    const rec = recRef.current;
    rec.onend = null;
    teardown();
    restartTimer.current = setTimeout(() => runRef.current && !recRef.current && startSession(), 300);
  }, [lang, startSession, teardown]);

  /** Release the mic immediately (e.g. right before a push-to-talk turn starts). */
  const stopNow = useCallback(() => {
    runRef.current = false;
    const rec = recRef.current;
    if (rec) rec.onend = null;
    teardown();
  }, [teardown]);

  return { supported, status: shouldRun ? status : status === "blocked" ? "blocked" : "off", stopNow } as const;
}

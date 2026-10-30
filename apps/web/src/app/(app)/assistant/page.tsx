"use client";

import { ApiError, INTERRUPT_ACKS, type AgentAction, type Expense } from "@nova/shared";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ACTION_ICON, actionKind, describeAction } from "@/components/assistant/actions";
import { Orb, type OrbState } from "@/components/assistant/Orb";
import { useAuth } from "@/components/AuthProvider";
import { AddExpenseForm } from "@/components/expenses/AddExpenseForm";
import { FileButton, useReceiptScan, type ScanOutcome } from "@/components/expenses/ReceiptScanner";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useMicLevel } from "@/hooks/useMicLevel";
import { useSpeechRecognition, type RecognitionError } from "@/hooks/useSpeechRecognition";
import { useSpeech } from "@/hooks/useSpeech";
import { useWakeWord } from "@/hooks/useWakeWord";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { notifyDataChanged } from "@/lib/events";
import { dayKey, formatMoney, timezone } from "@/lib/format";
import { isLikelyEcho, stripAck } from "@/lib/echoFilter";
import { blobToDataUrl } from "@/lib/image";
import { loadNaturalVoices } from "@/lib/naturalVoice";
import { readVoicePrefs, useVoicePrefs } from "@/lib/prefs";

type Msg = {
  id: number;
  role: "user" | "assistant" | "error" | "notice";
  text: string;
  actions?: AgentAction[];
  tag?: string;
  /** The user interrupted while this reply was being spoken (text stays, fully). */
  stopped?: boolean;
  /** Arrived after the user had interrupted the "thinking" state: shown, not spoken. */
  late?: boolean;
};

const CONV_KEY = "nova.conversationId";
/** Local date (YYYY-MM-DD) of the last automatic briefing, so it plays once per day. */
const AUTO_BRIEF_KEY = "nova.lastAutoBriefing";
const HOLD_MS = 350;
/** A transcript this soon after an ack may start with the ack itself (picked up by the mic). */
const ACK_ECHO_MS = 4000;

const STATUS: Record<OrbState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

const SUGGESTIONS = [
  "Add milk to my shopping list",
  "What's the weather?",
  "Note that the gate code is 4521",
  "Plan my evening",
  "I spent 250 on lunch at Swiggy",
  "How did my spending go last week?",
  "Remind me to call mom at 7pm",
];

const RECOGNITION_ERRORS: Record<RecognitionError, string> = {
  "not-allowed": "Microphone access was blocked. Allow the mic for this site in your browser's address bar, or type below.",
  "no-speech": "I didn't catch anything. Hold the mic and try again.",
  "audio-capture": "No microphone was found. Plug one in, or type below.",
  network: "The browser's speech service couldn't be reached (it needs internet in Chrome). You can type instead.",
  aborted: "",
  unknown: "Voice input stopped unexpectedly. Try again, or type below.",
};

export default function AssistantPage() {
  const { user } = useAuth();
  const name = user?.assistantName || "Nova";
  const currency = user?.currency || "INR";
  const [prefs, setPrefs] = useVoicePrefs();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [sttDown, setSttDown] = useState(false);
  const [scan, setScan] = useState<ScanOutcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const convRef = useRef<string | undefined>(undefined);
  const busyRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const tts = useSpeech();
  const ttsRef = useRef(tts);
  ttsRef.current = tts;

  // ---- Turn controller: questions run strictly in order, one /agent request at a time.
  const queueRef = useRef<string[]>([]);
  const lastQueued = useRef<{ text: string; at: number } | null>(null);
  /** Message id whose reply is being spoken right now. */
  const speakingIdRef = useRef<number | null>(null);
  /** The user interrupted while the current request was in flight. */
  const lateRef = useRef(false);
  const ackIndex = useRef(0);
  const ackAt = useRef(0);
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pending;
  const listeningRef = useRef(false);

  useEffect(() => {
    try {
      convRef.current = window.sessionStorage.getItem(CONV_KEY) ?? undefined;
    } catch {
      /* ignore */
    }
  }, []);

  const push = useCallback((m: Omit<Msg, "id">) => {
    const id = nextId.current++;
    setMessages((list) => [...list, { ...m, id }]);
    return id;
  }, []);

  /** Speak a reply and remember which message is being spoken (for the "Stopped speaking" marker). */
  const speakReply = useCallback((id: number, reply: string) => {
    const p = prefsRef.current;
    if (!p.speak || !reply) return;
    speakingIdRef.current = id;
    ttsRef.current.speak(reply, {
      voiceURI: p.voiceURI,
      style: p.voiceStyle,
      rate: p.rate,
      lang: p.lang,
      onEnd: () => {
        if (speakingIdRef.current === id) speakingIdRef.current = null;
      },
    });
  }, []);

  /** Stop any spoken reply; the message keeps its full text and gets a subtle marker. */
  const stopSpeaking = useCallback(() => {
    const id = speakingIdRef.current;
    speakingIdRef.current = null;
    ttsRef.current.cancel();
    if (id !== null) setMessages((list) => list.map((m) => (m.id === id ? { ...m, stopped: true } : m)));
  }, []);

  /**
   * Barge-in: called when the user presses the mic / holds Space / taps the orb / talks over Nova.
   * Stops all audio at once, says a short rotating acknowledgement, and (if a request is in
   * flight) marks its answer as "late" so it's shown but not spoken. Returns whether anything
   * was interrupted. During a Yes/No confirmation it only stops the audio (no ack).
   */
  const interrupt = useCallback(() => {
    const speakingNow = ttsRef.current.speaking || speakingIdRef.current !== null;
    const thinkingNow = busyRef.current;
    if (!speakingNow && !thinkingNow) return false;
    stopSpeaking();
    if (thinkingNow) lateRef.current = true;
    if (pendingRef.current && !thinkingNow) return true;
    const ack = INTERRUPT_ACKS[ackIndex.current++ % INTERRUPT_ACKS.length];
    ackAt.current = Date.now();
    ttsRef.current.ack(ack);
    return true;
  }, [stopSpeaking]);

  /** Drop an ack the mic overheard at the start of the user's words. */
  const cleanHeard = (t: string) => (Date.now() - ackAt.current < ACK_ECHO_MS ? stripAck(t, INTERRUPT_ACKS) : t.trim());

  /** One /agent round trip. Only ever called from `pump`, so never in parallel. */
  const runTurn = useCallback(
    async (message: string) => {
      if (speakingIdRef.current !== null || ttsRef.current.speaking) stopSpeaking();
      lateRef.current = false;
      setPending(null);
      setThinking(true);
      try {
        const res = await api.agent.send({
          message,
          conversationId: convRef.current,
          timezone: timezone(),
        });
        convRef.current = res.conversationId;
        try {
          window.sessionStorage.setItem(CONV_KEY, res.conversationId);
        } catch {
          /* ignore */
        }
        // Interrupted while thinking and a newer question is queued / being asked: show, don't speak.
        const late = lateRef.current && (queueRef.current.length > 0 || listeningRef.current || transcribingRef.current);
        const id = push({ role: "assistant", text: res.reply, actions: res.actions, late });
        setPending(queueRef.current.length ? null : (res.pendingConfirmation?.summary ?? null));
        if (res.actions.some((a) => a.ok)) notifyDataChanged();
        if (!late) speakReply(id, res.reply);
      } catch (err) {
        push({ role: "error", text: errorMessage(err) });
      } finally {
        lateRef.current = false;
      }
    },
    [push, speakReply, stopSpeaking],
  );

  const pump = useCallback(async () => {
    if (busyRef.current) return; // the running loop will pick up whatever was queued
    busyRef.current = true;
    try {
      while (queueRef.current.length) await runTurn(queueRef.current.shift()!);
    } finally {
      busyRef.current = false;
      setThinking(false);
    }
  }, [runTurn]);

  /**
   * Ask something. While a request is in flight, voice questions (`queue: true`) wait their turn;
   * anything else is a double-send and is ignored (the ref guard from before).
   */
  const send = useCallback(
    (raw: string, opts: { queue?: boolean } = {}) => {
      const message = raw.trim().slice(0, 2000);
      if (!message) return;
      if (busyRef.current && !opts.queue) return;
      const now = Date.now();
      // Same words twice within a second (two recognizers, double tap): one question.
      if (lastQueued.current && lastQueued.current.text === message && now - lastQueued.current.at < 1000) return;
      lastQueued.current = { text: message, at: now };
      push({ role: "user", text: message });
      queueRef.current.push(message);
      void pump();
    },
    [push, pump],
  );

  /** "Brief me": GET /briefing and speak its text, no agent/LLM involved. */
  const briefMe = useCallback(
    async (opts: { auto?: boolean } = {}) => {
      if (busyRef.current) return;
      busyRef.current = true;
      stopSpeaking();
      if (!opts.auto) push({ role: "user", text: "Brief me" });
      setThinking(true);
      try {
        const b = await api.briefing.today({ tz: timezone() });
        const id = push({ role: "assistant", text: b.text, tag: opts.auto ? "Your morning briefing" : "Daily briefing" });
        if (opts.auto) {
          try {
            window.localStorage.setItem(AUTO_BRIEF_KEY, dayKey());
          } catch {
            /* ignore */
          }
        }
        speakReply(id, b.text);
      } catch (err) {
        push({ role: "error", text: errorMessage(err) });
      } finally {
        busyRef.current = false;
        setThinking(false);
      }
    },
    [push, speakReply, stopSpeaking],
  );

  // Optional auto-briefing on the first open of the day (Settings, off by default).
  const autoBriefed = useRef(false);
  useEffect(() => {
    if (autoBriefed.current) return;
    autoBriefed.current = true;
    if (!readVoicePrefs().autoBriefing) return;
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(AUTO_BRIEF_KEY);
    } catch {
      /* ignore */
    }
    if (last !== dayKey()) void briefMe({ auto: true });
  }, [briefMe]);

  const rec = useSpeechRecognition({
    lang: prefs.lang,
    onFinal: (t) => send(cleanHeard(t), { queue: true }),
    // Never talk over the user (a reply can start while they're mid-question).
    onSpeechStart: () => {
      if (speakingIdRef.current !== null) stopSpeaking();
    },
  });

  // ---- Server STT fallback (no SpeechRecognition): record with MediaRecorder, POST /transcribe.
  const recorder = useAudioRecorder();
  const voiceMode: "browser" | "server" | "none" | null =
    rec.supported === null ? null : rec.supported ? "browser" : recorder.supported && !sttDown ? "server" : recorder.supported === null ? null : "none";
  const listening = rec.listening || recorder.recording;
  listeningRef.current = listening;
  const mic = useMicLevel(listening);

  const transcribingRef = useRef(false);
  const handleRecording = useCallback(
    async (blob: Blob | null) => {
      if (!blob) return push({ role: "notice", text: "That was too short. Hold the mic while you talk." });
      if (transcribingRef.current) return;
      transcribingRef.current = true;
      setTranscribing(true);
      try {
        const audio = await blobToDataUrl(blob);
        const { text } = await api.voice.transcribe({ audio, language: prefsRef.current.lang.slice(0, 2) });
        if (cleanHeard(text)) send(cleanHeard(text), { queue: true });
        else push({ role: "notice", text: "I couldn't make out any words. Try again, a little closer to the mic." });
      } catch (err) {
        if (err instanceof ApiError && (err.code === "STT_UNAVAILABLE" || (err.status === 503 && err.code !== "STT_RATE_LIMITED"))) {
          // No server STT at all: switch to typing for the rest of the session.
          setSttDown(true);
          push({ role: "notice", text: "Voice transcription isn't available right now, so let's type. Your message box is ready." });
          requestAnimationFrame(() => inputRef.current?.focus());
        } else if (err instanceof ApiError && ["STT_RATE_LIMITED", "STT_BAD_AUDIO", "STT_FAILED", "PAYLOAD_TOO_LARGE"].includes(err.code)) {
          // Transient / per-recording problems: explain, keep the mic available.
          push({ role: "notice", text: errorMessage(err) });
        } else push({ role: "error", text: errorMessage(err) });
      } finally {
        transcribingRef.current = false;
        setTranscribing(false);
      }
    },
    [push, send],
  );

  // ---- Receipt scanning from the assistant (camera / upload). Opens a confirm dialog; never auto-saves.
  const receipt = useReceiptScan((r) => setScan(r));
  useEffect(() => {
    if (receipt.error) {
      push({ role: "error", text: `Receipt scan failed: ${receipt.error}` });
      receipt.clearError();
    }
  }, [receipt, push]);
  const onReceiptSaved = (e: Expense) => {
    setScan(null);
    push({
      role: "assistant",
      text: `Saved ${formatMoney(e.amount, currency)}${e.merchant ? ` at ${e.merchant}` : ""} from your receipt.`,
      actions: [{ tool: "addExpense", ok: true, args: { amount: e.amount, category: e.category, merchant: e.merchant } }],
    });
  };

  // `?orb=listening|thinking|speaking` previews a state (used for screenshots / demos).
  const [demo, setDemo] = useState<OrbState | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("orb");
    if (q === "idle" || q === "listening" || q === "thinking" || q === "speaking") setDemo(q);
  }, []);
  useEffect(() => {
    if (demo !== "listening") return;
    let raf = 0;
    const tick = (t: number) => {
      mic.levelRef.current = 0.35 + 0.3 * Math.abs(Math.sin(t / 180)) * Math.abs(Math.sin(t / 470));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [demo, mic.levelRef]);

  const working = thinking || transcribing || receipt.busy;
  const orbState: OrbState = demo ?? (listening ? "listening" : working ? "thinking" : tts.speaking ? "speaking" : "idle");

  // ---- Push-to-talk: hold = talk while held; quick tap = hands-free until silence / tap again.
  const pressRef = useRef<{ at: number; wasListening: boolean } | null>(null);
  const wakeStopRef = useRef<() => void>(() => undefined);
  const bargeStopRef = useRef<() => void>(() => undefined);
  const beginTalk = useCallback(() => {
    if (transcribingRef.current) return;
    // Speaking or thinking: stop the audio, say "Okay.", and listen for the new question.
    interrupt();
    bargeStopRef.current();
    if (voiceMode === "server") {
      recorder.clearError();
      void recorder.start();
      return;
    }
    wakeStopRef.current(); // only one recognizer may own the mic
    rec.clearError();
    rec.start();
  }, [rec, recorder, voiceMode, interrupt]);
  const endTalk = useCallback(() => {
    if (recorder.recording || voiceMode === "server") {
      void recorder.stop().then((b) => (b === undefined ? undefined : handleRecording(b)));
      return;
    }
    rec.stop();
  }, [rec, recorder, voiceMode, handleRecording]);

  const onMicDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const wasListening = listening;
    pressRef.current = { at: performance.now(), wasListening };
    if (wasListening) endTalk();
    else beginTalk();
  };
  const onMicUp = () => {
    const p = pressRef.current;
    pressRef.current = null;
    if (!p || p.wasListening) return;
    if (performance.now() - p.at > HOLD_MS) endTalk();
  };
  const onMicClick = (e: React.MouseEvent) => {
    // Keyboard activation (Enter) arrives as a click with detail 0: toggle.
    if (e.detail !== 0) return;
    if (listening) endTalk();
    else beginTalk();
  };

  // ---- Wake word: "Hey <name>" while this page is open + visible, paused while busy or speaking.
  // ---- Interrupt by voice: while Nova speaks, keep a recognizer running; anything that isn't an
  // echo of Nova's own words (or a stray word) interrupts. Chrome/Edge only.
  const [bargePending, setBargePending] = useState(false);
  const bargeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replyTextRef = useRef("");
  replyTextRef.current = speakingIdRef.current !== null ? (messages.find((m) => m.id === speakingIdRef.current)?.text ?? "") : "";
  const bargeEnabled = prefs.bargeIn && voiceMode === "browser";
  const barge = useWakeWord({
    active: bargeEnabled && (tts.speaking || bargePending) && !rec.listening && !scan,
    assistantName: name,
    lang: prefs.lang,
    trailingMs: 1200,
    match: (heard) => {
      // Compare with the whole reply (recognition lags playback by a chunk or more) plus the
      // chunk being spoken; the acks count as Nova's own words too.
      const said = `${replyTextRef.current} ${ttsRef.current.spokenRef.current} ${INTERRUPT_ACKS.join(" ")}`;
      return isLikelyEcho(heard, said) ? null : heard;
    },
    onCandidate: () => {
      // A real interruption (even if still interim): stop talking now, then wait for the final words.
      setBargePending(true);
      if (bargeTimer.current) clearTimeout(bargeTimer.current);
      bargeTimer.current = setTimeout(() => setBargePending(false), 10_000);
      interrupt();
    },
    onWake: (heard) => {
      if (bargeTimer.current) clearTimeout(bargeTimer.current);
      setBargePending(false);
      const q = cleanHeard(heard);
      if (q) send(q, { queue: true });
      else beginTalk(); // only the ack/noise survived: open a normal listening turn
    },
  });
  bargeStopRef.current = () => {
    if (bargeTimer.current) clearTimeout(bargeTimer.current);
    setBargePending(false);
    barge.stopNow();
  };

  const wake = useWakeWord({
    active: prefs.wakeWord && voiceMode === "browser" && !rec.listening && !working && !tts.speaking && !bargePending && !scan,
    assistantName: name,
    lang: prefs.lang,
    onWake: (command) => {
      if (command) send(command, { queue: true });
      else beginTalk();
    },
  });
  wakeStopRef.current = wake.stopNow;

  // Natural voice: cache the four interrupt acks once so they play instantly.
  const acksFetched = useRef(false);
  useEffect(() => {
    if (prefs.engine !== "natural" || acksFetched.current) return;
    acksFetched.current = true;
    const voice = prefs.naturalVoice;
    loadNaturalVoices()
      .then((r) => (r.available ? tts.prefetchAcks(voice) : undefined))
      .catch(() => undefined);
  }, [prefs.engine, prefs.naturalVoice, tts]);

  // Space bar = hold to talk (unless typing in a field).
  useEffect(() => {
    const isTyping = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest('[role="dialog"]'));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat || voiceMode === "none" || voiceMode === null) return;
      if (!listening) beginTalk();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      if (listening || recorder.recording) endTalk();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [listening, beginTalk, endTalk, voiceMode, recorder.recording]);

  // Keep the caption log scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el && messages.length) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = text;
    setText("");
    void send(t);
  }

  function newConversation() {
    stopSpeaking();
    queueRef.current = [];
    bargeStopRef.current();
    rec.abort();
    recorder.cancel();
    convRef.current = undefined;
    try {
      window.sessionStorage.removeItem(CONV_KEY);
    } catch {
      /* ignore */
    }
    setMessages([]);
    setPending(null);
  }

  const voiceError = rec.error
    ? RECOGNITION_ERRORS[rec.error]
    : mic.error === "denied" || recorder.error === "denied"
      ? RECOGNITION_ERRORS["not-allowed"]
      : recorder.error === "unavailable"
        ? RECOGNITION_ERRORS["audio-capture"]
        : null;
  const voiceNotice =
    voiceMode === "none"
      ? sttDown
        ? "Voice transcription is unavailable right now. Type your message below."
        : "Voice input isn't supported in this browser. Type below, or use Chrome, Edge or Safari for voice."
      : voiceError;
  const hint =
    voiceMode === "none" || voiceMode === null
      ? "Type a message below"
      : voiceMode === "server"
        ? "Hold the mic to record, or tap to start and tap again to send"
        : orbState === "speaking" || orbState === "thinking"
          ? bargeEnabled && orbState === "speaking"
            ? "Just start talking to interrupt (headphones help, so I don't hear myself), or tap the orb / mic"
            : "Tap the orb, press the mic or Space to interrupt"
          : wake.status === "listening"
            ? `Say “Hey ${name}”, hold the mic, or press Space`
            : "Hold the mic or press Space to talk";
  const camId = useId();

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-void text-fg">
      {/* Backdrop: starfield + nebula glow */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,rgba(79,70,229,0.18),transparent_60%),radial-gradient(ellipse_at_80%_90%,rgba(45,212,191,0.10),transparent_55%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(1px_1px_at_20px_30px,#fff8,transparent),radial-gradient(1px_1px_at_120px_80px,#fff6,transparent),radial-gradient(1.5px_1.5px_at_200px_160px,#a5f3fc88,transparent),radial-gradient(1px_1px_at_60px_190px,#fff5,transparent)] [background-size:240px_220px]" />

      <div className="relative mx-auto grid h-[calc(100dvh-3.5rem)] w-full max-w-6xl grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-4 pb-4 pt-3 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-x-8">
        {/* Header */}
        <div className="flex items-center gap-3 lg:col-span-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {name}
              <span className="sr-only">, your assistant</span>
            </h1>
            <p className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  orbState === "listening" ? "bg-ok shadow-[0_0_8px_var(--color-ok)]" : orbState === "thinking" ? "bg-violet animate-pulse" : orbState === "speaking" ? "bg-sky-400 animate-pulse" : "bg-accent/70",
                )}
              />
              {transcribing ? "Transcribing…" : receipt.busy ? "Reading receipt…" : STATUS[orbState]}
            </p>
            <WakeIndicator enabled={prefs.wakeWord} mode={voiceMode} status={wake.status} name={name} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void briefMe()}
              disabled={working}
              className="mr-1 inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/40 bg-accent/10 px-3 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v2m0 14v2M5.6 5.6 7 7m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
              </svg>
              Brief me
            </button>
            <IconButton
              label={prefs.speak ? "Mute spoken replies" : "Unmute spoken replies"}
              pressed={!prefs.speak}
              onClick={() => {
                if (prefs.speak) stopSpeaking();
                setPrefs({ speak: !prefs.speak });
              }}
              path={prefs.speak ? "M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" : "M11 5 6 9H3v6h3l5 4V5Zm5 5 5 5m0-5-5 5"}
            />
            <IconButton label="New conversation" onClick={newConversation} path="M12 5v14M5 12h14" />
            <Link href="/settings" aria-label="Assistant settings" title="Assistant settings" className="grid size-9 place-items-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />
              </svg>
            </Link>
          </div>
        </div>

        {/* Orb + live transcript + confirmation */}
        <section aria-label={`${name} orb`} className="relative flex min-h-0 flex-col items-center justify-center">
          <button
            type="button"
            onClick={() => (listening ? endTalk() : voiceMode === "none" || voiceMode === null ? interrupt() : beginTalk())}
            aria-label={
              orbState === "speaking" || orbState === "thinking"
                ? `Interrupt ${name} and ask something else`
                : listening
                  ? "Stop listening"
                  : `Talk to ${name}`
            }
            title={orbState === "speaking" || orbState === "thinking" ? "Tap to interrupt" : undefined}
            className="relative aspect-square h-full max-h-[min(30rem,42dvh)] w-auto max-w-full cursor-pointer appearance-none rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent lg:max-h-[30rem]"
          >
            <Orb state={orbState} levelRef={mic.levelRef} speakLevelRef={tts.levelRef} label={`${name} is ${STATUS[orbState].replace("…", "").toLowerCase()}`} />
          </button>
          <div className="min-h-[3.5rem] w-full max-w-xl px-2 text-center" aria-live="polite">
            {listening ? (
              <p className="text-lg font-medium leading-snug text-fg sm:text-xl">
                {rec.interim || (
                  <span className="text-muted">{recorder.recording ? "Recording… release (or tap) to send" : "Go ahead, I'm listening…"}</span>
                )}
                <span aria-hidden="true" className="ml-1 inline-block h-5 w-0.5 translate-y-1 animate-pulse bg-accent" />
              </p>
            ) : working ? (
              <p className="text-sm text-muted">{transcribing ? "Turning your voice into text…" : receipt.busy ? "Reading your receipt…" : "Working on it…"}</p>
            ) : pending ? null : (
              <p className="text-sm text-faint">{hint}</p>
            )}
          </div>
          {pending && !working && (
            <div role="alertdialog" aria-labelledby="confirm-title" className="mt-2 w-full max-w-md animate-fade-in rounded-card border border-warn/40 bg-warn/10 p-4 shadow-[0_0_40px_-12px_var(--color-warn)]">
              <p id="confirm-title" className="text-xs font-semibold uppercase tracking-wider text-warn">
                Confirm
              </p>
              <p className="mt-1 text-sm text-fg">{pending}</p>
              <p className="mt-1 text-xs text-muted">Say “yes” or “no”, or tap below.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void send("yes")} className="h-10 flex-1 rounded-control bg-warn font-medium text-black transition-opacity hover:opacity-90">
                  Yes
                </button>
                <button type="button" onClick={() => void send("no")} className="h-10 flex-1 rounded-control border border-line-strong bg-surface-2 font-medium text-fg transition-colors hover:bg-surface-3">
                  No
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Caption log */}
        <section aria-label="Conversation" className="row-start-3 flex min-h-0 flex-col gap-3 lg:col-start-2 lg:row-span-1 lg:row-start-2">
          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label="Conversation captions"
            className="min-h-0 max-h-[24dvh] flex-1 space-y-2.5 overflow-y-auto rounded-card border border-line/60 bg-surface/50 p-3 backdrop-blur-sm lg:max-h-none"
          >
            {messages.length === 0 ? (
              <div className="space-y-3 p-1">
                <p className="text-sm text-muted">
                  Hi{user?.name ? ` ${user.name.split(" ")[0]}` : ""}! I&apos;m {name}. Try:
                </p>
                <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 max-lg:[&>button]:shrink-0 lg:flex-wrap">
                  <button type="button" onClick={() => void briefMe()} className="rounded-full border border-accent/50 bg-accent/10 px-3 py-1.5 text-left text-xs font-medium text-accent transition-colors hover:bg-accent/20">
                    ☀ Brief me on my day
                  </button>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-line bg-surface-2/70 px-3 py-1.5 text-left text-xs text-fg transition-colors hover:border-accent/60 hover:text-accent">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => <Caption key={m.id} msg={m} name={name} currency={currency} />)
            )}
            {thinking && (
              <div className="flex items-center gap-1.5 px-1 py-1" aria-label={`${name} is thinking`}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-violet" style={{ animationDelay: `${i * 120}ms` }} />
                ))}
              </div>
            )}
          </div>

          {tts.notice && (
            <div role="status" className="flex items-start gap-2 rounded-control border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-fg">
              <span className="min-w-0 flex-1">{tts.notice}</span>
              <button type="button" onClick={tts.dismissNotice} aria-label="Dismiss" className="-my-0.5 shrink-0 rounded px-1 text-muted hover:text-fg">
                ✕
              </button>
            </div>
          )}

          {voiceNotice && (
            <div role="status" className="rounded-control border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-fg">
              {voiceNotice}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2 sm:gap-3">
            <FileButton id={camId} iconOnly onFile={(f) => void receipt.scan(f)} disabled={receipt.busy} label="Scan a receipt (camera or photo)" className="shrink-0" />
            <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-surface-2/80 py-1 pl-4 pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
              <label htmlFor="assistant-input" className="sr-only">
                Message {name}
              </label>
              <input
                ref={inputRef}
                id="assistant-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Message ${name}…`}
                autoComplete="off"
                maxLength={2000}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
              />
              <button
                type="submit"
                disabled={!text.trim() || working}
                aria-label="Send message"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-opacity disabled:opacity-30"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </form>
            <button
              type="button"
              onPointerDown={onMicDown}
              onPointerUp={onMicUp}
              onPointerCancel={onMicUp}
              onClick={onMicClick}
              onContextMenu={(e) => e.preventDefault()}
              disabled={voiceMode === "none" || transcribing}
              aria-pressed={listening}
              aria-label={listening ? (recorder.recording ? "Stop recording and send" : "Stop listening") : "Hold to talk (or press Space)"}
              title={voiceMode === "none" ? "Voice input not available in this browser" : voiceMode === "server" ? "Hold to record · tap to start/stop · Space" : "Hold to talk · tap for hands-free · Space"}
              className={cn(
                "relative grid size-16 shrink-0 touch-none select-none place-items-center rounded-full transition-all duration-200",
                "disabled:cursor-not-allowed disabled:opacity-40",
                listening
                  ? "scale-110 bg-ok text-void shadow-[0_0_0_6px_rgba(52,211,153,0.18),0_0_40px_rgba(52,211,153,0.6)]"
                  : "bg-gradient-to-br from-accent to-glow text-void shadow-[0_0_30px_-4px_var(--color-accent)] hover:scale-105",
              )}
            >
              {listening && <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full bg-ok/40" />}
              <svg aria-hidden="true" viewBox="0 0 24 24" className="relative size-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
          </div>
        </section>
      </div>
      {scan && <ReceiptDialog scan={scan} onClose={() => setScan(null)} onSaved={onReceiptSaved} />}
    </main>
  );
}

function WakeIndicator({ enabled, mode, status, name }: { enabled: boolean; mode: string | null; status: string; name: string }) {
  if (!enabled || mode === null) return null;
  const text =
    mode !== "browser"
      ? `“Hey ${name}” needs Chrome or Edge`
      : status === "listening"
        ? `Listening for “Hey ${name}”`
        : status === "blocked"
          ? "Wake word needs mic access"
          : status === "error"
            ? "Wake word paused (speech service unreachable)"
            : `“Hey ${name}” paused`;
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-faint" aria-live="polite">
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", status === "listening" && mode === "browser" ? "animate-pulse bg-accent" : status === "blocked" || status === "error" ? "bg-warn" : "bg-line-strong")}
      />
      <span className="truncate">{text}</span>
    </p>
  );
}

function ReceiptDialog({ scan, onClose, onSaved }: { scan: ScanOutcome; onClose: () => void; onSaved: (e: Expense) => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Mount-only: Escape closes, Tab stays inside the dialog, focus returns to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return closeRef.current();
      if (e.key !== "Tab" || !panelRef.current) return;
      const els = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select,textarea,[href]")];
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const body = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = body;
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-void/75 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md animate-fade-in overflow-y-auto rounded-card border border-line-strong bg-surface p-4 shadow-2xl sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold">
            Confirm receipt
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-fg">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <AddExpenseForm defaultDate={dayKey()} draft={scan} onSaved={onSaved} onCancelDraft={onClose} />
      </div>
    </div>
  );
}

function Caption({ msg, name, currency }: { msg: Msg; name: string; currency: string }) {
  if (msg.role === "user")
    return (
      <div className="flex animate-fade-in justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-3 py-2 text-sm text-fg">
          <span className="sr-only">You: </span>
          {msg.text}
        </p>
      </div>
    );
  if (msg.role === "notice")
    return (
      <p className="animate-fade-in rounded-control border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-fg" role="status">
        {msg.text}
      </p>
    );
  if (msg.role === "error")
    return (
      <p className="animate-fade-in rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
        {msg.text}
      </p>
    );
  return (
    <div className="animate-fade-in">
      {msg.tag && <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-accent/80">☀ {msg.tag}</p>}
      {msg.late && (
        <p className="mb-1 flex items-center gap-1 text-[11px] text-faint">
          <span aria-hidden="true">↳</span> Answered while you asked something else
        </p>
      )}
      <p className="max-w-[92%] rounded-2xl rounded-bl-md border border-line/60 bg-surface-2/80 px-3 py-2 text-sm leading-relaxed text-fg">
        <span className="sr-only">{name}: </span>
        {msg.text}
      </p>
      {msg.stopped && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-faint">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-[2px] bg-faint/70" /> Stopped speaking
        </p>
      )}
      {msg.actions && msg.actions.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Actions taken">
          {msg.actions.map((a, i) => (
            <li
              key={i}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                a.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-danger/40 bg-danger/10 text-danger",
              )}
            >
              <span aria-hidden="true" className="mr-1">{a.ok ? ACTION_ICON[actionKind(a.tool)] : "✕"}</span>
              <span className="sr-only">{a.ok ? "Done: " : "Failed: "}</span>
              {describeAction(a, currency)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IconButton({ label, path, onClick, pressed }: { label: string; path: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={pressed} className="grid size-9 place-items-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </button>
  );
}

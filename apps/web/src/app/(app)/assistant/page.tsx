"use client";

import type { AgentAction } from "@nova/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { describeAction } from "@/components/assistant/actions";
import { Orb, type OrbState } from "@/components/assistant/Orb";
import { useAuth } from "@/components/AuthProvider";
import { useMicLevel } from "@/hooks/useMicLevel";
import { useSpeechRecognition, type RecognitionError } from "@/hooks/useSpeechRecognition";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { notifyDataChanged } from "@/lib/events";
import { useVoicePrefs } from "@/lib/prefs";

type Msg = { id: number; role: "user" | "assistant" | "error"; text: string; actions?: AgentAction[] };

const CONV_KEY = "nova.conversationId";
const HOLD_MS = 350;

const STATUS: Record<OrbState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

const SUGGESTIONS = ["I spent 250 on lunch at Swiggy", "How much did I spend this month?", "Set a food budget of 5000", "Remind me to pay rent tomorrow at 9am"];

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
  const nextId = useRef(1);
  const convRef = useRef<string | undefined>(undefined);
  const busyRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const tts = useSpeechSynthesis();

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
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim().slice(0, 2000);
      if (!message || busyRef.current) return;
      busyRef.current = true;
      tts.cancel();
      push({ role: "user", text: message });
      setPending(null);
      setThinking(true);
      try {
        const res = await api.agent.send({
          message,
          conversationId: convRef.current,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        convRef.current = res.conversationId;
        try {
          window.sessionStorage.setItem(CONV_KEY, res.conversationId);
        } catch {
          /* ignore */
        }
        push({ role: "assistant", text: res.reply, actions: res.actions });
        setPending(res.pendingConfirmation?.summary ?? null);
        if (res.actions.some((a) => a.ok)) notifyDataChanged();
        const p = prefsRef.current;
        if (p.speak && res.reply) tts.speak(res.reply, { voiceURI: p.voiceURI, rate: p.rate, lang: p.lang });
      } catch (err) {
        push({ role: "error", text: errorMessage(err) });
      } finally {
        busyRef.current = false;
        setThinking(false);
      }
    },
    [push, tts],
  );

  const rec = useSpeechRecognition({
    lang: prefs.lang,
    onFinal: (t) => void send(t),
    onSpeechStart: () => tts.cancel(), // never talk over the user
  });
  const mic = useMicLevel(rec.listening);

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

  const orbState: OrbState = demo ?? (rec.listening ? "listening" : thinking ? "thinking" : tts.speaking ? "speaking" : "idle");

  // ---- Push-to-talk: hold = talk while held; quick tap = hands-free until silence / tap again.
  const pressRef = useRef<{ at: number; wasListening: boolean } | null>(null);
  const beginTalk = useCallback(() => {
    tts.cancel();
    rec.clearError();
    rec.start();
  }, [rec, tts]);

  const onMicDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const wasListening = rec.listening;
    pressRef.current = { at: performance.now(), wasListening };
    if (wasListening) rec.stop();
    else beginTalk();
  };
  const onMicUp = () => {
    const p = pressRef.current;
    pressRef.current = null;
    if (!p || p.wasListening) return;
    if (performance.now() - p.at > HOLD_MS) rec.stop();
  };
  const onMicClick = (e: React.MouseEvent) => {
    // Keyboard activation (Enter) arrives as a click with detail 0: toggle.
    if (e.detail !== 0) return;
    if (rec.listening) rec.stop();
    else beginTalk();
  };

  // Space bar = hold to talk (unless typing in a field).
  useEffect(() => {
    const isTyping = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat || rec.supported === false) return;
      if (!rec.listening) beginTalk();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      rec.stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [rec, beginTalk]);

  // Keep the caption log scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = text;
    setText("");
    void send(t);
  }

  function newConversation() {
    tts.cancel();
    rec.abort();
    convRef.current = undefined;
    try {
      window.sessionStorage.removeItem(CONV_KEY);
    } catch {
      /* ignore */
    }
    setMessages([]);
    setPending(null);
  }

  const voiceError = rec.error ? RECOGNITION_ERRORS[rec.error] : mic.error === "denied" ? RECOGNITION_ERRORS["not-allowed"] : null;

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-void text-fg">
      {/* Backdrop: starfield + nebula glow */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,rgba(79,70,229,0.18),transparent_60%),radial-gradient(ellipse_at_80%_90%,rgba(45,212,191,0.10),transparent_55%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(1px_1px_at_20px_30px,#fff8,transparent),radial-gradient(1px_1px_at_120px_80px,#fff6,transparent),radial-gradient(1.5px_1.5px_at_200px_160px,#a5f3fc88,transparent),radial-gradient(1px_1px_at_60px_190px,#fff5,transparent)] [background-size:240px_220px]" />

      <div className="relative mx-auto grid h-[calc(100dvh-3.5rem)] w-full max-w-6xl grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-4 pb-4 pt-3 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-x-8">
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
              {STATUS[orbState]}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              label={prefs.speak ? "Mute spoken replies" : "Unmute spoken replies"}
              pressed={!prefs.speak}
              onClick={() => {
                if (prefs.speak) tts.cancel();
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
          <div className="relative aspect-square h-full max-h-[min(30rem,42dvh)] w-auto max-w-full lg:max-h-[30rem]">
            <Orb state={orbState} levelRef={mic.levelRef} label={`${name} is ${STATUS[orbState].replace("…", "").toLowerCase()}`} />
          </div>
          <div className="min-h-[3.5rem] w-full max-w-xl px-2 text-center" aria-live="polite">
            {rec.listening ? (
              <p className="text-lg font-medium leading-snug text-fg sm:text-xl">
                {rec.interim || <span className="text-muted">Go ahead, I&apos;m listening…</span>}
                <span aria-hidden="true" className="ml-1 inline-block h-5 w-0.5 translate-y-1 animate-pulse bg-accent" />
              </p>
            ) : thinking ? (
              <p className="text-sm text-muted">Working on it…</p>
            ) : pending ? null : (
              <p className="text-sm text-faint">
                {rec.supported === false ? "Type a message below" : "Hold the mic or press Space to talk"}
              </p>
            )}
          </div>
          {pending && !thinking && (
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
                <div className="flex flex-wrap gap-2">
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

          {(rec.supported === false || voiceError) && (
            <div role="status" className="rounded-control border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-fg">
              {rec.supported === false
                ? "Voice input isn't supported in this browser (Firefox doesn't have speech recognition). Use Chrome, Edge or Safari for voice — or just type below."
                : voiceError}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-end gap-3">
            <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-surface-2/80 py-1 pl-4 pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
              <label htmlFor="assistant-input" className="sr-only">
                Message {name}
              </label>
              <input
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
                disabled={!text.trim() || thinking}
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
              disabled={rec.supported === false}
              aria-pressed={rec.listening}
              aria-label={rec.listening ? "Stop listening" : "Hold to talk (or press Space)"}
              title={rec.supported === false ? "Voice input not supported in this browser" : "Hold to talk · tap for hands-free · Space"}
              className={cn(
                "relative grid size-16 shrink-0 touch-none select-none place-items-center rounded-full transition-all duration-200",
                "disabled:cursor-not-allowed disabled:opacity-40",
                rec.listening
                  ? "scale-110 bg-ok text-void shadow-[0_0_0_6px_rgba(52,211,153,0.18),0_0_40px_rgba(52,211,153,0.6)]"
                  : "bg-gradient-to-br from-accent to-glow text-void shadow-[0_0_30px_-4px_var(--color-accent)] hover:scale-105",
              )}
            >
              {rec.listening && <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full bg-ok/40" />}
              <svg aria-hidden="true" viewBox="0 0 24 24" className="relative size-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
          </div>
        </section>
      </div>
    </main>
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
  if (msg.role === "error")
    return (
      <p className="animate-fade-in rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
        {msg.text}
      </p>
    );
  return (
    <div className="animate-fade-in">
      <p className="max-w-[92%] rounded-2xl rounded-bl-md border border-line/60 bg-surface-2/80 px-3 py-2 text-sm leading-relaxed text-fg">
        <span className="sr-only">{name}: </span>
        {msg.text}
      </p>
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
              {a.ok ? "✓ " : "✕ "}
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

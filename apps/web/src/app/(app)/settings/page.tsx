"use client";

import { guessVoiceGender, UpdateMeSchema, type NaturalVoicesResult, type VoiceStyle } from "@nova/shared";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button, Card, Notice, SelectField, TextField } from "@/components/ui";
import { useSpeech } from "@/hooks/useSpeech";
import { api, errorMessage, fieldErrors, zodFieldErrors } from "@/lib/api";
import { cn } from "@/lib/cn";
import { notifyDataChanged } from "@/lib/events";
import { loadNaturalVoices } from "@/lib/naturalVoice";
import { useVoicePrefs, type VoiceEngine } from "@/lib/prefs";

const LANGS = [
  { value: "en-IN", label: "English (India)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "hi-IN", label: "Hindi (India)" },
];

export default function SettingsPage() {
  const { user, setUser } = useAuth();
  const [assistantName, setAssistantName] = useState(user?.assistantName ?? "Nova");
  const [nameError, setNameError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useVoicePrefs();
  const tts = useSpeech();
  const [srSupported, setSrSupported] = useState<boolean | null>(null);

  useEffect(() => {
    if (user) setAssistantName(user.assistantName);
  }, [user]);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setSrSupported(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);

  // English + Hindi voices first, then everything else.
  const voices = useMemo(() => {
    const score = (l: string) => (l.startsWith("en-IN") || l.startsWith("hi") ? 0 : l.startsWith("en") ? 1 : 2);
    return [...tts.voices].sort((a, b) => score(a.lang) - score(b.lang) || a.name.localeCompare(b.name));
  }, [tts.voices]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setFormError(null);
    const parsed = UpdateMeSchema.safeParse({ assistantName: assistantName.trim() });
    if (!parsed.success) return setNameError(zodFieldErrors(parsed.error).assistantName ?? "Use 1–30 characters.");
    setNameError(undefined);
    setBusy(true);
    try {
      const { user: updated } = await api.auth.updateMe(parsed.data);
      setUser(updated);
      setSaved(true);
    } catch (err) {
      const fe = fieldErrors(err);
      if (fe.assistantName) setNameError(fe.assistantName);
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const name = user?.assistantName ?? "Nova";

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-6 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent/80">Settings</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Your assistant</h1>

      <div className="mt-6 grid gap-4">
        <Card title="Name">
          <form onSubmit={saveName} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <TextField
              label="Assistant name"
              value={assistantName}
              maxLength={30}
              onChange={(e) => {
                setAssistantName(e.target.value);
                setSaved(false);
              }}
              error={nameError}
              hint="What you call your assistant, e.g. Jarvis or Friday."
              className="flex-1"
            />
            <Button type="submit" loading={busy} className="sm:mt-[1.4rem]">
              Save
            </Button>
          </form>
          {formError && <Notice tone="danger" className="mt-3">{formError}</Notice>}
          {saved && (
            <p role="status" className="mt-3 text-sm text-ok">
              Saved — say hi to {name}.
            </p>
          )}
        </Card>

        <CityCard />

        <Card title="Assistant behaviour">
          <div className="grid gap-4">
            <Toggle
              checked={prefs.wakeWord}
              onChange={(v) => setPrefs({ wakeWord: v })}
              label={`Wake word: “Hey ${name}”`}
              description={
                srSupported === false
                  ? "Needs Chrome or Edge (this browser has no speech recognition)."
                  : `While the assistant page is open and visible, ${name} listens in the background for “Hey ${name}”. Say a command right after it, e.g. “Hey ${name}, what's the weather?”. Audio goes to your browser's speech service.`
              }
            />
            <Toggle
              checked={prefs.bargeIn && srSupported !== false}
              disabled={srSupported === false}
              onChange={(v) => setPrefs({ bargeIn: v })}
              label="Interrupt by voice"
              description={
                srSupported === false
                  ? "Needs Chrome or Edge. You can still interrupt with the mic button, Space or by tapping the orb."
                  : `While ${name} is speaking, just start talking to cut in. Works best with headphones: on speakers ${name} may hear itself (its own words are filtered out). You can always interrupt with the mic, Space or by tapping the orb.`
              }
            />
            <Toggle
              checked={prefs.autoBriefing}
              onChange={(v) => setPrefs({ autoBriefing: v })}
              label="Auto-briefing"
              description={`The first time you open the assistant each day, ${name} reads you the weather, what's due and your spending.`}
            />
          </div>
        </Card>

        <Card title="Voice">
          {tts.supported === false ? (
            <Notice tone="warn">This browser can&apos;t speak replies (no speechSynthesis). Replies will be shown as text.</Notice>
          ) : (
            <div className="grid gap-4">
              <EngineSwitch value={prefs.engine} onChange={(engine) => setPrefs({ engine })} />
              {prefs.engine === "natural" && (
                <NaturalVoiceSection
                  voice={prefs.naturalVoice}
                  onVoice={(naturalVoice) => setPrefs({ naturalVoice })}
                  onPreview={(voice) =>
                    tts.speaking
                      ? tts.cancel()
                      : tts.speak(`Hi, I'm ${name}. You spent two hundred and fifty rupees on food today.`, {
                          engine: "natural",
                          naturalVoice: voice,
                          voiceURI: prefs.voiceURI,
                          style: prefs.voiceStyle,
                          rate: prefs.rate,
                          lang: prefs.lang,
                        })
                  }
                  previewing={tts.speaking}
                  notice={tts.notice}
                />
              )}
              <p className="-mb-1 text-xs font-medium uppercase tracking-wider text-faint">
                {prefs.engine === "natural" ? "Device voice (used when the natural voice isn't available)" : "Device voice"}
              </p>
              <SelectField
                label="Voice style"
                value={prefs.voiceStyle}
                onChange={(e) => setPrefs({ voiceStyle: e.target.value as VoiceStyle, voiceURI: "" })}
                hint="Picks the best matching voice this browser has, preferring Indian English."
              >
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="any">Browser default</option>
              </SelectField>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <SelectField label="Reply voice" value={prefs.voiceURI} onChange={(e) => setPrefs({ voiceURI: e.target.value })} hint={voices.length ? `${voices.length} voices available in this browser` : "Loading voices…"}>
                  <option value="">Automatic (matches voice style)</option>
                  {voices.map((v) => {
                    const g = guessVoiceGender({ id: v.voiceURI, name: v.name });
                    return (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} ({v.lang}){g ? ` · ${g}` : ""}{v.localService ? "" : " · online"}
                      </option>
                    );
                  })}
                </SelectField>
                <Button variant="secondary" className="sm:mb-[1.4rem]" onClick={() => tts.speak(`Hi, I'm ${name}. You spent two hundred and fifty rupees on food today.`, { engine: "device", voiceURI: prefs.voiceURI, style: prefs.voiceStyle, rate: prefs.rate, lang: prefs.lang })}>
                  {tts.speaking ? "Playing…" : "Preview"}
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rate" className="flex justify-between text-xs font-medium tracking-wide text-muted">
                  <span>Speaking speed</span>
                  <span className="tabular-nums text-fg">{prefs.rate.toFixed(1)}×</span>
                </label>
                <input id="rate" type="range" min={0.7} max={1.5} step={0.1} value={prefs.rate} onChange={(e) => setPrefs({ rate: Number(e.target.value) })} className="accent-[var(--color-accent)]" />
              </div>
              <label className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={prefs.speak} onChange={(e) => setPrefs({ speak: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
                Speak replies aloud
              </label>
            </div>
          )}
        </Card>

        <Card title="Listening">
          <SelectField label="Speech recognition language" value={prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value })} hint="Used by your browser's speech recognition. en-IN understands Indian English and ₹ amounts best.">
            {LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </SelectField>
        </Card>
        <p className="text-xs text-faint">Voice, wake word and briefing settings are saved in this browser only.</p>
      </div>
    </main>
  );
}

const TERMS_URL = "https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english";

function EngineSwitch({ value, onChange }: { value: VoiceEngine; onChange: (v: VoiceEngine) => void }) {
  const opts: { v: VoiceEngine; label: string; sub: string }[] = [
    { v: "device", label: "Device voice", sub: "Instant, offline-capable" },
    { v: "natural", label: "Natural voice (AI)", sub: "More human, needs the API" },
  ];
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium tracking-wide text-muted">Voice engine</legend>
      <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
        {opts.map((o) => (
          <label
            key={o.v}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 transition-colors",
              value === o.v ? "border-accent bg-accent/10" : "border-line bg-surface-2/60 hover:border-line-strong",
            )}
          >
            <input type="radio" name="voice-engine" value={o.v} checked={value === o.v} onChange={() => onChange(o.v)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{o.label}</span>
              <span className="block text-xs text-faint">{o.sub}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NaturalVoiceSection({
  voice,
  onVoice,
  onPreview,
  previewing,
  notice,
}: {
  voice: string;
  onVoice: (v: string) => void;
  onPreview: (v: string) => void;
  previewing: boolean;
  notice: string | null;
}) {
  const [info, setInfo] = useState<NaturalVoicesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadNaturalVoices(true)
      .then((r) => live && setInfo(r))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Notice tone="warn">Couldn&apos;t check the natural voice: {error} Replies will use the device voice.</Notice>;
  if (!info) return <p className="text-xs text-faint">Checking the natural voice…</p>;
  if (!info.available)
    return (
      <Notice tone="warn">
        {info.reason === "TERMS_REQUIRED" ? (
          <>
            The natural voice isn&apos;t enabled yet. The Groq account owner needs to accept the Orpheus terms at{" "}
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-accent underline underline-offset-2">
              {TERMS_URL}
            </a>
            . Until then, replies use the device voice below.
          </>
        ) : info.reason === "NO_KEY" ? (
          "The natural voice isn't set up on the server (no Groq API key). Replies use the device voice below."
        ) : (
          "The natural voice is unavailable right now. Replies use the device voice below."
        )}
      </Notice>
    );

  // Female voices first, each labelled with its gender.
  const rank = (g?: string) => (g === "female" ? 0 : g === "male" ? 1 : 2);
  const voices = [...info.voices].sort((a, b) => rank(a.gender) - rank(b.gender) || a.id.localeCompare(b.id));
  const current = voices.some((v) => v.id === voice) ? voice : (info.defaultVoice ?? voices[0]?.id ?? "");
  const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  return (
    <div className="grid gap-2">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <SelectField label="Natural voice" value={current} onChange={(e) => onVoice(e.target.value)} hint={`${voices.length} voices · default ${title(info.defaultVoice ?? current)}`}>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {title(v.id)}
              {v.gender ? ` · ${v.gender}` : ""}
              {v.id === info.defaultVoice ? " (default)" : ""}
            </option>
          ))}
        </SelectField>
        <Button variant="secondary" className="sm:mb-[1.4rem]" onClick={() => onPreview(current)}>
          {previewing ? "Stop" : "Preview"}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Free tier: about 100 spoken replies per day across all users, and it starts speaking about a second after a reply arrives. When it&apos;s unavailable or the limit is reached, the device voice takes over automatically.
      </p>
      {notice && <Notice tone="warn">{notice}</Notice>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <p id={`${id}-d`} className="mt-0.5 text-xs leading-relaxed text-faint">
          {description}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={`${id}-d`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "border-accent bg-accent/80" : "border-line-strong bg-surface-3",
        )}
      >
        <span aria-hidden="true" className={cn("absolute top-0.5 size-4.5 rounded-full bg-fg shadow transition-[left]", checked ? "left-[1.4rem]" : "left-0.5")} />
      </button>
    </div>
  );
}

function CityCard() {
  const { user, setUser } = useAuth();
  const [city, setCity] = useState(user?.city ?? "");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCity(user?.city ?? ""), [user?.city]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return; // ref, not state: blocks same-tick double submits
    setSaved(null);
    const value = city.trim();
    if (value.length > 80) return setError("Use at most 80 characters.");
    setError(undefined);
    submitting.current = true;
    setBusy(true);
    try {
      const { user: updated } = await api.auth.updateMe({ city: value });
      setUser(updated);
      setCity(updated.city ?? "");
      setSaved(updated.city ? `Weather will be for ${updated.city}.` : "Home city cleared.");
      notifyDataChanged();
    } catch (err) {
      // Unknown city → 400 VALIDATION_ERROR with a field message; show the API's words.
      setError(fieldErrors(err).city ?? errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Card title="Home city">
      <form onSubmit={save} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          label="City"
          value={city}
          maxLength={80}
          autoComplete="address-level2"
          placeholder="Bengaluru"
          onChange={(e) => {
            setCity(e.target.value);
            setSaved(null);
            setError(undefined);
          }}
          error={error}
          hint="Used for the weather in your daily briefing. Leave empty to turn weather off."
          className="flex-1"
        />
        <Button type="submit" loading={busy} className="sm:mt-[1.4rem]">
          Save
        </Button>
      </form>
      {saved && (
        <p role="status" className="mt-3 text-sm text-ok">
          {saved}
        </p>
      )}
    </Card>
  );
}

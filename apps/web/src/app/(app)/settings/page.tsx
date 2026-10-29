"use client";

import { UpdateMeSchema } from "@nova/shared";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button, Card, Notice, SelectField, TextField } from "@/components/ui";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import { api, errorMessage, fieldErrors, zodFieldErrors } from "@/lib/api";
import { useVoicePrefs } from "@/lib/prefs";

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
  const tts = useSpeechSynthesis();

  useEffect(() => {
    if (user) setAssistantName(user.assistantName);
  }, [user]);

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

        <Card title="Voice">
          {tts.supported === false ? (
            <Notice tone="warn">This browser can&apos;t speak replies (no speechSynthesis). Replies will be shown as text.</Notice>
          ) : (
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <SelectField label="Reply voice" value={prefs.voiceURI} onChange={(e) => setPrefs({ voiceURI: e.target.value })} hint={voices.length ? `${voices.length} voices available in this browser` : "Loading voices…"}>
                  <option value="">Browser default</option>
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang}){v.localService ? "" : " · online"}
                    </option>
                  ))}
                </SelectField>
                <Button variant="secondary" className="sm:mb-[1.4rem]" onClick={() => tts.speak(`Hi, I'm ${name}. You spent two hundred and fifty rupees on food today.`, { voiceURI: prefs.voiceURI, rate: prefs.rate, lang: prefs.lang })}>
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
        <p className="text-xs text-faint">Voice settings are saved in this browser only.</p>
      </div>
    </main>
  );
}

import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_VOICE_STYLE, guessVoiceGender, pickVoice, type VoiceStyle } from "@nova/shared";

/**
 * Which device voice Nova speaks with. The user picks a style (female by default) and can
 * optionally pin an exact voice; both persist in SecureStore like the other prefs.
 */

const STYLE_KEY = "nova.voiceStyle";
const VOICE_KEY = "nova.voiceId";
const LANG = "en-IN";

type TtsState = { style: VoiceStyle; voiceId: string; voices: Speech.Voice[] };

let state: TtsState = { style: DEFAULT_VOICE_STYLE, voiceId: "", voices: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<TtsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

let loading: Promise<void> | null = null;

/** Loads prefs and the device's voice list. Android can return [] until its TTS engine is up, so an empty list is retried next time. */
function load(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const [style, voiceId, voices] = await Promise.all([
      SecureStore.getItemAsync(STYLE_KEY).catch(() => null),
      SecureStore.getItemAsync(VOICE_KEY).catch(() => null),
      Speech.getAvailableVoicesAsync().catch(() => [] as Speech.Voice[]),
    ]);
    set({
      style: style === "female" || style === "male" || style === "any" ? style : DEFAULT_VOICE_STYLE,
      voiceId: voiceId ?? "",
      voices,
    });
    if (!voices.length) loading = null;
  })();
  return loading;
}
void load();

/** English voices on this device that match the style ("any" = all of them). */
export function voicesForStyle(voices: Speech.Voice[], style: VoiceStyle) {
  return voices
    .filter((v) => v.language.toLowerCase().startsWith("en"))
    .filter((v) => style === "any" || guessVoiceGender({ id: v.identifier, name: v.name }) === style);
}

/** The voice identifier to speak with, or undefined for the platform default. */
function resolveVoice(): string | undefined {
  const { style, voiceId, voices } = state;
  if (voiceId && voices.some((v) => v.identifier === voiceId)) return voiceId;
  const mapped = voices.map((v) => ({ id: v.identifier, name: v.name, lang: v.language, quality: v.quality }));
  return pickVoice(mapped, style, LANG)?.id;
}

/** Drop-in for `Speech.speak` that applies the user's voice. */
export function speak(text: string, options: Speech.SpeechOptions = {}) {
  const go = () => Speech.speak(text, { language: LANG, ...options, voice: options.voice ?? resolveVoice() });
  // Voices normally load at startup; if not yet, wait briefly rather than speak in the wrong voice.
  if (state.voices.length) go();
  else void Promise.race([load(), new Promise((r) => setTimeout(r, 800))]).then(go);
}

/** Settings hook. */
export function useTtsVoice() {
  const [snap, setSnap] = useState(state);
  useEffect(() => {
    const l = () => setSnap(state);
    listeners.add(l);
    void load();
    return () => void listeners.delete(l);
  }, []);

  const setStyle = useCallback((style: VoiceStyle) => {
    set({ style, voiceId: "" });
    void SecureStore.setItemAsync(STYLE_KEY, style).catch(() => {});
    void SecureStore.deleteItemAsync(VOICE_KEY).catch(() => {});
  }, []);

  const setVoiceId = useCallback((voiceId: string) => {
    set({ voiceId });
    void SecureStore.setItemAsync(VOICE_KEY, voiceId).catch(() => {});
  }, []);

  const current = snap.voices.find((v) => v.identifier === resolveVoice());
  return { ...snap, current, setStyle, setVoiceId };
}

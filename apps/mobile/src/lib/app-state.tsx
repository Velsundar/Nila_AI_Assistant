import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** Persisted boolean preferences (SecureStore, "1"/"0"). Defaults: only speakReplies is on. */
const PREFS = {
  speakReplies: { key: "nova.speakReplies", default: true },
  wakeWord: { key: "nova.wakeWord", default: false },
  autoBriefing: { key: "nova.autoBriefing", default: false },
  weeklyReportNotification: { key: "nova.weeklyReportNotif", default: false },
} as const;

export type PrefName = keyof typeof PREFS;
type Prefs = Record<PrefName, boolean>;

/** Something another part of the app (e.g. a tapped notification) wants the assistant to do. */
export type AssistantIntent = { kind: "weeklyReport" | "briefing"; id: string };

type AppStateValue = Prefs & {
  /** Persist a preference. */
  setPref: (name: PrefName, value: boolean) => void;
  /** Read assistant replies aloud with TTS. (Kept for existing callers.) */
  setSpeakReplies: (v: boolean) => void;
  /** Bumped whenever data changed elsewhere (e.g. the assistant ran a tool) so screens can refetch. */
  dataVersion: number;
  invalidateData: () => void;
  /** Queued intent for the assistant screen; it clears it once handled. */
  pendingIntent: AssistantIntent | null;
  setPendingIntent: (i: AssistantIntent | null) => void;
};

const AppStateContext = createContext<AppStateValue | null>(null);

const defaults = Object.fromEntries(Object.entries(PREFS).map(([k, v]) => [k, v.default])) as Prefs;

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(defaults);
  const [dataVersion, setDataVersion] = useState(0);
  const [pendingIntent, setPendingIntent] = useState<AssistantIntent | null>(null);

  useEffect(() => {
    let cancelled = false;
    (Object.keys(PREFS) as PrefName[]).forEach((name) => {
      SecureStore.getItemAsync(PREFS[name].key)
        .then((v) => {
          if (!cancelled && v !== null) setPrefs((p) => ({ ...p, [name]: v === "1" }));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPref = useCallback((name: PrefName, value: boolean) => {
    setPrefs((p) => ({ ...p, [name]: value }));
    SecureStore.setItemAsync(PREFS[name].key, value ? "1" : "0").catch(() => {});
  }, []);

  const setSpeakReplies = useCallback((v: boolean) => setPref("speakReplies", v), [setPref]);
  const invalidateData = useCallback(() => setDataVersion((n) => n + 1), []);

  const value = useMemo(
    () => ({ ...prefs, setPref, setSpeakReplies, dataVersion, invalidateData, pendingIntent, setPendingIntent }),
    [prefs, setPref, setSpeakReplies, dataVersion, invalidateData, pendingIntent],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used inside <AppStateProvider>");
  return ctx;
}

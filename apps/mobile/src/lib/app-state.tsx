import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const SPEAK_KEY = "nova.speakReplies";

type AppStateValue = {
  /** Read assistant replies aloud with TTS. */
  speakReplies: boolean;
  setSpeakReplies: (v: boolean) => void;
  /** Bumped whenever data changed elsewhere (e.g. the assistant ran a tool) so screens can refetch. */
  dataVersion: number;
  invalidateData: () => void;
};

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [speakReplies, setSpeak] = useState(true);
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    SecureStore.getItemAsync(SPEAK_KEY)
      .then((v) => {
        if (v !== null) setSpeak(v === "1");
      })
      .catch(() => {});
  }, []);

  const setSpeakReplies = useCallback((v: boolean) => {
    setSpeak(v);
    SecureStore.setItemAsync(SPEAK_KEY, v ? "1" : "0").catch(() => {});
  }, []);

  const invalidateData = useCallback(() => setDataVersion((n) => n + 1), []);

  const value = useMemo(
    () => ({ speakReplies, setSpeakReplies, dataVersion, invalidateData }),
    [speakReplies, setSpeakReplies, dataVersion, invalidateData],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used inside <AppStateProvider>");
  return ctx;
}

import * as Speech from "expo-speech";
import { speak as speakWithVoice } from "@/lib/tts";
import { useCallback, useEffect, useState } from "react";

/** Read-aloud toggle for cards (briefing, weekly report). Stops when the screen unmounts. */
export function useSpeaker(lang = "en-IN") {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => () => void Speech.stop(), []);

  const stop = useCallback(() => {
    void Speech.stop();
    setSpeaking(false);
  }, []);

  const toggle = useCallback(
    (text: string) => {
      if (speaking) return stop();
      if (!text.trim()) return;
      void Speech.stop();
      setSpeaking(true);
      speakWithVoice(text, {
        language: lang,
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      });
    },
    [speaking, stop, lang],
  );

  return { speaking, toggle, stop };
}

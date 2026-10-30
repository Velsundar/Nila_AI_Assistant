import { useCallback, useEffect, useRef, useState } from "react";

import { speak as speakWithVoice, stop as stopSpeech } from "@/lib/tts";

/**
 * Read-aloud toggle for cards (briefing, weekly report). Uses whichever engine the user picked
 * (phone or natural voice). Stops when the screen unmounts.
 */
export function useSpeaker(lang = "en-IN") {
  const [speaking, setSpeaking] = useState(false);
  const mine = useRef(false);

  useEffect(
    () => () => {
      if (mine.current) stopSpeech();
    },
    [],
  );

  const stop = useCallback(() => {
    if (mine.current) stopSpeech();
    mine.current = false;
    setSpeaking(false);
  }, []);

  const toggle = useCallback(
    (text: string) => {
      if (speaking) return stop();
      if (!text.trim()) return;
      const end = () => {
        mine.current = false;
        setSpeaking(false);
      };
      speakWithVoice(text, { language: lang, onDone: end, onStopped: end, onError: end });
      mine.current = true;
      setSpeaking(true);
    },
    [speaking, stop, lang],
  );

  return { speaking, toggle, stop };
}

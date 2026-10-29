import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type ScrollViewInstance,
  type TextInputInstance,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ASSISTANT_NAME, type AgentAction } from "@nova/shared";

import { MicButton } from "@/components/MicButton";
import { Orb, type OrbState } from "@/components/Orb";
import { Banner } from "@/components/ui";
import { Colors, Font, HitSize, OrbColors, Radius, Spacing } from "@/constants/theme";
import { useVoice } from "@/hooks/useVoice";
import { describeAction } from "@/lib/actions";
import { api, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { deviceTimezone, localISODate } from "@/lib/format";

type Caption = {
  id: number;
  role: "user" | "assistant";
  text: string;
  actions?: AgentAction[];
  failed?: boolean;
};

const STATUS: Record<OrbState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const LAST_AUTO_BRIEFING_KEY = "nova.lastAutoBriefing";

/** Personal-assistant starters shown before the first message. */
const SUGGESTIONS = [
  "Brief me on my day",
  "Add milk and eggs to my shopping list",
  "What's on my to-do list today?",
  "Note: parked on level 3, spot B12",
  "Remind me to call mom at 7pm",
  "What's the weather tomorrow?",
  "I spent 250 on lunch",
  "How much did I spend this week?",
];

export default function AssistantScreen() {
  const { user } = useAuth();
  const { speakReplies, invalidateData, wakeWord, autoBriefing, pendingIntent, setPendingIntent } = useAppState();
  const assistantName = user?.assistantName || ASSISTANT_NAME;
  const { width, height } = useWindowDimensions();
  const orbSize = Math.round(Math.max(110, Math.min(width * 0.5, height * 0.24, 240)));

  const [captions, setCaptions] = useState<Caption[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ summary: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** Synchronous guard: `sending` state is stale inside closures, so two quick taps could both send. */
  const busyRef = useRef(false);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(1);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const inputRef = useRef<TextInputInstance>(null);
  const speakRef = useRef<(t: string) => void>(() => {});

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const push = useCallback((c: Omit<Caption, "id">) => {
    setCaptions((prev) => [...prev.slice(-49), { ...c, id: nextId.current++ }]);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busyRef.current) return;
      busyRef.current = true;
      setNotice(null);
      setPending(null);
      push({ role: "user", text: message });
      setSending(true);
      try {
        const res = await api.agent.send({
          message,
          conversationId: conversationId.current,
          timezone: deviceTimezone(),
        });
        conversationId.current = res.conversationId;
        push({ role: "assistant", text: res.reply, actions: res.actions });
        setPending(res.pendingConfirmation ?? null);
        if (res.actions?.some((a) => a.ok)) invalidateData();
        if (speakReplies) speakRef.current(res.reply);
      } catch (e) {
        push({ role: "assistant", text: errorMessage(e), failed: true });
      } finally {
        busyRef.current = false;
        setSending(false);
      }
    },
    [push, invalidateData, speakReplies],
  );

  /** Briefing / weekly report straight from REST (no agent, no AI tokens) and always spoken. */
  const readOut = useCallback(
    async (kind: "briefing" | "weeklyReport", prompt: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setNotice(null);
      push({ role: "user", text: prompt });
      setSending(true);
      try {
        const text =
          kind === "briefing"
            ? (await api.briefing.today({ tz: deviceTimezone() })).text
            : (await api.reports.weekly({ tz: deviceTimezone() })).text;
        push({
          role: "assistant",
          text,
          actions: [{ tool: kind === "briefing" ? "getDailyBriefing" : "getWeeklyReport", args: {}, ok: true }],
        });
        speakRef.current(text);
      } catch (e) {
        push({ role: "assistant", text: errorMessage(e), failed: true });
      } finally {
        busyRef.current = false;
        setSending(false);
      }
    },
    [push],
  );
  const briefMe = useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    void readOut("briefing", "Brief me");
  }, [readOut]);

  const voice = useVoice({
    onFinalTranscript: (text) => void send(text),
    wakeWord: {
      enabled: wakeWord,
      active: focused && !sending,
      name: assistantName,
      onCommand: (cmd) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        void send(cmd);
      },
      onWake: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
    },
  });
  speakRef.current = voice.speak;

  const orbState: OrbState = voice.listening
    ? "listening"
    : sending || voice.transcribing
      ? "thinking"
      : voice.speaking
        ? "speaking"
        : "idle";

  // A tapped notification (e.g. the Sunday weekly report) queued something for us.
  useEffect(() => {
    if (!pendingIntent || !focused) return;
    setPendingIntent(null);
    void readOut(pendingIntent.kind, pendingIntent.kind === "weeklyReport" ? "Read my weekly report" : "Brief me");
  }, [pendingIntent, focused, setPendingIntent, readOut]);

  // Optional auto-briefing: once per day, the first time the assistant is opened.
  useEffect(() => {
    if (!autoBriefing || !focused) return;
    let cancelled = false;
    (async () => {
      const today = localISODate();
      const last = await SecureStore.getItemAsync(LAST_AUTO_BRIEFING_KEY).catch(() => null);
      if (cancelled || last === today) return;
      await SecureStore.setItemAsync(LAST_AUTO_BRIEFING_KEY, today).catch(() => {});
      if (!cancelled) void readOut("briefing", "Good morning — brief me");
    })();
    return () => {
      cancelled = true;
    };
  }, [autoBriefing, focused, readOut]);

  const startTalking = useCallback(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (!voice.available) {
      setNotice("Voice input isn't available right now. Type your message below instead.");
      inputRef.current?.focus();
      return;
    }
    await voice.startListening();
  }, [voice]);

  const stopTalking = useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    voice.stopListening();
  }, [voice]);

  const submitDraft = () => {
    const text = draft;
    setDraft("");
    voice.stopSpeaking();
    void send(text);
  };

  const onActionPress = (a: AgentAction) => {
    const route = describeAction(a).route;
    if (route) router.navigate(route);
  };

  const statusText = voice.transcribing ? "Transcribing…" : orbState === "idle" && voice.wakeListening ? `Say "Hey ${assistantName}"` : STATUS[orbState];
  const hint =
    voice.mode === "native"
      ? `Tap the mic to talk · hold for push-to-talk${wakeWord ? ` · or say "Hey ${assistantName}"` : ""}`
      : voice.mode === "server"
        ? "Hold the mic to talk (or tap to start, tap to send)"
        : "Text mode — voice input is unavailable";

  const banner = voice.error ?? notice;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 50 : 0}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.kicker}>YOUR ASSISTANT</Text>
            <Text style={styles.name} accessibilityRole="header">
              {assistantName}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <View
              style={[styles.statusPill, { borderColor: OrbColors[orbState] }]}
              accessibilityLabel={`Status: ${statusText}`}
              accessibilityLiveRegion="polite"
            >
              {voice.wakeListening && orbState === "idle" ? (
                <Ionicons name="ear-outline" size={12} color={OrbColors[orbState]} />
              ) : (
                <View style={[styles.statusDot, { backgroundColor: OrbColors[orbState] }]} />
              )}
              <Text style={[styles.statusText, { color: OrbColors[orbState] }]} numberOfLines={1}>
                {statusText}
              </Text>
            </View>
            <Pressable
              onPress={briefMe}
              disabled={sending}
              accessibilityRole="button"
              accessibilityLabel="Brief me"
              accessibilityHint="Reads today's briefing aloud: weather, reminders, tasks and spending"
              accessibilityState={{ disabled: sending }}
              style={({ pressed }) => [styles.briefBtn, (pressed || sending) && { opacity: 0.6 }]}
            >
              <Ionicons name="sunny-outline" size={16} color={Colors.warning} />
              <Text style={styles.briefText}>Brief me</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.orbArea}>
          <Orb state={orbState} size={orbSize} volume={voice.volume} />
          <Text style={styles.interim} numberOfLines={3} accessibilityLiveRegion="polite">
            {voice.listening
              ? voice.interim || (voice.mode === "server" ? "Recording… release to send" : "Go ahead, I'm listening…")
              : voice.transcribing
                ? "Transcribing…"
                : sending
                  ? "…"
                  : captions.length === 0
                    ? `Ask me anything — expenses, tasks, notes, reminders, weather.`
                    : ""}
          </Text>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.log}
          contentContainerStyle={styles.logContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Conversation captions"
        >
          {captions.map((c) => (
            <View key={c.id} style={[styles.caption, c.role === "user" ? styles.userCaption : styles.botCaption]}>
              <Text style={styles.captionRole}>{c.role === "user" ? "You" : assistantName}</Text>
              <Text style={[styles.captionText, c.failed && { color: Colors.danger }]} selectable>
                {c.text}
              </Text>
              {!!c.actions?.length && (
                <View style={styles.chips}>
                  {c.actions.map((a, i) => {
                    const chip = describeAction(a);
                    return (
                      <Pressable
                        key={`${a.tool}-${i}`}
                        onPress={() => onActionPress(a)}
                        disabled={!chip.route}
                        accessibilityRole={chip.route ? "button" : "text"}
                        accessibilityLabel={`${chip.label} ${a.ok ? "succeeded" : `failed${a.error ? `: ${a.error}` : ""}`}`}
                        accessibilityHint={chip.route === "/expenses" ? "Opens the expenses tab" : chip.route === "/today" ? "Opens the today tab" : undefined}
                        style={[styles.chip, { borderColor: a.ok ? Colors.success : Colors.danger }]}
                      >
                        <Ionicons name={a.ok ? chip.icon : "alert-circle"} size={14} color={a.ok ? Colors.success : Colors.danger} />
                        <Text style={styles.chipText}>{chip.label}</Text>
                        {chip.route && <Ionicons name="chevron-forward" size={12} color={Colors.textFaint} />}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          ))}
        </ScrollView>

        {captions.length === 0 && !voice.listening && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.suggestScroll}
            contentContainerStyle={styles.suggestions}
            keyboardShouldPersistTaps="handled"
            accessibilityLabel="Suggestions"
          >
            {SUGGESTIONS.map((sg) => (
              <Pressable
                key={sg}
                onPress={() => (sg === "Brief me on my day" ? briefMe() : void send(sg))}
                disabled={sending}
                accessibilityRole="button"
                accessibilityLabel={`Suggestion: ${sg}`}
                style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: Colors.surfaceAlt }]}
              >
                <Text style={styles.suggestionText}>{sg}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {pending && !sending && (
          <View style={styles.confirm} accessibilityLiveRegion="assertive">
            <Text style={styles.confirmTitle}>Confirm</Text>
            <Text style={styles.confirmText}>{pending.summary}</Text>
            <View style={styles.confirmRow}>
              <Pressable
                style={[styles.confirmBtn, styles.noBtn]}
                onPress={() => void send("no")}
                accessibilityRole="button"
                accessibilityLabel="No, cancel"
              >
                <Text style={[styles.confirmBtnText, { color: Colors.text }]}>No</Text>
              </Pressable>
              <Pressable
                style={[styles.confirmBtn, styles.yesBtn]}
                onPress={() => void send("yes")}
                accessibilityRole="button"
                accessibilityLabel={`Yes, ${pending.summary}`}
              >
                <Text style={[styles.confirmBtnText, { color: Colors.bg }]}>Yes</Text>
              </Pressable>
            </View>
          </View>
        )}

        {banner && (
          <View style={styles.bannerWrap}>
            <Banner
              tone={voice.error ? "error" : "warn"}
              text={banner}
              onDismiss={() => {
                voice.clearError();
                setNotice(null);
              }}
            />
          </View>
        )}

        <View style={styles.inputBar}>
          <View style={styles.inputWrap}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={`Message ${assistantName}…`}
              placeholderTextColor={Colors.textFaint}
              selectionColor={Colors.primary}
              returnKeyType="send"
              onSubmitEditing={submitDraft}
              editable={!voice.listening}
              accessibilityLabel={`Type a message to ${assistantName}`}
              maxLength={2000}
            />
            <Pressable
              onPress={submitDraft}
              disabled={!draft.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !draft.trim() || sending }}
              style={[styles.sendBtn, (!draft.trim() || sending) && { opacity: 0.4 }]}
              hitSlop={6}
            >
              <Ionicons name="arrow-up" size={20} color={Colors.bg} />
            </Pressable>
          </View>
          <MicButton
            listening={voice.listening}
            unavailable={!voice.available}
            disabled={sending || voice.transcribing}
            volume={voice.volume}
            size={Math.min(72, Math.max(60, width * 0.17))}
            onStart={() => void startTalking()}
            onStop={stopTalking}
          />
        </View>
        <Text style={styles.hint}>{hint}</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  kicker: { color: Colors.textFaint, ...Font.tiny, fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, flexShrink: 1 },
  briefBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: HitSize - 8,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.5)",
    backgroundColor: "rgba(251,191,36,0.08)",
  },
  briefText: { color: Colors.warning, ...Font.small, fontWeight: "700" },
  suggestScroll: { flexGrow: 0, maxHeight: 52 },
  suggestions: { paddingHorizontal: Spacing.lg, gap: Spacing.sm, alignItems: "center", paddingVertical: Spacing.xs },
  suggestion: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 38,
    justifyContent: "center",
    backgroundColor: Colors.surface,
  },
  suggestionText: { color: Colors.text, ...Font.small, fontWeight: "600" },
  name: { color: Colors.text, fontSize: 22, fontWeight: "800", letterSpacing: 2 },
  statusPill: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    backgroundColor: "rgba(14,20,36,0.8)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { ...Font.small, fontWeight: "700" },
  orbArea: { alignItems: "center", paddingTop: Spacing.sm },
  interim: {
    color: Colors.text,
    ...Font.body,
    textAlign: "center",
    minHeight: 40,
    paddingHorizontal: Spacing.xl,
    opacity: 0.85,
  },
  log: { flex: 1 },
  logContent: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, gap: Spacing.sm },
  caption: { maxWidth: "88%", borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  userCaption: { alignSelf: "flex-end", backgroundColor: Colors.primaryDim },
  botCaption: { alignSelf: "flex-start", backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  captionRole: { color: Colors.textDim, fontSize: 11, fontWeight: "700", marginBottom: 2 },
  captionText: { color: Colors.text, ...Font.body, lineHeight: 21 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: Spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    minHeight: 30,
    backgroundColor: Colors.bgElevated,
  },
  chipText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  confirm: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.warning,
    backgroundColor: "rgba(251,191,36,0.08)",
    gap: Spacing.sm,
  },
  confirmTitle: { color: Colors.warning, ...Font.tiny, fontWeight: "800" },
  confirmText: { color: Colors.text, ...Font.h3 },
  confirmRow: { flexDirection: "row", gap: Spacing.md, marginTop: Spacing.xs },
  confirmBtn: { flex: 1, minHeight: 52, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
  noBtn: { backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.borderStrong },
  yesBtn: { backgroundColor: Colors.warning },
  confirmBtnText: { fontSize: 18, fontWeight: "800" },
  bannerWrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingLeft: Spacing.lg,
    paddingRight: 6,
    minHeight: HitSize + 8,
  },
  input: { flex: 1, color: Colors.text, ...Font.body, paddingVertical: Spacing.sm },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: { color: Colors.textFaint, fontSize: 11, textAlign: "center", paddingVertical: Spacing.sm },
});

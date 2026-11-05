import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { DailyBriefing, Note, Reminder, Task } from "@nova/shared";

import { BriefingCard } from "@/components/BriefingCard";
import { NotesSection } from "@/components/NotesSection";
import { TasksSection } from "@/components/TasksSection";
import { Banner } from "@/components/ui";
import { Colors, Font, Spacing } from "@/constants/theme";
import { useSpeaker } from "@/hooks/useSpeaker";
import { api, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { deviceTimezone } from "@/lib/format";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function TodayScreen() {
  const { user } = useAuth();
  const currency = user?.currency || "INR";
  const { dataVersion, invalidateData } = useAppState();
  const speaker = useSpeaker();

  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [b, t, n] = await Promise.allSettled([
      api.briefing.today({ tz: deviceTimezone() }),
      api.tasks.list(),
      api.notes.list(),
    ]);
    if (mine !== seq.current) return;
    const errs: string[] = [];
    if (b.status === "fulfilled") setBriefing(b.value);
    else errs.push(`Briefing: ${errorMessage(b.reason)}`);
    if (t.status === "fulfilled") setTasks(t.value.tasks);
    else errs.push(`Tasks: ${errorMessage(t.reason)}`);
    if (n.status === "fulfilled") setNotes(n.value.notes);
    else errs.push(`Notes: ${errorMessage(n.reason)}`);
    // Same root cause (API down) → one message.
    setErrors([...new Set(errs.map((e) => (e.includes("Can't reach") ? e.replace(/^\w+: /, "") : e)))]);
    setLoaded(true);
  }, []);

  // Refetch every time the tab gains focus, and when the assistant changed data.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, dataVersion]),
  );
  const stopSpeaker = speaker.stop;
  useFocusEffect(useCallback(() => () => stopSpeaker(), [stopSpeaker]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Local edits (tasks/notes) also change the briefing: bumping dataVersion refetches here
  // (quietly — current data stays on screen) and marks the other tabs stale.
  const onLocalChange = invalidateData;

  // Same flow as the expense delete: native confirm, optimistic removal, restored on failure.
  const confirmDeleteReminder = (r: Reminder) => {
    Alert.alert("Delete reminder?", r.text, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const without = (b: DailyBriefing | null) => (b ? { ...b, reminders: b.reminders.filter((x) => x.id !== r.id) } : b);
          setBriefing(without);
          try {
            await api.reminders.remove(r.id);
            invalidateData(); // the briefing text mentions it too: refetch quietly
          } catch (e) {
            setBriefing((b) =>
              b && !b.reminders.some((x) => x.id === r.id)
                ? { ...b, reminders: [...b.reminders, r].sort((x, y) => x.dateTime.localeCompare(y.dateTime)) }
                : b,
            );
            Alert.alert("Couldn't delete", errorMessage(e));
          }
        },
      },
    ]);
  };

  const dateLabel = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.primary}
              colors={[Colors.primary]}
              progressBackgroundColor={Colors.surface}
            />
          }
        >
          <View>
            <Text style={styles.kicker}>{dateLabel.toUpperCase()}</Text>
            <Text style={styles.title} accessibilityRole="header">
              {greeting()}
              {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
            </Text>
          </View>

          {errors.map((e) => (
            <Banner key={e} tone="error" text={e} onDismiss={() => void onRefresh()} />
          ))}

          {!loaded ? (
            <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xxl }} accessibilityLabel="Loading today" />
          ) : (
            <>
              {briefing && (
                <BriefingCard
                  briefing={briefing}
                  currency={currency}
                  hasCity={!!user?.city}
                  speaking={speaker.speaking}
                  onReadAloud={() => speaker.toggle(briefing.text)}
                  onDeleteReminder={confirmDeleteReminder}
                />
              )}
              <TasksSection tasks={tasks} setTasks={setTasks} onChanged={onLocalChange} />
              <NotesSection notes={notes} setNotes={setNotes} onChanged={onLocalChange} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxl * 2, maxWidth: 720, width: "100%", alignSelf: "center" },
  kicker: { color: Colors.primary, ...Font.tiny, fontWeight: "800" },
  title: { color: Colors.text, ...Font.title },
});

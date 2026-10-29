import Constants from "expo-constants";
import * as Speech from "expo-speech";
import { isRunningInExpoGo } from "expo";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, ASSISTANT_NAME, UpdateMeSchema } from "@nova/shared";

import { Banner, Button, Card, SectionTitle, TextField } from "@/components/ui";
import { Colors, Font, Spacing } from "@/constants/theme";
import { getVoiceMode, isWakeWordSupported, VOICE_MODE_LABEL } from "@/hooks/useVoice";
import { API_BASE_URL, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { cancelWeeklyReport, nextWeeklyReportDate, scheduleWeeklyReport } from "@/lib/notifications";

export default function SettingsScreen() {
  const { user, updateMe, signOut } = useAuth();
  const { speakReplies, setSpeakReplies, wakeWord, autoBriefing, weeklyReportNotification, setPref } = useAppState();
  const [voiceMode] = useState(getVoiceMode);
  const [wakeSupported] = useState(isWakeWordSupported);
  const [city, setCity] = useState(user?.city ?? "");
  const [savingCity, setSavingCity] = useState(false);
  const [cityMsg, setCityMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifMsg, setNotifMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [nextReport, setNextReport] = useState<Date | null>(null);
  const assistantName = user?.assistantName ?? ASSISTANT_NAME;
  const [name, setName] = useState(user?.assistantName ?? ASSISTANT_NAME);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (user?.assistantName) setName(user.assistantName);
  }, [user?.assistantName]);

  const dirty = name.trim() !== (user?.assistantName ?? ASSISTANT_NAME);
  const cityDirty = city.trim() !== (user?.city ?? "");

  useEffect(() => {
    setCity(user?.city ?? "");
  }, [user?.city]);

  useEffect(() => {
    if (weeklyReportNotification) void nextWeeklyReportDate().then(setNextReport);
    else setNextReport(null);
  }, [weeklyReportNotification]);

  async function saveCity() {
    setCityMsg(null);
    const value = city.trim();
    const parsed = UpdateMeSchema.safeParse({ city: value });
    if (!parsed.success) {
      setCityMsg({ tone: "error", text: "City names can be up to 80 characters." });
      return;
    }
    setSavingCity(true);
    try {
      const u = await updateMe(parsed.data);
      setCityMsg({ tone: "info", text: u.city ? `Home city set to ${u.city}. Weather shows in your daily briefing.` : "Home city cleared." });
    } catch (e) {
      // Unknown city → 400 VALIDATION_ERROR with a readable message from the server.
      const text =
        e instanceof ApiError && e.status === 400
          ? e.message || `I couldn't find "${value}". Try the city's full name, e.g. "Bengaluru".`
          : errorMessage(e);
      setCityMsg({ tone: "error", text });
    } finally {
      setSavingCity(false);
    }
  }

  async function toggleWeeklyReport(on: boolean) {
    setNotifMsg(null);
    setNotifBusy(true);
    try {
      if (on) {
        await scheduleWeeklyReport(assistantName);
        setPref("weeklyReportNotification", true);
        setNextReport(await nextWeeklyReportDate());
        setNotifMsg({ tone: "info", text: "Scheduled: every Sunday at 9:00 AM. Tap it to hear the report." });
      } else {
        await cancelWeeklyReport();
        setPref("weeklyReportNotification", false);
      }
    } catch (e) {
      setPref("weeklyReportNotification", false);
      setNotifMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setNotifBusy(false);
    }
  }

  async function saveName() {
    setMsg(null);
    const parsed = UpdateMeSchema.safeParse({ assistantName: name.trim() });
    if (!parsed.success) {
      setMsg({ tone: "error", text: "Name must be 1–30 characters." });
      return;
    }
    setSaving(true);
    try {
      const u = await updateMe(parsed.data);
      setMsg({ tone: "info", text: `Your assistant is now called ${u.assistantName}.` });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  const logout = () =>
    Alert.alert("Log out?", "You'll need to sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          Settings
        </Text>

        <View>
          <SectionTitle>Account</SectionTitle>
          <Card style={{ gap: 4 }}>
            <Text style={styles.strong}>{user?.name}</Text>
            <Text style={styles.dim}>{user?.email}</Text>
          </Card>
        </View>

        <View>
          <SectionTitle>Assistant</SectionTitle>
          <Card style={{ gap: Spacing.lg }}>
            <TextField
              label="Assistant name"
              value={name}
              onChangeText={setName}
              maxLength={30}
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => dirty && void saveName()}
            />
            {msg && <Banner tone={msg.tone} text={msg.text} onDismiss={() => setMsg(null)} />}
            <Button title="Save name" onPress={saveName} loading={saving} disabled={!dirty} />

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.strong}>Speak replies</Text>
                <Text style={styles.dim}>Read answers aloud with your phone's voice.</Text>
              </View>
              <Switch
                value={speakReplies}
                onValueChange={setSpeakReplies}
                accessibilityLabel="Speak replies"
                trackColor={{ true: Colors.primary, false: Colors.surfaceAlt }}
                thumbColor={Colors.text}
              />
            </View>
            <Button title="Test voice" variant="secondary" onPress={() => {
                void Speech.stop();
                Speech.speak(`Hi, I'm ${user?.assistantName ?? ASSISTANT_NAME}. How can I help?`, { language: "en-IN" });
              }} />
          </Card>
        </View>

        <View>
          <SectionTitle>Daily life</SectionTitle>
          <Card style={{ gap: Spacing.lg }}>
            <TextField
              label="Home city (for weather)"
              value={city}
              onChangeText={setCity}
              placeholder="e.g. Bengaluru"
              maxLength={80}
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={() => cityDirty && void saveCity()}
              error={cityMsg?.tone === "error" ? cityMsg.text : null}
            />
            {cityMsg?.tone === "info" && <Banner tone="info" text={cityMsg.text} onDismiss={() => setCityMsg(null)} />}
            <Button title={city.trim() ? "Save city" : "Clear city"} variant="secondary" onPress={saveCity} loading={savingCity} disabled={!cityDirty} />

            <ToggleRow
              title="Morning briefing"
              description={`${assistantName} reads your briefing the first time you open the assistant each day.`}
              value={autoBriefing}
              onChange={(v) => setPref("autoBriefing", v)}
            />

            <ToggleRow
              title="Weekly report notification"
              description={
                weeklyReportNotification && nextReport
                  ? `Sundays at 9:00 AM · next ${nextReport.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`
                  : "A local reminder every Sunday at 9:00 AM. Tap it to hear last week's spending."
              }
              value={weeklyReportNotification}
              disabled={notifBusy}
              onChange={(v) => void toggleWeeklyReport(v)}
            />
            {notifMsg && <Banner tone={notifMsg.tone} text={notifMsg.text} onDismiss={() => setNotifMsg(null)} />}
          </Card>
        </View>

        <View>
          <SectionTitle>Hands-free</SectionTitle>
          <Card style={{ gap: Spacing.md }}>
            {wakeSupported ? (
              <>
                <ToggleRow
                  title={`Wake word "Hey ${assistantName}"`}
                  description="Listens on-device while the assistant screen is open and the app is in the foreground. Paused while it talks. Uses more battery."
                  value={wakeWord}
                  onChange={(v) => setPref("wakeWord", v)}
                />
              </>
            ) : (
              <View style={{ gap: 4 }} accessible accessibilityLabel={`Wake word unavailable. ${wakeUnavailableReason()}`}>
                <Text style={styles.strong}>Wake word "Hey {assistantName}"</Text>
                <Text style={styles.dim}>{wakeUnavailableReason()}</Text>
              </View>
            )}
          </Card>
        </View>

        <View>
          <SectionTitle>Diagnostics</SectionTitle>
          <Card style={{ gap: Spacing.sm }}>
            <Row label="Voice input" value={VOICE_MODE_LABEL[voiceMode]} />
            <Row label="Runtime" value={isRunningInExpoGo() ? "Expo Go" : "Development / release build"} />
            <Row label="API" value={API_BASE_URL} />
            <Row label="App version" value={Constants.expoConfig?.version ?? "dev"} />
          </Card>
        </View>

        <Button title="Log out" variant="danger" onPress={logout} />
      </ScrollView>
    </SafeAreaView>
  );
}

function wakeUnavailableReason() {
  return isRunningInExpoGo()
    ? "Needs a development build: continuous listening uses the phone's native speech recognizer, which isn't in Expo Go. Push-to-talk still works here."
    : "This device has no speech recognition service available, so continuous listening isn't possible.";
}

function ToggleRow({
  title,
  description,
  value,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.strong}>{title}</Text>
        <Text style={styles.dim}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={description}
        trackColor={{ true: Colors.primary, false: Colors.surfaceAlt }}
        thumbColor={Colors.text}
      />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.strong, { flexShrink: 1, textAlign: "right" }]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxl, maxWidth: 720, width: "100%", alignSelf: "center" },
  title: { color: Colors.text, ...Font.title },
  strong: { color: Colors.text, ...Font.body, fontWeight: "600" },
  dim: { color: Colors.textDim, ...Font.small },
  switchRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md },
});

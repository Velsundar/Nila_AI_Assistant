import Constants from "expo-constants";
import * as Speech from "expo-speech";
import * as Linking from "expo-linking";
import { isRunningInExpoGo } from "expo";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, ASSISTANT_NAME, UpdateMeSchema, type NaturalVoice, type NaturalVoicesResult, type VoiceStyle } from "@nova/shared";

import { Banner, Button, Card, SectionTitle, TextField } from "@/components/ui";
import { Colors, Font, Spacing } from "@/constants/theme";
import { getVoiceMode, isWakeWordSupported, VOICE_MODE_LABEL } from "@/hooks/useVoice";
import { API_BASE_URL, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { cancelWeeklyReport, nextWeeklyReportDate, scheduleWeeklyReport } from "@/lib/notifications";
import { speak as speakWithVoice, stop as stopTts, useTtsVoice, voicesForStyle, type VoiceEngine } from "@/lib/tts";

const ORPHEUS_TERMS_URL = "https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english";

export default function SettingsScreen() {
  const { user, updateMe, signOut } = useAuth();
  const { speakReplies, setSpeakReplies, wakeWord, voiceBargeIn, autoBriefing, weeklyReportNotification, setPref } = useAppState();
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
  const tts = useTtsVoice();
  const styleVoices = voicesForStyle(tts.voices, tts.style);
  const { engine, checkNaturalVoices } = tts;

  // Natural voice selected → (re)check availability on the server.
  useEffect(() => {
    if (engine === "natural") void checkNaturalVoices();
  }, [engine, checkNaturalVoices]);

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

  const sample = `Hi, I'm ${assistantName}. How can I help?`;
  /** Phone-voice preview (always the device engine, even when the natural voice is selected). */
  const preview = (voice?: string) => {
    stopTts();
    speakWithVoice(sample, { engine: "device", ...(voice ? { voice } : {}) });
  };
  /** Natural-voice preview: one request per voice (then cached on the phone). */
  const previewNatural = (naturalVoice: string) => {
    stopTts();
    speakWithVoice(sample, { engine: "natural", naturalVoice });
  };
  const natural = tts.natural;
  const naturalOk = engine === "natural" && !!natural?.available;

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
                <Text style={styles.dim}>Read answers aloud with the voice below.</Text>
              </View>
              <Switch
                value={speakReplies}
                onValueChange={setSpeakReplies}
                accessibilityLabel="Speak replies"
                trackColor={{ true: Colors.primary, false: Colors.surfaceAlt }}
                thumbColor={Colors.text}
              />
            </View>
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.strong}>Voice engine</Text>
              <View style={styles.chips} accessibilityRole="radiogroup">
                {ENGINES.map(([value, label]) => (
                  <Chip
                    key={value}
                    label={label}
                    a11y={`${label} engine`}
                    selected={engine === value}
                    onPress={() => {
                      stopTts();
                      tts.setEngine(value);
                    }}
                  />
                ))}
              </View>
              {engine === "natural" && (
                <NaturalVoicePanel
                  natural={natural}
                  checking={tts.naturalChecking}
                  checkError={tts.naturalCheckError}
                  selected={tts.naturalVoiceId}
                  onSelect={(id) => {
                    tts.setNaturalVoice(id);
                    previewNatural(id);
                  }}
                  onTest={() => previewNatural(tts.naturalVoiceId)}
                  onRetry={() => void checkNaturalVoices()}
                />
              )}
            </View>
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.strong}>{naturalOk ? "Phone voice (used if the natural voice fails)" : "Phone voice"}</Text>
              <View style={styles.chips} accessibilityRole="radiogroup">
                {VOICE_STYLES.map(([value, label]) => (
                  <Chip
                    key={value}
                    label={label}
                    selected={tts.style === value}
                    onPress={() => {
                      tts.setStyle(value);
                      preview();
                    }}
                  />
                ))}
              </View>
              <Text style={styles.dim}>
                {tts.current ? `Using ${voiceLabel(tts.current)}` : "Using your phone's default voice"}
                {tts.style !== "any" && styleVoices.length === 0 && tts.voices.length > 0
                  ? `. No ${tts.style} English voice found on this phone; you can download more voices in your phone's text-to-speech settings.`
                  : ""}
              </Text>
            </View>
            <View style={styles.buttonRow}>
              <Button title={naturalOk ? "Test phone voice" : "Test voice"} variant="secondary" onPress={() => preview()} style={{ flex: 1 }} />
              {styleVoices.length > 1 && (
                <Button
                  title="Next voice"
                  variant="secondary"
                  style={{ flex: 1 }}
                  accessibilityHint="Switches to another voice of this style and plays a sample"
                  onPress={() => {
                    const i = styleVoices.findIndex((v) => v.identifier === tts.current?.identifier);
                    const next = styleVoices[(i + 1) % styleVoices.length]!;
                    tts.setVoiceId(next.identifier);
                    preview(next.identifier);
                  }}
                />
              )}
            </View>
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
                  description={`Listens on-device while the assistant screen is open and the app is in the foreground. Paused while it talks${voiceBargeIn ? " (Interrupt by voice listens then)" : ""}. Uses more battery.`}
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
            {wakeSupported ? (
              <ToggleRow
                title="Interrupt by voice"
                description={`Keeps listening while ${assistantName} talks, so you can just start speaking to cut in. ${assistantName}'s own voice is filtered out. Uses more battery; best with headphones or a quiet room.`}
                value={voiceBargeIn}
                onChange={(v) => setPref("voiceBargeIn", v)}
              />
            ) : (
              <View style={{ gap: 4 }} accessible accessibilityLabel={`Interrupt by voice unavailable. ${bargeUnavailableReason()}`}>
                <Text style={styles.strong}>Interrupt by voice</Text>
                <Text style={styles.dim}>{bargeUnavailableReason()}</Text>
              </View>
            )}
            <Text style={styles.dim}>
              {`Anywhere (Expo Go too): tap the orb or the mic while ${assistantName} is talking or thinking to interrupt. The earlier answer stays in the chat as text.`}
            </Text>
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

const ENGINES: [VoiceEngine, string][] = [
  ["device", "Phone voice"],
  ["natural", "Natural voice (AI)"],
];

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Female voices first (the server lists them that way too), then male, then unknown. */
function sortVoices(voices: NaturalVoice[]) {
  const rank = (v: NaturalVoice) => (v.gender === "female" ? 0 : v.gender === "male" ? 1 : 2);
  return [...voices].sort((a, b) => rank(a) - rank(b));
}

function NaturalVoicePanel({
  natural,
  checking,
  checkError,
  selected,
  onSelect,
  onTest,
  onRetry,
}: {
  natural: NaturalVoicesResult | null;
  checking: boolean;
  checkError: string | null;
  selected: string;
  onSelect: (id: string) => void;
  onTest: () => void;
  onRetry: () => void;
}) {
  if (!natural) {
    if (checking) return <Text style={styles.dim}>Checking the natural voice…</Text>;
    return (
      <View style={{ gap: Spacing.sm }}>
        <Banner tone="error" text={`Couldn't check the natural voice: ${checkError ?? "unknown error"}. Using your phone's voice.`} />
        <Button title="Try again" variant="secondary" onPress={onRetry} />
      </View>
    );
  }
  if (!natural.available) {
    return (
      <View style={{ gap: Spacing.sm }}>
        {natural.reason === "TERMS_REQUIRED" ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.warn}>The Groq account owner needs to accept the Orpheus terms at console.groq.com.</Text>
            <Pressable
              onPress={() => void Linking.openURL(ORPHEUS_TERMS_URL)}
              accessibilityRole="link"
              accessibilityLabel="Open the Orpheus model terms on console.groq.com"
              hitSlop={8}
            >
              <Text style={styles.link}>Open console.groq.com → Orpheus</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.warn}>
            {natural.reason === "NO_KEY"
              ? "The Nila server has no Groq API key, so the natural voice is off."
              : "The natural voice isn't available on the server right now."}
          </Text>
        )}
        <Text style={styles.dim}>Using your phone's voice instead.</Text>
        <Button title={checking ? "Checking…" : "Check again"} variant="secondary" onPress={onRetry} disabled={checking} />
      </View>
    );
  }
  const voices = sortVoices(natural.voices);
  return (
    <View style={{ gap: Spacing.sm }}>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {voices.map((v) => {
          const label = `${titleCase(v.id)}${v.gender ? ` · ${v.gender}` : ""}${v.id === natural.defaultVoice ? " (default)" : ""}`;
          return <Chip key={v.id} label={label} a11y={`${label} natural voice`} selected={selected === v.id} onPress={() => onSelect(v.id)} />;
        })}
      </View>
      <Button title="Test voice" variant="secondary" onPress={onTest} />
      <Text style={styles.dim}>
        Uses the free daily AI quota (free tier: about 100 spoken replies per day across all users), and replies start about a
        second later. If it's unavailable or the quota runs out, Nila finishes with your phone's voice.
      </Text>
    </View>
  );
}

function bargeUnavailableReason() {
  return isRunningInExpoGo()
    ? "Needs a development build: it keeps the phone's native speech recognizer running while Nila talks, and that recognizer isn't in Expo Go."
    : "This device has no speech recognition service available.";
}

const VOICE_STYLES: [VoiceStyle, string][] = [
  ["female", "Female"],
  ["male", "Male"],
  ["any", "Phone default"],
];

/** "Veena (en-IN)"; Android names are ids like "en-in-x-ahp-local", so show the language and quality instead. */
function voiceLabel(v: Speech.Voice) {
  const quality = v.quality === Speech.VoiceQuality.Enhanced ? ", enhanced" : "";
  return v.name === v.identifier && v.name.includes("-x-")
    ? `${v.language} voice ${v.name.split("-x-")[1]?.split("-")[0] ?? ""}${quality}`
    : `${v.name} (${v.language}${quality})`;
}

function Chip({ label, selected, onPress, a11y }: { label: string; selected: boolean; onPress: () => void; a11y?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={a11y ?? `${label} voice`}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
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
  warn: { color: Colors.warning, ...Font.small, fontWeight: "600" },
  link: { color: Colors.primary, ...Font.small, fontWeight: "700", textDecorationLine: "underline" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md },
  buttonRow: { flexDirection: "row", gap: Spacing.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.surfaceAlt,
    backgroundColor: Colors.surface,
  },
  chipSelected: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  chipText: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
  chipTextSelected: { color: Colors.bg },
});

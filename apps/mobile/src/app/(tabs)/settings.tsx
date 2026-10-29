import Constants from "expo-constants";
import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ASSISTANT_NAME, UpdateMeSchema } from "@nova/shared";

import { Banner, Button, Card, SectionTitle, TextField } from "@/components/ui";
import { Colors, Font, Spacing } from "@/constants/theme";
import { isVoiceInputAvailable } from "@/hooks/useVoice";
import { API_BASE_URL, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";

export default function SettingsScreen() {
  const { user, updateMe, signOut } = useAuth();
  const { speakReplies, setSpeakReplies } = useAppState();
  const [voiceAvailable] = useState(isVoiceInputAvailable);
  const [name, setName] = useState(user?.assistantName ?? ASSISTANT_NAME);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (user?.assistantName) setName(user.assistantName);
  }, [user?.assistantName]);

  const dirty = name.trim() !== (user?.assistantName ?? ASSISTANT_NAME);

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
          <SectionTitle>Diagnostics</SectionTitle>
          <Card style={{ gap: Spacing.sm }}>
            <Row label="Voice input" value={voiceAvailable ? "Available (on-device)" : "Unavailable — needs a dev build"} />
            <Row label="API" value={API_BASE_URL} />
            <Row label="App version" value={Constants.expoConfig?.version ?? "dev"} />
          </Card>
        </View>

        <Button title="Log out" variant="danger" onPress={logout} />
      </ScrollView>
    </SafeAreaView>
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

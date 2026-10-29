import { Link } from "expo-router";
import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  type TextInputInstance,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ASSISTANT_NAME, LoginSchema, RegisterSchema } from "@nova/shared";

import { Orb } from "@/components/Orb";
import { Banner, Button, TextField } from "@/components/ui";
import { Colors, Font, Spacing } from "@/constants/theme";
import { API_BASE_URL, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { signIn, signUp } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInputInstance>(null);
  const passwordRef = useRef<TextInputInstance>(null);

  const isRegister = mode === "register";

  async function submit(override?: { email: string; password: string }) {
    setError(null);
    const creds = override ?? { email: email.trim(), password };
    const parsed = isRegister && !override
      ? RegisterSchema.safeParse({ name: name.trim(), ...creds })
      : LoginSchema.safeParse(creds);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${String(issue.path[0] ?? "Input")}: ${issue.message}` : "Please check your details.");
      return;
    }
    setBusy(true);
    try {
      if (isRegister && !override) await signUp({ name: name.trim(), ...creds });
      else await signIn(creds);
      // Stack.Protected swaps to the tabs automatically once signed in.
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <Orb state="idle" size={140} />
            <Text style={styles.title} accessibilityRole="header">
              {ASSISTANT_NAME}
            </Text>
            <Text style={styles.subtitle}>
              {isRegister ? "Create your account and meet your assistant." : "Your voice-first money assistant."}
            </Text>
          </View>

          <View style={styles.form}>
            {isRegister && (
              <TextField
                label="Name"
                value={name}
                onChangeText={setName}
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
                placeholder="Your name"
              />
            )}
            <TextField
              ref={emailRef}
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              placeholder="you@example.com"
            />
            <TextField
              ref={passwordRef}
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete={isRegister ? "new-password" : "current-password"}
              textContentType={isRegister ? "newPassword" : "password"}
              returnKeyType="go"
              onSubmitEditing={() => submit()}
              placeholder={isRegister ? "At least 8 characters" : "••••••••"}
            />

            {error && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}

            <Button title={isRegister ? "Create account" : "Sign in"} loading={busy} onPress={() => submit()} />

            {!isRegister && (
              <Button
                title="Use demo account"
                variant="secondary"
                disabled={busy}
                accessibilityHint="Signs in as demo@nova.app"
                onPress={() => submit({ email: "demo@nova.app", password: "password123" })}
              />
            )}

            <Link href={isRegister ? "/login" : "/register"} replace style={styles.link} accessibilityRole="link">
              {isRegister ? "Already have an account? Sign in" : "New here? Create an account"}
            </Link>
          </View>

          <Text style={styles.footer} selectable>
            API: {API_BASE_URL}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: Spacing.xl, justifyContent: "center", gap: Spacing.xl, maxWidth: 480, width: "100%", alignSelf: "center" },
  hero: { alignItems: "center", gap: Spacing.sm },
  title: { color: Colors.text, ...Font.title, letterSpacing: 6, marginTop: Spacing.md },
  subtitle: { color: Colors.textDim, ...Font.body, textAlign: "center" },
  form: { gap: Spacing.lg },
  link: { color: Colors.primary, ...Font.body, textAlign: "center", paddingVertical: Spacing.md },
  footer: { color: Colors.textFaint, ...Font.small, textAlign: "center" },
});

import { Redirect, usePathname } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

/**
 * Catch-all for any URL with no visible route. The common case: a fresh install opens at "/",
 * which is the Assistant tab, hidden by Stack.Protected while signed out. Send the user
 * to the screen that fits their auth state instead of showing "Unmatched Route".
 */
export default function NotFound() {
  const { status } = useAuth();
  const pathname = usePathname();

  if (status === "signedOut") return <Redirect href="/login" />;
  // Signed in: go to the Assistant, unless "/" itself failed to match (avoid a redirect loop).
  if (status === "signedIn" && pathname !== "/") return <Redirect href="/" />;

  return (
    <View style={styles.root}>
      <Text style={styles.text}>Page not found</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.bg },
  text: { color: Colors.text, fontSize: 16 },
});

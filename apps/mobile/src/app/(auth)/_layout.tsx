import { Stack } from "expo-router";

import { Colors } from "@/constants/theme";

export const unstable_settings = { initialRouteName: "login" };

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.bg } }} />;
}

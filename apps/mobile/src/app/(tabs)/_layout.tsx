import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router/tabs";
import type { ColorValue } from "react-native";

import { Colors } from "@/constants/theme";

type IconName = keyof typeof Ionicons.glyphMap;

const icon =
  (name: IconName, focusedName: IconName) =>
  ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <Ionicons name={focused ? focusedName : name} color={typeof color === "string" ? color : undefined} size={size} />
  );

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: Colors.bg },
        tabBarStyle: { backgroundColor: Colors.bgElevated, borderTopColor: Colors.border },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Assistant",
          tabBarAccessibilityLabel: "Assistant tab",
          tabBarIcon: icon("planet-outline", "planet"),
        }}
      />
      <Tabs.Screen
        name="expenses"
        options={{
          title: "Expenses",
          tabBarAccessibilityLabel: "Expenses tab",
          tabBarIcon: icon("wallet-outline", "wallet"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarAccessibilityLabel: "Settings tab",
          tabBarIcon: icon("settings-outline", "settings"),
        }}
      />
    </Tabs>
  );
}

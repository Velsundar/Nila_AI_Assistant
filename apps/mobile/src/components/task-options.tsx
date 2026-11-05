import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DEFAULT_TASK_LIST, type TaskPriority } from "@nova/shared";

import { Colors, Font, Radius, Spacing } from "@/constants/theme";
import { addDays, localISODate } from "@/lib/format";

/** Shared by the add-task form (TasksSection) and the task details sheet. */

export type DueChoice = "none" | "today" | "tomorrow" | "week";
export const DUE_CHOICES: { key: DueChoice; label: string }[] = [
  { key: "none", label: "No date" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "Next week" },
];
export const PRIORITIES: { key: TaskPriority; label: string; color: string }[] = [
  { key: "low", label: "Low", color: Colors.textDim },
  { key: "normal", label: "Normal", color: Colors.primary },
  { key: "high", label: "High", color: Colors.danger },
];
export const SUGGESTED_LISTS = [DEFAULT_TASK_LIST, "Shopping", "Work", "Personal"];

/** "YYYY-MM-DD" for a quick due choice (local calendar), or undefined for "No date". */
export function dueFor(choice: DueChoice): string | undefined {
  const now = new Date();
  if (choice === "today") return localISODate(now);
  if (choice === "tomorrow") return localISODate(addDays(now, 1));
  if (choice === "week") return localISODate(addDays(now, 7));
  return undefined;
}

export const sameList = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.optLabel}>{label}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {children}
      </View>
    </View>
  );
}

export function Chip({ label, selected, onPress, color = Colors.primary }: { label: string; selected: boolean; onPress: () => void; color?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.chip, selected && { borderColor: color, backgroundColor: `${color}22` }]}
    >
      <Text style={[styles.chipText, selected && { color: Colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  optLabel: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 34,
    justifyContent: "center",
    backgroundColor: Colors.bgElevated,
  },
  chipText: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
});

import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DailyBriefing, Reminder, Weather } from "@nova/shared";

import { Button, Card } from "@/components/ui";
import { Colors, Font, Radius, Spacing } from "@/constants/theme";
import { formatMoney, localISODate } from "@/lib/format";

type IconName = keyof typeof Ionicons.glyphMap;

export function weatherIcon(condition: string): IconName {
  const c = condition.toLowerCase();
  if (/thunder|storm/.test(c)) return "thunderstorm-outline";
  if (/rain|drizzle|shower/.test(c)) return "rainy-outline";
  if (/snow|sleet|hail/.test(c)) return "snow-outline";
  if (/partly|few clouds|mostly sunny/.test(c)) return "partly-sunny-outline";
  if (/cloud|overcast|fog|mist|haze|smoke/.test(c)) return "cloudy-outline";
  if (/clear|sun/.test(c)) return "sunny-outline";
  return "thermometer-outline";
}

function timeOf(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

type Props = {
  briefing: DailyBriefing;
  currency: string;
  hasCity: boolean;
  speaking: boolean;
  onReadAloud: () => void;
  /** Confirm + delete a reminder (the parent removes it optimistically). Hidden when absent. */
  onDeleteReminder?: (r: Reminder) => void;
};

export function BriefingCard({ briefing: b, currency, hasCity, speaking, onReadAloud, onDeleteReminder }: Props) {
  const overdue = b.tasksDue.filter((t) => t.dueDate && localISODate(new Date(t.dueDate)) < b.date).length;
  return (
    <Card style={styles.card}>
      <Text style={styles.kicker}>DAILY BRIEFING</Text>

      {b.weather ? (
        <WeatherRow w={b.weather} />
      ) : (
        <Pressable
          onPress={() => router.navigate("/settings")}
          accessibilityRole="button"
          accessibilityLabel={hasCity ? "Weather unavailable right now" : "Set your home city in Settings to see the weather"}
          style={styles.weatherEmpty}
          disabled={hasCity}
        >
          <Ionicons name="partly-sunny-outline" size={20} color={Colors.textFaint} />
          <Text style={styles.dim}>{hasCity ? "Weather is unavailable right now." : "Set your home city in Settings for weather →"}</Text>
        </Pressable>
      )}

      <View style={styles.stats}>
        <Stat label="Yesterday" value={formatMoney(b.spentYesterday, currency)} />
        <Stat label="This month" value={formatMoney(b.spentThisMonth, currency)} />
        <Stat
          label={overdue ? `Due · ${overdue} overdue` : "Tasks due"}
          value={String(b.tasksDue.length)}
          color={overdue ? Colors.danger : undefined}
        />
      </View>

      {b.reminders.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Reminders today</Text>
          {b.reminders.map((r) => (
            <View key={r.id} style={styles.line}>
              <Pressable
                onLongPress={onDeleteReminder ? () => onDeleteReminder(r) : undefined}
                delayLongPress={350}
                disabled={!onDeleteReminder}
                accessibilityLabel={`Reminder at ${timeOf(r.dateTime)}: ${r.text}`}
                accessibilityHint={onDeleteReminder ? "Long press to delete" : undefined}
                accessibilityActions={onDeleteReminder ? [{ name: "delete", label: "Delete reminder" }] : undefined}
                onAccessibilityAction={(ev) => ev.nativeEvent.actionName === "delete" && onDeleteReminder?.(r)}
                style={styles.lineMain}
              >
                <Ionicons name="alarm-outline" size={15} color={Colors.accent} />
                <Text style={styles.lineTime}>{timeOf(r.dateTime)}</Text>
                <Text style={styles.lineText} numberOfLines={2}>
                  {r.text}
                </Text>
              </Pressable>
              {onDeleteReminder && (
                <Pressable
                  onPress={() => onDeleteReminder(r)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete reminder: ${r.text}`}
                  hitSlop={8}
                  style={({ pressed }) => [styles.trash, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="trash-outline" size={17} color={Colors.textFaint} />
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {b.budgetAlerts.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Budget alerts</Text>
          <View style={styles.alerts}>
            {b.budgetAlerts.map((a) => {
              const over = a.percentUsed >= 100;
              const color = over ? Colors.danger : Colors.warning;
              return (
                <View
                  key={a.category}
                  style={[styles.alert, { borderColor: color }]}
                  accessible
                  accessibilityLabel={`${a.category} budget ${Math.round(a.percentUsed)} percent used`}
                >
                  <Ionicons name={over ? "alert-circle" : "warning-outline"} size={13} color={color} />
                  <Text style={[styles.alertText, { color }]}>
                    {a.category} {Math.round(a.percentUsed)}%
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      <Button
        title={speaking ? "Stop reading" : "Read it to me"}
        variant="secondary"
        onPress={onReadAloud}
        accessibilityLabel={speaking ? "Stop reading the briefing" : "Read the briefing aloud"}
        icon={<Ionicons name={speaking ? "stop-circle-outline" : "volume-high-outline"} size={18} color={Colors.primary} />}
      />
    </Card>
  );
}

function WeatherRow({ w }: { w: Weather }) {
  return (
    <View
      style={styles.weather}
      accessible
      accessibilityLabel={`Weather in ${w.city}: ${Math.round(w.tempC)} degrees, ${w.condition}. High ${Math.round(w.highC)}, low ${Math.round(w.lowC)}, ${w.rainChance} percent chance of rain.`}
    >
      <Ionicons name={weatherIcon(w.condition)} size={40} color={Colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.temp}>
          {Math.round(w.tempC)}°<Text style={styles.cond}> {w.condition}</Text>
        </Text>
        <Text style={styles.dim} numberOfLines={1}>
          {w.city} · H {Math.round(w.highC)}° L {Math.round(w.lowC)}° · <Ionicons name="water-outline" size={12} color={Colors.textDim} /> {w.rainChance}%
        </Text>
      </View>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.lg, borderColor: Colors.primaryDim },
  kicker: { color: Colors.primary, ...Font.tiny, fontWeight: "800" },
  weather: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  weatherEmpty: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, minHeight: 44 },
  temp: { color: Colors.text, fontSize: 30, fontWeight: "800" },
  cond: { color: Colors.textDim, fontSize: 15, fontWeight: "600" },
  dim: { color: Colors.textDim, ...Font.small },
  stats: { flexDirection: "row", gap: Spacing.sm },
  stat: {
    flex: 1,
    backgroundColor: Colors.bgElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    gap: 2,
  },
  statValue: { color: Colors.text, fontSize: 16, fontWeight: "800" },
  statLabel: { color: Colors.textFaint, fontSize: 11, fontWeight: "600" },
  block: { gap: 6 },
  blockTitle: { color: Colors.textDim, ...Font.tiny, fontWeight: "700" },
  line: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  lineMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: Spacing.sm, minHeight: 36 },
  trash: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  lineTime: { color: Colors.accent, ...Font.small, fontWeight: "700", minWidth: 62 },
  lineText: { color: Colors.text, ...Font.body, flex: 1 },
  alerts: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  alert: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    minHeight: 28,
  },
  alertText: { fontSize: 12, fontWeight: "700" },
});

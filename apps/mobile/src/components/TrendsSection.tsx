import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";
import type { TrendsResult } from "@nova/shared";

import { Card, SectionTitle } from "@/components/ui";
import { CategoryMeta, Colors, Font, Radius, Spacing } from "@/constants/theme";
import { formatMoney, formatPercent } from "@/lib/format";

const BAR_HEIGHT = 110;
const SERIES = [
  { key: "received", label: "Received", color: Colors.success },
  { key: "spent", label: "Spent", color: Colors.danger },
  { key: "invested", label: "Invested", color: CategoryMeta.Investments.color },
] as const;

/** "2026-11" → "Nov" (parsed as a local date so the month can't shift). */
function monthShort(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-IN", { month: "short" });
}

/** Spending up is bad (red), down is good (green). */
const changeColor = (pct: number) => (pct > 0 ? Colors.danger : pct < 0 ? Colors.success : Colors.textDim);

export function TrendsSection({ trends: t, currency }: { trends: TrendsResult; currency: string }) {
  const months = t.months;
  const max = Math.max(1, ...months.flatMap((m) => [m.received, m.spent, m.invested]));
  const current = months[months.length - 1];
  const movers = t.categoryChanges.filter((c) => c.thisMonth !== c.lastMonth).slice(0, 4);

  return (
    <View>
      <SectionTitle>Trends & savings</SectionTitle>
      <Card style={{ gap: Spacing.lg }}>
        <View style={styles.stats}>
          <Stat
            label="Savings rate this month"
            value={current?.savingsRate != null ? `${Math.round(current.savingsRate)}%` : "—"}
            color={current?.savingsRate != null ? (current.savingsRate < 0 ? Colors.danger : Colors.success) : undefined}
          />
          <Stat label="Avg monthly spend" value={formatMoney(t.averageMonthlySpent, currency)} />
        </View>

        {t.spentChangePercent != null && (
          <View
            style={styles.change}
            accessible
            accessibilityLabel={`This month versus last: spending ${t.spentChangePercent >= 0 ? "up" : "down"} ${Math.abs(Math.round(t.spentChangePercent))} percent`}
          >
            <Ionicons
              name={t.spentChangePercent > 0 ? "arrow-up" : t.spentChangePercent < 0 ? "arrow-down" : "remove"}
              size={16}
              color={changeColor(t.spentChangePercent)}
            />
            <Text style={styles.body}>
              This month vs last:{" "}
              <Text style={{ color: changeColor(t.spentChangePercent), fontWeight: "800" }}>{formatPercent(t.spentChangePercent)}</Text> spending
            </Text>
          </View>
        )}

        {months.length > 0 && (
          <View>
            <View style={styles.chart} accessibilityRole="image" accessibilityLabel="Monthly received, spent and invested">
              {months.map((m, i) => (
                <View
                  key={m.month}
                  style={styles.group}
                  accessible
                  accessibilityLabel={`${monthShort(m.month)}${i === months.length - 1 ? " so far" : ""}: received ${formatMoney(m.received, currency)}, spent ${formatMoney(m.spent, currency)}, invested ${formatMoney(m.invested, currency)}${m.savingsRate != null ? `, savings rate ${Math.round(m.savingsRate)} percent` : ""}`}
                >
                  <View style={styles.bars}>
                    {SERIES.map((s) => (
                      <View
                        key={s.key}
                        style={[styles.bar, { backgroundColor: s.color, height: Math.max(m[s.key] > 0 ? 2 : 0, (m[s.key] / max) * BAR_HEIGHT) }]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.month, i === months.length - 1 && { color: Colors.text }]}>{monthShort(m.month)}</Text>
                  <Text style={styles.rate} numberOfLines={1}>
                    {m.savingsRate != null ? `${Math.round(m.savingsRate)}%` : " "}
                  </Text>
                </View>
              ))}
            </View>
            <View style={styles.legend} accessible={false} importantForAccessibility="no-hide-descendants">
              {SERIES.map((s) => (
                <View key={s.key} style={styles.legendItem}>
                  <View style={[styles.dot, { backgroundColor: s.color }]} />
                  <Text style={styles.small}>{s.label}</Text>
                </View>
              ))}
              <Text style={styles.small}>· % = saved</Text>
            </View>
          </View>
        )}

        {movers.length > 0 && (
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.blockTitle}>Biggest changes vs last month</Text>
            {movers.map((c) => {
              const meta = CategoryMeta[c.category] ?? CategoryMeta.Other;
              const diff = c.thisMonth - c.lastMonth;
              const pct = c.changePercent;
              return (
                <View
                  key={c.category}
                  style={styles.mover}
                  accessible
                  accessibilityLabel={`${c.category}: ${formatMoney(c.thisMonth, currency)} this month, ${formatMoney(c.lastMonth, currency)} last month${pct != null ? `, ${pct >= 0 ? "up" : "down"} ${Math.abs(Math.round(pct))} percent` : ", new this month"}`}
                >
                  <Ionicons name={meta.icon} size={16} color={meta.color} />
                  <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                    {c.category}
                  </Text>
                  <Text style={styles.small}>
                    {formatMoney(c.lastMonth, currency)} → {formatMoney(c.thisMonth, currency)}
                  </Text>
                  <Text style={[styles.pct, { color: changeColor(diff) }]}>{pct != null ? formatPercent(pct) : "new"}</Text>
                </View>
              );
            })}
          </View>
        )}
      </Card>
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
  stats: { flexDirection: "row", gap: Spacing.sm },
  stat: {
    flex: 1,
    backgroundColor: Colors.bgElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    gap: 2,
  },
  statValue: { color: Colors.text, fontSize: 18, fontWeight: "800" },
  statLabel: { color: Colors.textFaint, fontSize: 11, fontWeight: "600" },
  change: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  body: { color: Colors.text, ...Font.body },
  small: { color: Colors.textDim, ...Font.small },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: Spacing.xs },
  group: { flex: 1, alignItems: "center", gap: 4 },
  bars: { height: BAR_HEIGHT, flexDirection: "row", alignItems: "flex-end", gap: 2 },
  bar: { width: 7, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  month: { color: Colors.textDim, fontSize: 11, fontWeight: "700" },
  rate: { color: Colors.textFaint, fontSize: 10, fontWeight: "600" },
  legend: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: Spacing.md, marginTop: Spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  blockTitle: { color: Colors.textDim, ...Font.tiny, fontWeight: "700" },
  mover: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, minHeight: 28 },
  pct: { ...Font.small, fontWeight: "800", minWidth: 44, textAlign: "right" },
});

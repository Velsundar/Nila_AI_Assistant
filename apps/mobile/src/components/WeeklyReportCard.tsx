import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";
import type { WeeklyReport } from "@nova/shared";

import { Button, Card, ProgressBar } from "@/components/ui";
import { CategoryMeta, Colors, Font, Spacing } from "@/constants/theme";
import { formatMoney, formatPercent, parseLocalDate } from "@/lib/format";

const short = (ymd: string) => parseLocalDate(ymd).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

type Props = { report: WeeklyReport; currency: string; speaking: boolean; onReadAloud: () => void };

export function WeeklyReportCard({ report: r, currency, speaking, onReadAloud }: Props) {
  const change = r.changePercent;
  // Spending more is "bad" (red), less is "good" (green).
  const changeColor = change == null ? Colors.textDim : change > 0 ? Colors.danger : Colors.success;
  const cats = [...r.byCategory].sort((a, b) => b.total - a.total).slice(0, 3);
  const max = Math.max(1, ...cats.map((c) => c.total));

  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.kicker}>LAST WEEK · {short(r.weekStart)} – {short(r.weekEnd)}</Text>
        <Ionicons name="bar-chart-outline" size={16} color={Colors.accent} />
      </View>

      <View style={styles.rowBetween}>
        <Text style={styles.total} accessibilityLabel={`Spent last week: ${formatMoney(r.total, currency)}`}>
          {formatMoney(r.total, currency)}
        </Text>
        <View
          style={styles.change}
          accessible
          accessibilityLabel={
            change == null
              ? "No spending the week before to compare"
              : `${Math.abs(Math.round(change))} percent ${change > 0 ? "more" : "less"} than the week before`
          }
        >
          {change != null && (
            <Ionicons name={change > 0 ? "trending-up" : change < 0 ? "trending-down" : "remove"} size={16} color={changeColor} />
          )}
          <Text style={[styles.changeText, { color: changeColor }]}>{change == null ? "—" : formatPercent(change)}</Text>
        </View>
      </View>
      <Text style={styles.dim}>vs {formatMoney(r.previousTotal, currency)} the week before</Text>

      {cats.length > 0 && (
        <View style={{ gap: Spacing.sm }}>
          {cats.map((c) => {
            const meta = CategoryMeta[c.category] ?? CategoryMeta.Other;
            return (
              <View key={c.category} style={{ gap: 4 }} accessible accessibilityLabel={`${c.category}: ${formatMoney(c.total, currency)}`}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cat}>{c.category}</Text>
                  <Text style={styles.cat}>{formatMoney(c.total, currency)}</Text>
                </View>
                <ProgressBar value={c.total / max} color={meta.color} height={6} />
              </View>
            );
          })}
        </View>
      )}

      {r.topMerchants.length > 0 && (
        <Text style={styles.dim} numberOfLines={2}>
          Top: {r.topMerchants.slice(0, 3).map((m) => `${m.merchant} (${formatMoney(m.total, currency)})`).join(", ")}
        </Text>
      )}

      <Button
        title={speaking ? "Stop reading" : "Read report"}
        variant="secondary"
        onPress={onReadAloud}
        accessibilityLabel={speaking ? "Stop reading the weekly report" : "Read the weekly report aloud"}
        icon={<Ionicons name={speaking ? "stop-circle-outline" : "volume-high-outline"} size={18} color={Colors.primary} />}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.md, borderColor: "rgba(167,139,250,0.4)" },
  kicker: { color: Colors.accent, ...Font.tiny, fontWeight: "800", flexShrink: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
  total: { color: Colors.text, fontSize: 26, fontWeight: "800", flexShrink: 1 },
  change: { flexDirection: "row", alignItems: "center", gap: 4 },
  changeText: { ...Font.h3, fontWeight: "800" },
  dim: { color: Colors.textDim, ...Font.small },
  cat: { color: Colors.text, ...Font.small, fontWeight: "600" },
});

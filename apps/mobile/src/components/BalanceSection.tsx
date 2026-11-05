import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Category, IncomeCategory, Ledger, LedgerEntry } from "@nova/shared";

import { Card, SectionTitle } from "@/components/ui";
import { CategoryMeta, Colors, Font, IncomeCategoryMeta, Radius, Spacing } from "@/constants/theme";
import { formatMoney, monthLabel } from "@/lib/format";

/** Passbook rows shown before "Show earlier". The newest stay visible; order is still oldest first. */
const VISIBLE = 12;

function shortDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** "Since salary on 1 Nov", "This month" (or "October 2026" for a past month), or a from–to range. */
export function periodLabel(l: Ledger): string {
  if (l.period === "salary-cycle") return `Since salary on ${shortDate(l.from)}`;
  if (l.period === "month") {
    const from = new Date(l.from);
    const now = new Date();
    if (Number.isNaN(from.getTime())) return "This month";
    // `from` is local midnight on the 1st; compare a mid-month date so offsets can't shift the month.
    const mid = new Date(from.getTime() + 10 * 86400000);
    return mid.getFullYear() === now.getFullYear() && mid.getMonth() === now.getMonth() ? "This month" : monthLabel(mid);
  }
  return `${shortDate(l.from)} – ${shortDate(l.to)}`;
}

function entryMeta(e: LedgerEntry) {
  if (e.kind === "income") return IncomeCategoryMeta[e.category as IncomeCategory] ?? IncomeCategoryMeta.Other;
  return CategoryMeta[e.category as Category] ?? CategoryMeta.Other;
}

const signed = (n: number, currency: string) => `${n < 0 ? "−" : "+"}${formatMoney(Math.abs(n), currency)}`;

export function BalanceSection({ ledger: l, currency }: { ledger: Ledger; currency: string }) {
  const [showAll, setShowAll] = useState(false);
  const t = l.totals;
  const hidden = showAll ? 0 : Math.max(0, l.entries.length - VISIBLE);
  const rows = l.entries.slice(hidden);
  const period = periodLabel(l);

  return (
    <View>
      <SectionTitle>Balance</SectionTitle>
      <Card style={styles.card}>
        <Text style={styles.kicker}>{period.toUpperCase()}</Text>
        <View accessible accessibilityLabel={`Left: ${t.balance < 0 ? "minus " : ""}${formatMoney(Math.abs(t.balance), currency)}, ${period.toLowerCase()}`}>
          <Text style={styles.small}>Left</Text>
          <Text style={[styles.left, t.balance < 0 && { color: Colors.danger }]} numberOfLines={1} adjustsFontSizeToFit>
            {t.balance < 0 ? "−" : ""}
            {formatMoney(Math.abs(t.balance), currency)}
          </Text>
        </View>
        <View style={styles.totals}>
          <Total label="Received" value={`+${formatMoney(t.received, currency)}`} color={Colors.success} />
          <Total label="Spent" value={`−${formatMoney(t.spent, currency)}`} color={Colors.text} />
          <Total label="Invested" value={`−${formatMoney(t.invested, currency)}`} color={CategoryMeta.Investments.color} />
        </View>
      </Card>

      {l.entries.length === 0 ? (
        <Card style={{ marginTop: Spacing.md }}>
          <Text style={styles.dim}>No money in or out yet in this period.</Text>
        </Card>
      ) : (
        <View style={styles.list}>
          <View style={styles.headRow} accessible={false}>
            <Text style={[styles.head, { flex: 1 }]}>Passbook · oldest first</Text>
            <Text style={styles.head}>Balance</Text>
          </View>
          {hidden > 0 && (
            <Pressable
              onPress={() => setShowAll(true)}
              accessibilityRole="button"
              accessibilityLabel={`Show ${hidden} earlier entries`}
              style={({ pressed }) => [styles.more, pressed && { backgroundColor: Colors.surfaceAlt }]}
            >
              <Ionicons name="chevron-up" size={14} color={Colors.textFaint} />
              <Text style={styles.small}>Show earlier ({hidden})</Text>
            </Pressable>
          )}
          {rows.map((e) => {
            const meta = entryMeta(e);
            const isIn = e.amount >= 0;
            const sub = [shortDate(e.date), e.category !== e.label ? e.category : null, e.subcategory].filter(Boolean).join(" · ");
            return (
              <View
                key={`${e.kind}-${e.id}`}
                style={styles.item}
                accessible
                accessibilityLabel={`${shortDate(e.date)}, ${e.label}, ${isIn ? "received" : "paid"} ${formatMoney(Math.abs(e.amount), currency)}, balance ${e.balance < 0 ? "minus " : ""}${formatMoney(Math.abs(e.balance), currency)}`}
              >
                <View style={[styles.icon, { backgroundColor: `${meta.color}22` }]}>
                  <Ionicons name={meta.icon} size={16} color={meta.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle} numberOfLines={1}>
                    {e.label}
                  </Text>
                  <Text style={styles.small} numberOfLines={1}>
                    {sub}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[styles.amount, { color: isIn ? Colors.success : Colors.text }]}>{signed(e.amount, currency)}</Text>
                  <Text style={[styles.small, e.balance < 0 && { color: Colors.danger }]}>
                    {e.balance < 0 ? "−" : ""}
                    {formatMoney(Math.abs(e.balance), currency)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function Total({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.total} accessible accessibilityLabel={`${label}: ${value.replace("−", "minus ").replace("+", "")}`}>
      <Text style={styles.small}>{label}</Text>
      <Text style={[styles.totalValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.sm },
  kicker: { color: Colors.success, ...Font.tiny, fontWeight: "800" },
  left: { color: Colors.text, fontSize: 30, fontWeight: "800" },
  totals: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  total: { flex: 1, gap: 2 },
  totalValue: { ...Font.h3, fontWeight: "700" },
  dim: { color: Colors.textDim, ...Font.body },
  small: { color: Colors.textDim, ...Font.small },
  list: {
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  headRow: { flexDirection: "row", paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.sm },
  head: { color: Colors.textFaint, ...Font.tiny, fontWeight: "700" },
  more: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 40,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    minHeight: 56,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  itemTitle: { color: Colors.text, ...Font.body, fontWeight: "600" },
  amount: { ...Font.body, fontWeight: "700" },
});

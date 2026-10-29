import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BudgetStatus, Expense, ReceiptScanResult, SpendingSummary, WeeklyReport } from "@nova/shared";

import { AddExpenseSheet } from "@/components/AddExpenseSheet";
import { Banner, Card, ProgressBar, SectionTitle } from "@/components/ui";
import { WeeklyReportCard } from "@/components/WeeklyReportCard";
import { useSpeaker } from "@/hooks/useSpeaker";
import { CategoryMeta, Colors, Font, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { deviceTimezone, formatDate, formatMoney, monthLabel } from "@/lib/format";
import { pickReceiptImage } from "@/lib/receipt";

type Data = { summary: SpendingSummary; budgets: BudgetStatus[]; expenses: Expense[]; report: WeeklyReport | null };

function budgetColor(pct: number) {
  if (pct >= 100) return Colors.danger;
  if (pct >= 80) return Colors.warning;
  return Colors.success;
}

export default function ExpensesScreen() {
  const { user } = useAuth();
  const currency = user?.currency || "INR";
  const { dataVersion, invalidateData } = useAppState();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptScanResult | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const [scanning, setScanning] = useState(false);
  const loadedVersion = useRef<number | null>(null);
  const speaker = useSpeaker();

  const load = useCallback(async () => {
    try {
      // The weekly report is optional: an older API without it shouldn't break this screen.
      const reportP = api.reports.weekly({ tz: deviceTimezone() }).catch(() => null);
      const [summary, { budgets }, { expenses }, report] = await Promise.all([
        api.expenses.summary(),
        api.budgets.list(),
        api.expenses.list({ limit: 50 }),
        reportP,
      ]);
      setData({ summary, budgets, expenses, report });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on focus when this is the first visit or something (e.g. the assistant) changed data.
  useFocusEffect(
    useCallback(() => {
      if (loadedVersion.current !== dataVersion) {
        loadedVersion.current = dataVersion;
        void load();
      }
    }, [dataVersion, load]),
  );

  const stopSpeaker = speaker.stop;
  useFocusEffect(useCallback(() => () => stopSpeaker(), [stopSpeaker]));

  async function scan(source: "camera" | "library") {
    setError(null);
    try {
      const image = await pickReceiptImage(source);
      if (!image) return; // cancelled
      setScanning(true);
      const result = await api.receipts.scan({ image });
      setReceipt(result);
      setSheetKey((k) => k + 1);
      setAdding(true);
    } catch (e) {
      setError(`Receipt scan failed: ${errorMessage(e)}`);
    } finally {
      setScanning(false);
    }
  }

  const chooseScanSource = () =>
    Alert.alert("Scan a receipt", "The amount, merchant and date are read for you to confirm. Nothing is saved until you tap Save.", [
      { text: "Take photo", onPress: () => void scan("camera") },
      { text: "Choose from library", onPress: () => void scan("library") },
      { text: "Cancel", style: "cancel" },
    ]);

  const openManual = () => {
    setReceipt(null);
    setSheetKey((k) => k + 1);
    setAdding(true);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const confirmDelete = (e: Expense) => {
    const label = `${formatMoney(e.amount, currency)} · ${e.merchant || e.category}`;
    Alert.alert("Delete expense?", label, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          // Optimistic removal; reload either way to keep totals in sync.
          setData((d) => (d ? { ...d, expenses: d.expenses.filter((x) => x.id !== e.id) } : d));
          try {
            await api.expenses.remove(e.id);
          } catch (err) {
            Alert.alert("Couldn't delete", errorMessage(err));
          }
          invalidateData();
        },
      },
    ]);
  };

  const maxCat = Math.max(1, ...(data?.summary.byCategory.map((c) => c.total) ?? [1]));
  const byCategory = [...(data?.summary.byCategory ?? [])].sort((a, b) => b.total - a.total);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} progressBackgroundColor={Colors.surface} />}
      >
        <View style={styles.rowBetween}>
          <Text style={styles.title} accessibilityRole="header">
            Expenses
          </Text>
          <Pressable
            onPress={chooseScanSource}
            disabled={scanning}
            accessibilityRole="button"
            accessibilityLabel="Scan a receipt"
            accessibilityHint="Take or pick a photo of a receipt to prefill an expense"
            accessibilityState={{ disabled: scanning, busy: scanning }}
            style={({ pressed }) => [styles.scanBtn, (pressed || scanning) && { opacity: 0.7 }]}
          >
            {scanning ? <ActivityIndicator size="small" color={Colors.primary} /> : <Ionicons name="scan-outline" size={18} color={Colors.primary} />}
            <Text style={styles.scanText}>{scanning ? "Reading…" : "Scan receipt"}</Text>
          </Pressable>
        </View>

        {error && <Banner tone="error" text={error} onDismiss={() => void onRefresh()} />}

        {loading && !data ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xxl }} accessibilityLabel="Loading expenses" />
        ) : data ? (
          <>
            <Card style={styles.totalCard}>
              <Text style={styles.kicker}>{monthLabel().toUpperCase()}</Text>
              <Text style={styles.total} accessibilityLabel={`Spent this month: ${formatMoney(data.summary.total, currency)}`}>
                {formatMoney(data.summary.total, currency)}
              </Text>
              <Text style={styles.dim}>
                {data.summary.count} expense{data.summary.count === 1 ? "" : "s"} this month
              </Text>
            </Card>

            {data.report && (
              <View>
                <SectionTitle>Weekly report</SectionTitle>
                <WeeklyReportCard
                  report={data.report}
                  currency={currency}
                  speaking={speaker.speaking}
                  onReadAloud={() => data.report && speaker.toggle(data.report.text)}
                />
              </View>
            )}

            <View>
              <SectionTitle>By category</SectionTitle>
              <Card style={{ gap: Spacing.md }}>
                {byCategory.length === 0 ? (
                  <Text style={styles.dim}>No spending yet this month.</Text>
                ) : (
                  byCategory.map((c) => {
                    const meta = CategoryMeta[c.category] ?? CategoryMeta.Other;
                    return (
                      <View key={c.category} style={{ gap: 6 }} accessible accessibilityLabel={`${c.category}: ${formatMoney(c.total, currency)}, ${c.count} expenses`}>
                        <View style={styles.rowBetween}>
                          <View style={styles.row}>
                            <Ionicons name={meta.icon as keyof typeof Ionicons.glyphMap} size={16} color={meta.color} />
                            <Text style={styles.catName}>{c.category}</Text>
                          </View>
                          <Text style={styles.amount}>{formatMoney(c.total, currency)}</Text>
                        </View>
                        <ProgressBar value={c.total / maxCat} color={meta.color} />
                      </View>
                    );
                  })
                )}
              </Card>
            </View>

            <View>
              <SectionTitle>Budgets</SectionTitle>
              <Card style={{ gap: Spacing.md }}>
                {data.budgets.length === 0 ? (
                  <Text style={styles.dim}>No budgets yet. Ask the assistant: "Set a food budget of 5000".</Text>
                ) : (
                  data.budgets.map((b) => {
                    const color = budgetColor(b.percentUsed);
                    return (
                      <View key={b.category} style={{ gap: 6 }} accessible accessibilityLabel={`${b.category} budget: ${formatMoney(b.spent, currency)} of ${formatMoney(b.monthlyLimit, currency)}, ${Math.round(b.percentUsed)} percent used`}>
                        <View style={styles.rowBetween}>
                          <Text style={styles.catName}>{b.category}</Text>
                          <Text style={[styles.small, { color }]}>
                            {formatMoney(b.spent, currency)} / {formatMoney(b.monthlyLimit, currency)}
                          </Text>
                        </View>
                        <ProgressBar value={b.percentUsed / 100} color={color} />
                        {b.percentUsed >= 100 && <Text style={[styles.small, { color }]}>Over budget</Text>}
                      </View>
                    );
                  })
                )}
              </Card>
            </View>

            <View>
              <SectionTitle>Recent</SectionTitle>
              {data.expenses.length === 0 ? (
                <Card>
                  <Text style={styles.dim}>Nothing logged yet. Tap + or tell the assistant what you spent.</Text>
                </Card>
              ) : (
                <View style={styles.list}>
                  {data.expenses.map((e) => {
                    const meta = CategoryMeta[e.category] ?? CategoryMeta.Other;
                    const label = `${e.merchant || e.category}, ${formatMoney(e.amount, currency)}, ${formatDate(e.date)}`;
                    return (
                      <Pressable
                        key={e.id}
                        onLongPress={() => confirmDelete(e)}
                        delayLongPress={350}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityHint="Long press to delete"
                        accessibilityActions={[{ name: "delete", label: "Delete expense" }]}
                        onAccessibilityAction={(ev) => ev.nativeEvent.actionName === "delete" && confirmDelete(e)}
                        style={({ pressed }) => [styles.item, pressed && { backgroundColor: Colors.surfaceAlt }]}
                      >
                        <View style={[styles.itemIcon, { backgroundColor: `${meta.color}22` }]}>
                          <Ionicons name={meta.icon as keyof typeof Ionicons.glyphMap} size={18} color={meta.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemTitle} numberOfLines={1}>
                            {e.merchant || e.category}
                          </Text>
                          <Text style={styles.small} numberOfLines={1}>
                            {formatDate(e.date)} · {e.category}
                            {e.source === "voice" ? " · 🎙" : ""}
                            {e.note ? ` · ${e.note}` : ""}
                          </Text>
                        </View>
                        <Text style={styles.amount}>{formatMoney(e.amount, currency)}</Text>
                      </Pressable>
                    );
                  })}
                  <Text style={[styles.small, { textAlign: "center", marginTop: Spacing.sm }]}>Long-press an expense to delete it</Text>
                </View>
              )}
            </View>
          </>
        ) : null}
      </ScrollView>

      <Pressable
        onPress={openManual}
        accessibilityRole="button"
        accessibilityLabel="Add expense"
        style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.95 }] }]}
      >
        <Ionicons name="add" size={30} color={Colors.bg} />
      </Pressable>

      <AddExpenseSheet
        key={sheetKey}
        visible={adding}
        receipt={receipt}
        onClose={() => {
          setAdding(false);
          setReceipt(null);
        }}
        onCreated={invalidateData}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, gap: Spacing.xl, paddingBottom: 110, maxWidth: 720, width: "100%", alignSelf: "center" },
  title: { color: Colors.text, ...Font.title },
  totalCard: { gap: 4, borderColor: Colors.primaryDim },
  kicker: { color: Colors.primary, ...Font.tiny, fontWeight: "800" },
  total: { color: Colors.text, fontSize: 36, fontWeight: "800" },
  dim: { color: Colors.textDim, ...Font.body },
  small: { color: Colors.textDim, ...Font.small },
  row: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
  catName: { color: Colors.text, ...Font.body, fontWeight: "600" },
  amount: { color: Colors.text, ...Font.body, fontWeight: "700" },
  list: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: "hidden", paddingBottom: Spacing.sm },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  itemIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  itemTitle: { color: Colors.text, ...Font.body, fontWeight: "600" },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    paddingHorizontal: Spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.primaryDim,
    backgroundColor: "rgba(56,189,248,0.08)",
  },
  scanText: { color: Colors.primary, ...Font.small, fontWeight: "700" },
  fab: {
    position: "absolute",
    right: Spacing.xl,
    bottom: Spacing.xl,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});

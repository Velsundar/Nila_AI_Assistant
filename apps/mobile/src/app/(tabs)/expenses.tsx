import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BudgetStatus, Category, Expense, Income, IncomeSummary, Ledger, ReceiptScanResult, SpendingSummary, TrendsResult, WeeklyReport } from "@nova/shared";

import { AddExpenseSheet } from "@/components/AddExpenseSheet";
import { AddIncomeSheet } from "@/components/AddIncomeSheet";
import { BalanceSection } from "@/components/BalanceSection";
import { TrendsSection } from "@/components/TrendsSection";
import { Banner, Card, ProgressBar, SectionTitle } from "@/components/ui";
import { WeeklyReportCard } from "@/components/WeeklyReportCard";
import { useSpeaker } from "@/hooks/useSpeaker";
import { CategoryMeta, Colors, Font, IncomeCategoryMeta, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { useAppState } from "@/lib/app-state";
import { useAuth } from "@/lib/auth";
import { deviceTimezone, formatDate, formatMoney, monthLabel } from "@/lib/format";
import { pickReceiptImage } from "@/lib/receipt";

type Data = {
  summary: SpendingSummary;
  budgets: BudgetStatus[];
  expenses: Expense[];
  report: WeeklyReport | null;
  /** null when the API predates v4 income: the spending view still works. */
  incomeSummary: IncomeSummary | null;
  income: Income[];
  /** null when the request fails (pre-v5 API): the section is hidden. */
  ledger: Ledger | null;
  trends: TrendsResult | null;
};

/** Subcategory split for the expanded category row. */
type Split = { category: Category; status: "loading" | "ok" | "error"; rows: { subcategory: string; total: number; count: number }[] };

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
  const [addingIncome, setAddingIncome] = useState(false);
  const [incomeSheetKey, setIncomeSheetKey] = useState(0);
  const [receipt, setReceipt] = useState<ReceiptScanResult | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const [scanning, setScanning] = useState(false);
  const loadedVersion = useRef<number | null>(null);
  const loadSeq = useRef(0);
  const [expanded, setExpanded] = useState<Category | null>(null);
  const [split, setSplit] = useState<Split | null>(null);
  const speaker = useSpeaker();

  const load = useCallback(async () => {
    // Focus, pull-to-refresh and invalidateData can overlap: only the newest load may write.
    const mine = ++loadSeq.current;
    try {
      // The weekly report is optional: an older API without it shouldn't break this screen.
      const reportP = api.reports.weekly({ tz: deviceTimezone() }).catch(() => null);
      // Income summary uses the spending summary's exact range so "Net" compares like with like.
      const summariesP = api.expenses.summary().then(async (summary) => ({
        summary,
        incomeSummary: await api.income.summary({ from: summary.from, to: summary.to }).catch(() => null),
      }));
      const incomeP = api.income.list({ limit: 20 }).then((r) => r.income).catch(() => [] as Income[]);
      // v5 sections fail soft, like income: hidden if the endpoint isn't there yet.
      const ledgerP = api.ledger().catch(() => null);
      const trendsP = api.trends({ months: 6 }).catch(() => null);
      const [{ summary, incomeSummary }, { budgets }, { expenses }, report, income, ledger, trends] = await Promise.all([
        summariesP,
        api.budgets.list(),
        api.expenses.list({ limit: 50 }),
        reportP,
        incomeP,
        ledgerP,
        trendsP,
      ]);
      if (mine !== loadSeq.current) return;
      setData({ summary, budgets, expenses, report, incomeSummary, income, ledger, trends });
      setError(null);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(errorMessage(e));
    } finally {
      if (mine === loadSeq.current) setLoading(false);
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

  // Subcategory split for the tapped category. Re-fetched whenever the summary reloads (add/delete
  // anywhere bumps dataVersion → load → new summary object), so the split can never go stale.
  const summary = data?.summary;
  useEffect(() => {
    if (!expanded || !summary) {
      setSplit(null);
      return;
    }
    let cancelled = false;
    setSplit((prev) => ({ category: expanded, status: "loading", rows: prev?.category === expanded ? prev.rows : [] }));
    api.expenses
      .summary({ from: summary.from, to: summary.to, category: expanded })
      .then((r) => {
        if (cancelled) return;
        const rows = [...(r.bySubcategory ?? [])].sort((a, b) => b.total - a.total);
        setSplit({ category: expanded, status: "ok", rows });
      })
      .catch(() => !cancelled && setSplit({ category: expanded, status: "error", rows: [] }));
    return () => {
      cancelled = true;
    };
  }, [expanded, summary]);

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

  const openIncome = () => {
    setIncomeSheetKey((k) => k + 1);
    setAddingIncome(true);
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

  const confirmDeleteIncome = (i: Income) => {
    const label = `${formatMoney(i.amount, currency)} · ${i.payer || i.note || i.category}`;
    Alert.alert("Delete income?", label, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          // Optimistic removal; reload either way to keep totals in sync.
          setData((d) => (d ? { ...d, income: d.income.filter((x) => x.id !== i.id) } : d));
          try {
            await api.income.remove(i.id);
          } catch (err) {
            Alert.alert("Couldn't delete", errorMessage(err));
          }
          invalidateData();
        },
      },
    ]);
  };

  const received = data?.incomeSummary?.total ?? 0;
  const net = received - (data?.summary.total ?? 0);
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
              {data.incomeSummary && (
                <View style={styles.flowRow}>
                  <View style={styles.flowCell} accessible accessibilityLabel={`Received this month: ${formatMoney(received, currency)}`}>
                    <Text style={styles.small}>Received this month</Text>
                    <Text style={[styles.flowValue, { color: Colors.success }]} numberOfLines={1} adjustsFontSizeToFit>
                      +{formatMoney(received, currency)}
                    </Text>
                  </View>
                  <View
                    style={styles.flowCell}
                    accessible
                    accessibilityLabel={`Net this month: ${net < 0 ? "minus " : ""}${formatMoney(Math.abs(net), currency)}`}
                  >
                    <Text style={styles.small}>Net (in − out)</Text>
                    <Text style={[styles.flowValue, { color: net < 0 ? Colors.danger : Colors.success }]} numberOfLines={1} adjustsFontSizeToFit>
                      {net < 0 ? "−" : "+"}
                      {formatMoney(Math.abs(net), currency)}
                    </Text>
                  </View>
                </View>
              )}
            </Card>

            {data.ledger && <BalanceSection ledger={data.ledger} currency={currency} />}

            {data.trends && data.trends.months.length > 0 && <TrendsSection trends={data.trends} currency={currency} />}

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
                    const open = expanded === c.category;
                    const s = open && split?.category === c.category ? split : null;
                    return (
                      <View key={c.category} style={{ gap: 6 }}>
                        <Pressable
                          onPress={() => setExpanded(open ? null : c.category)}
                          accessibilityRole="button"
                          accessibilityLabel={`${c.category}: ${formatMoney(c.total, currency)}, ${c.count} expenses`}
                          accessibilityHint={open ? "Hides the subcategory split" : "Shows the subcategory split"}
                          accessibilityState={{ expanded: open }}
                          style={({ pressed }) => [{ gap: 6, paddingVertical: 2 }, pressed && { opacity: 0.7 }]}
                        >
                          <View style={styles.rowBetween}>
                            <View style={styles.row}>
                              <Ionicons name={meta.icon} size={16} color={meta.color} />
                              <Text style={styles.catName}>{c.category}</Text>
                              <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={Colors.textFaint} />
                            </View>
                            <Text style={styles.amount}>{formatMoney(c.total, currency)}</Text>
                          </View>
                          <ProgressBar value={c.total / maxCat} color={meta.color} />
                        </Pressable>
                        {open && (
                          <View style={styles.split}>
                            {!s || (s.status === "loading" && s.rows.length === 0) ? (
                              <ActivityIndicator size="small" color={meta.color} accessibilityLabel={`Loading ${c.category} subcategories`} />
                            ) : s.status === "error" ? (
                              <Text style={styles.small}>Couldn't load the split. Pull to refresh.</Text>
                            ) : s.rows.length === 0 ? (
                              <Text style={styles.small}>No subcategories yet.</Text>
                            ) : (
                              s.rows.map((r) => (
                                <View
                                  key={r.subcategory}
                                  style={{ gap: 4 }}
                                  accessible
                                  accessibilityLabel={`${r.subcategory}: ${formatMoney(r.total, currency)}, ${r.count} expense${r.count === 1 ? "" : "s"}, ${Math.round((r.total / Math.max(1, c.total)) * 100)} percent of ${c.category}`}
                                >
                                  <View style={styles.rowBetween}>
                                    <Text style={styles.small} numberOfLines={1}>
                                      {r.subcategory} · {r.count}
                                    </Text>
                                    <Text style={styles.small}>
                                      {formatMoney(r.total, currency)} · {Math.round((r.total / Math.max(1, c.total)) * 100)}%
                                    </Text>
                                  </View>
                                  <ProgressBar value={r.total / Math.max(1, c.total)} color={meta.color} height={5} />
                                </View>
                              ))
                            )}
                          </View>
                        )}
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
              <SectionTitle
                right={
                  <Pressable
                    onPress={openIncome}
                    accessibilityRole="button"
                    accessibilityLabel="Add income"
                    hitSlop={8}
                    style={({ pressed }) => [styles.incomeBtn, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons name="add" size={16} color={Colors.success} />
                    <Text style={styles.incomeBtnText}>Add income</Text>
                  </Pressable>
                }
              >
                Money in
              </SectionTitle>
              {data.income.length === 0 ? (
                <Card>
                  <Text style={styles.dim}>No income logged yet. Tap Add income or say "Hey Nila, 75k salary credited".</Text>
                </Card>
              ) : (
                <View style={styles.list}>
                  {data.income.map((i) => {
                    const meta = IncomeCategoryMeta[i.category] ?? IncomeCategoryMeta.Other;
                    const title = i.payer || i.note || i.category;
                    const label = `Received ${formatMoney(i.amount, currency)} from ${title}, ${formatDate(i.date)}`;
                    return (
                      <Pressable
                        key={i.id}
                        onLongPress={() => confirmDeleteIncome(i)}
                        delayLongPress={350}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityHint="Long press to delete"
                        accessibilityActions={[{ name: "delete", label: "Delete income" }]}
                        onAccessibilityAction={(ev) => ev.nativeEvent.actionName === "delete" && confirmDeleteIncome(i)}
                        style={({ pressed }) => [styles.item, pressed && { backgroundColor: Colors.surfaceAlt }]}
                      >
                        <View style={[styles.itemIcon, { backgroundColor: `${meta.color}22` }]}>
                          <Ionicons name={meta.icon as keyof typeof Ionicons.glyphMap} size={18} color={meta.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemTitle} numberOfLines={1}>
                            {title}
                          </Text>
                          <Text style={styles.small} numberOfLines={1}>
                            {formatDate(i.date)} · {i.category}
                            {i.source === "voice" ? " · 🎙" : ""}
                            {i.payer && i.note ? ` · ${i.note}` : ""}
                          </Text>
                        </View>
                        <Text style={[styles.amount, { color: Colors.success }]}>+{formatMoney(i.amount, currency)}</Text>
                      </Pressable>
                    );
                  })}
                  <Text style={[styles.small, { textAlign: "center", marginTop: Spacing.sm }]}>Long-press an entry to delete it</Text>
                </View>
              )}
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
                    const cat = e.subcategory ? `${e.category} · ${e.subcategory}` : e.category;
                    const label = `${e.merchant || cat}, ${formatMoney(e.amount, currency)}, ${formatDate(e.date)}${e.merchant ? `, ${cat}` : ""}`;
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
                            {formatDate(e.date)} · {cat}
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

      <AddIncomeSheet key={`income-${incomeSheetKey}`} visible={addingIncome} onClose={() => setAddingIncome(false)} onCreated={invalidateData} />
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
  flowRow: {
    flexDirection: "row",
    gap: Spacing.md,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  flowCell: { flex: 1, gap: 2 },
  flowValue: { ...Font.h2 },
  incomeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 32,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.success,
    backgroundColor: "rgba(52,211,153,0.08)",
  },
  incomeBtnText: { color: Colors.success, ...Font.small, fontWeight: "700" },
  split: { gap: Spacing.sm, marginLeft: Spacing.xl, paddingLeft: Spacing.md, borderLeftWidth: 2, borderLeftColor: Colors.border, paddingVertical: Spacing.xs },
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

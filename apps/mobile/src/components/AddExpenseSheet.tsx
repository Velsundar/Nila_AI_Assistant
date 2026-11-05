import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CATEGORIES, CreateExpenseSchema, SUBCATEGORIES, type Category, type ReceiptScanResult } from "@nova/shared";

import { Banner, Button, TextField } from "@/components/ui";
import { CategoryMeta, Colors, Font, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Prefill from a scanned receipt. The user still has to tap Save — never auto-saved. */
  receipt?: ReceiptScanResult | null;
};

const CONFIDENCE = {
  high: { color: Colors.success, label: "High confidence", hint: "Looks right — give it a quick check." },
  medium: { color: Colors.warning, label: "Medium confidence", hint: "Please double-check the amount and date." },
  low: { color: Colors.danger, label: "Low confidence", hint: "The receipt was hard to read. Check every field." },
} as const;

/** The API only accepts "YYYY-MM-DD" or a full ISO datetime with Z/offset. */
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

export function AddExpenseSheet({ visible, onClose, onCreated, receipt }: Props) {
  const insets = useSafeAreaInsets();
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<Category>("Food");
  /** Free text; the chips below are SUBCATEGORIES[category]. Empty = let the server infer it. */
  const [subcategory, setSubcategory] = useState("");
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState<string | undefined>(undefined);

  const reset = () => {
    setAmount("");
    setCategory("Food");
    setSubcategory("");
    setMerchant("");
    setNote("");
    setDate(undefined);
    setError(null);
  };

  // Each time the sheet opens with a scan result, prefill from its draft.
  useEffect(() => {
    if (!visible || !receipt) return;
    const d = receipt.draft;
    setAmount(d.amount != null ? String(d.amount) : "");
    setCategory(d.category && (CATEGORIES as readonly string[]).includes(d.category) ? d.category : "Other");
    setSubcategory(d.subcategory ?? "");
    setMerchant(d.merchant ?? "");
    setNote(d.note ?? "");
    setDate(d.date && STRICT_DATE.test(d.date) ? d.date : undefined);
    setError(null);
  }, [visible, receipt]);

  async function save() {
    setError(null);
    const parsed = CreateExpenseSchema.safeParse({
      amount: Number(amount.replace(/,/g, "")),
      category,
      subcategory: subcategory.trim() || undefined,
      merchant: merchant.trim() || undefined,
      note: note.trim() || undefined,
      date,
      source: receipt ? "receipt" : "manual",
    });
    if (!parsed.success || !Number.isFinite(Number(amount.replace(/,/g, "")))) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setBusy(true);
    try {
      await api.expenses.create(parsed.data);
      reset();
      onCreated();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close add expense" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title} accessibilityRole="header">
              {receipt ? "Confirm receipt" : "Add expense"}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
              <Ionicons name="close" size={22} color={Colors.textDim} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {receipt && (
              <View
                style={[styles.badge, { borderColor: CONFIDENCE[receipt.confidence].color }]}
                accessible
                accessibilityLabel={`Scanned receipt, ${CONFIDENCE[receipt.confidence].label}. ${CONFIDENCE[receipt.confidence].hint}`}
              >
                <Ionicons name="scan-outline" size={16} color={CONFIDENCE[receipt.confidence].color} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.badgeTitle, { color: CONFIDENCE[receipt.confidence].color }]}>
                    {CONFIDENCE[receipt.confidence].label}
                  </Text>
                  <Text style={styles.badgeHint}>
                    {CONFIDENCE[receipt.confidence].hint}
                    {date ? ` Dated ${formatDate(date)}.` : ""}
                  </Text>
                </View>
              </View>
            )}
            <TextField
              label="Amount (₹)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              autoFocus={!receipt}
              style={styles.amount}
            />
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Category</Text>
              <View style={styles.cats}>
                {CATEGORIES.map((c) => {
                  const selected = c === category;
                  const meta = CategoryMeta[c];
                  return (
                    <Pressable
                      key={c}
                      onPress={() => {
                        // A chip picked for the old category doesn't belong to the new one; typed text stays.
                        if (c !== category && SUBCATEGORIES[category].includes(subcategory)) setSubcategory("");
                        setCategory(c);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={c}
                      style={[styles.cat, selected && { borderColor: meta.color, backgroundColor: `${meta.color}22` }]}
                    >
                      <Ionicons name={meta.icon as keyof typeof Ionicons.glyphMap} size={14} color={meta.color} />
                      <Text style={[styles.catText, selected && { color: Colors.text }]}>{c}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Subcategory (optional)</Text>
              {SUBCATEGORIES[category].length > 0 && (
                <View style={styles.cats} accessibilityRole="radiogroup" accessibilityLabel={`${category} subcategories`}>
                  {SUBCATEGORIES[category].map((sc) => {
                    const selected = sc.toLowerCase() === subcategory.trim().toLowerCase();
                    const color = CategoryMeta[category].color;
                    return (
                      <Pressable
                        key={sc}
                        onPress={() => setSubcategory(selected ? "" : sc)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={sc}
                        style={[styles.cat, selected && { borderColor: color, backgroundColor: `${color}22` }]}
                      >
                        <Text style={[styles.catText, selected && { color: Colors.text }]}>{sc}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              <TextField
                label="…or type your own"
                value={subcategory}
                onChangeText={setSubcategory}
                placeholder={SUBCATEGORIES[category][0] ? `e.g. ${SUBCATEGORIES[category][0]}` : "e.g. Gift wrap"}
                maxLength={40}
                accessibilityLabel="Subcategory"
              />
            </View>
            <TextField label="Merchant (optional)" value={merchant} onChangeText={setMerchant} placeholder="e.g. Swiggy" maxLength={100} />
            <TextField label="Note (optional)" value={note} onChangeText={setNote} placeholder="Anything to remember" maxLength={500} />
            {error && <Banner tone="error" text={error} />}
            <Button title="Save expense" onPress={save} loading={busy} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: Colors.overlay },
  sheet: {
    backgroundColor: Colors.bgElevated,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    maxHeight: "90%",
    paddingHorizontal: Spacing.lg,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.borderStrong, marginTop: Spacing.sm },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: Spacing.md },
  title: { color: Colors.text, ...Font.h2 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  body: { gap: Spacing.lg, paddingBottom: Spacing.sm },
  amount: { fontSize: 24, fontWeight: "700" },
  label: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
  cats: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  cat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 36,
    backgroundColor: Colors.surface,
  },
  catText: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
  },
  badgeTitle: { ...Font.small, fontWeight: "800" },
  badgeHint: { color: Colors.textDim, ...Font.small },
});

import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
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
import { CreateIncomeSchema, INCOME_CATEGORIES, type IncomeCategory } from "@nova/shared";

import { Banner, Button, TextField } from "@/components/ui";
import { Colors, Font, IncomeCategoryMeta, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
};

/** Money received (salary, refund, someone paying you back). Same sheet layout as AddExpenseSheet. */
export function AddIncomeSheet({ visible, onClose, onCreated }: Props) {
  const insets = useSafeAreaInsets();
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<IncomeCategory>("Salary");
  const [payer, setPayer] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setAmount("");
    setCategory("Salary");
    setPayer("");
    setNote("");
    setError(null);
  };

  async function save() {
    setError(null);
    const parsed = CreateIncomeSchema.safeParse({
      amount: Number(amount.replace(/,/g, "")),
      category,
      payer: payer.trim() || undefined,
      note: note.trim() || undefined,
      source: "manual",
    });
    if (!parsed.success || !Number.isFinite(Number(amount.replace(/,/g, "")))) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setBusy(true);
    try {
      await api.income.create(parsed.data);
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
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close add income" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title} accessibilityRole="header">
              Add money in
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
              <Ionicons name="close" size={22} color={Colors.textDim} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            <TextField
              label="Amount received (₹)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              autoFocus
              style={styles.amount}
            />
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Category</Text>
              <View style={styles.cats} accessibilityRole="radiogroup">
                {INCOME_CATEGORIES.map((c) => {
                  const selected = c === category;
                  const meta = IncomeCategoryMeta[c];
                  return (
                    <Pressable
                      key={c}
                      onPress={() => setCategory(c)}
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
            <TextField label="From (optional)" value={payer} onChangeText={setPayer} placeholder="e.g. Acme Corp, Ravi" maxLength={100} />
            <TextField label="Note (optional)" value={note} onChangeText={setNote} placeholder="Anything to remember" maxLength={500} />
            {error && <Banner tone="error" text={error} />}
            <Button title="Save income" onPress={save} loading={busy} style={{ backgroundColor: Colors.success }} />
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
});

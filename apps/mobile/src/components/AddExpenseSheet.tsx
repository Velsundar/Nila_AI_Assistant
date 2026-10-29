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
import { CATEGORIES, CreateExpenseSchema, type Category } from "@nova/shared";

import { Banner, Button, TextField } from "@/components/ui";
import { CategoryMeta, Colors, Font, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";

type Props = { visible: boolean; onClose: () => void; onCreated: () => void };

export function AddExpenseSheet({ visible, onClose, onCreated }: Props) {
  const insets = useSafeAreaInsets();
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<Category>("Food");
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setAmount("");
    setCategory("Food");
    setMerchant("");
    setNote("");
    setError(null);
  };

  async function save() {
    setError(null);
    const parsed = CreateExpenseSchema.safeParse({
      amount: Number(amount.replace(/,/g, "")),
      category,
      merchant: merchant.trim() || undefined,
      note: note.trim() || undefined,
      source: "manual",
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
              Add expense
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
              <Ionicons name="close" size={22} color={Colors.textDim} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            <TextField
              label="Amount (₹)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              autoFocus
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
});

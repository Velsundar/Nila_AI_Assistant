import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Note } from "@nova/shared";

import { Banner, Button, Card, SectionTitle } from "@/components/ui";
import { Colors, Font, HitSize, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Props = {
  notes: Note[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  onChanged: () => void;
};

export function NotesSection({ notes, setNotes, onChanged }: Props) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Note[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);
  const searchSeq = useRef(0);

  // Debounced server-side search (?q=). Empty query → show the normal list.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { notes: found } = await api.notes.list({ q });
        if (seq === searchSeq.current) setResults(found);
      } catch (e) {
        if (seq === searchSeq.current) setError(errorMessage(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function add() {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    setError(null);
    try {
      const { note } = await api.notes.create({ text: t });
      setNotes((ns) => [note, ...ns]);
      setText("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const replace = (n: Note) => {
    setNotes((ns) => ns.map((x) => (x.id === n.id ? n : x)));
    setResults((rs) => rs?.map((x) => (x.id === n.id ? n : x)) ?? null);
  };
  const drop = (id: string) => {
    setNotes((ns) => ns.filter((x) => x.id !== id));
    setResults((rs) => rs?.filter((x) => x.id !== id) ?? null);
  };

  const shown = results ?? notes;

  return (
    <View>
      <SectionTitle>Notes</SectionTitle>
      <Card style={{ gap: Spacing.md }}>
        <TextInput
          style={styles.quick}
          value={text}
          onChangeText={setText}
          placeholder="Quick note… (e.g. parked on level 3, spot B12)"
          placeholderTextColor={Colors.textFaint}
          selectionColor={Colors.primary}
          multiline
          maxLength={5000}
          accessibilityLabel="New note"
        />
        <Button title="Save note" onPress={() => void add()} loading={saving} disabled={!text.trim()} />
        {error && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}
      </Card>

      <View style={styles.search}>
        <Ionicons name="search" size={16} color={Colors.textFaint} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search notes"
          placeholderTextColor={Colors.textFaint}
          selectionColor={Colors.primary}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search notes"
        />
        {searching ? (
          <ActivityIndicator size="small" color={Colors.primary} />
        ) : query ? (
          <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={Colors.textFaint} />
          </Pressable>
        ) : null}
      </View>

      <View style={{ gap: Spacing.sm }}>
        {shown.length === 0 ? (
          <Text style={[styles.dim, { textAlign: "center", paddingVertical: Spacing.md }]}>
            {results ? `No notes match "${query.trim()}".` : `No notes yet. Jot one above or say "note that the wifi password is…".`}
          </Text>
        ) : (
          shown.map((n) => (
            <Pressable
              key={n.id}
              onPress={() => setEditing(n)}
              accessibilityRole="button"
              accessibilityLabel={`Note: ${n.text}`}
              accessibilityHint="Opens the note to edit or delete"
              style={({ pressed }) => [styles.note, pressed && { backgroundColor: Colors.surfaceAlt }]}
            >
              <Text style={styles.noteText} numberOfLines={4}>
                {n.text}
              </Text>
              <Text style={styles.small}>{formatDate(n.updatedAt || n.createdAt)}</Text>
            </Pressable>
          ))
        )}
      </View>

      <NoteSheet
        note={editing}
        onClose={() => setEditing(null)}
        onSaved={(n) => {
          replace(n);
          onChanged();
        }}
        onDeleted={(id) => {
          drop(id);
          onChanged();
        }}
      />
    </View>
  );
}

function NoteSheet({
  note,
  onClose,
  onSaved,
  onDeleted,
}: {
  note: Note | null;
  onClose: () => void;
  onSaved: (n: Note) => void;
  onDeleted: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (note) {
      setText(note.text);
      setError(null);
    }
  }, [note]);

  if (!note) return null;

  async function save() {
    if (!note || !text.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const { note: updated } = await api.notes.update(note.id, { text: text.trim() });
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function remove() {
    if (!note) return;
    const id = note.id;
    Alert.alert("Delete note?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy("delete");
          try {
            await api.notes.remove(id);
            onDeleted(id);
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close note" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]} accessibilityViewIsModal>
          <View style={styles.headerRow}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              Edit note
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
              <Ionicons name="close" size={22} color={Colors.textDim} />
            </Pressable>
          </View>
          <TextInput
            style={[styles.quick, { minHeight: 140 }]}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            maxLength={5000}
            selectionColor={Colors.primary}
            accessibilityLabel="Note text"
          />
          {error && <Banner tone="error" text={error} />}
          <View style={styles.actions}>
            <Button title="Delete" variant="danger" onPress={remove} loading={busy === "delete"} style={{ flex: 1 }} />
            <Button title="Save" onPress={() => void save()} loading={busy === "save"} disabled={!text.trim() || text.trim() === note.text} style={{ flex: 2 }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  quick: {
    minHeight: 72,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bgElevated,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    color: Colors.text,
    textAlignVertical: "top",
    ...Font.body,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginVertical: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    minHeight: HitSize,
  },
  searchInput: { flex: 1, color: Colors.text, ...Font.body, paddingVertical: Spacing.sm },
  note: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: 6,
  },
  noteText: { color: Colors.text, ...Font.body, lineHeight: 21 },
  dim: { color: Colors.textDim, ...Font.small },
  small: { color: Colors.textFaint, ...Font.small },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: Colors.overlay },
  sheet: {
    backgroundColor: Colors.bgElevated,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
    maxHeight: "90%",
  },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: Spacing.md },
  sheetTitle: { color: Colors.text, ...Font.h2 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", gap: Spacing.md },
});

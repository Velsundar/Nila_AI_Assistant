import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { UpdateTaskSchema, type Task, type TaskPriority, type UpdateTaskInput } from "@nova/shared";

import { Chip, ChipRow, DUE_CHOICES, PRIORITIES, SUGGESTED_LISTS, dueFor, sameList } from "@/components/task-options";
import { Banner, Button, TextField } from "@/components/ui";
import { Colors, Font, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { dueLabel, localISODate, parseLocalDate } from "@/lib/format";

type Props = {
  /** The task to show; null hides the sheet. Kept live by the parent, so a checkbox toggle shows here too. */
  task: Task | null;
  /** List names already in use, for the list chips. */
  lists: string[];
  onClose: () => void;
  /** Server copy after a successful edit. */
  onSaved: (task: Task) => void;
  /** Asks the parent to confirm + delete (same flow as long-press). */
  onDelete: (task: Task) => void;
};

/** The task's due date as a local "YYYY-MM-DD", or null. */
function dueDay(due: string | undefined): string | null {
  if (!due) return null;
  const d = parseLocalDate(due);
  return Number.isNaN(d.getTime()) ? null : localISODate(d);
}

function stamp(iso: string | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TaskDetailsSheet({ task, lists, onClose, onSaved, onDelete }: Props) {
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [list, setList] = useState("");
  const [newList, setNewList] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id;
  // Opening a (different) task resets to view mode.
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [taskId]);

  const startEdit = () => {
    if (!task) return;
    setTitle(task.title);
    setList(task.list);
    setNewList("");
    setDue(dueDay(task.dueDate));
    setPriority(task.priority);
    setError(null);
    setEditing(true);
  };

  const listChoices = useMemo(() => {
    const names = [...SUGGESTED_LISTS];
    for (const n of [...lists, task?.list ?? ""]) if (n && !names.some((x) => sameList(x, n))) names.push(n);
    return names;
  }, [lists, task?.list]);

  async function save() {
    if (!task) return;
    setError(null);
    const targetList = newList.trim() || list;
    const patch: UpdateTaskInput = {};
    if (title.trim() !== task.title) patch.title = title.trim();
    if (!sameList(targetList, task.list)) patch.list = targetList;
    if (due !== dueDay(task.dueDate)) patch.dueDate = due; // null clears it
    if (priority !== task.priority) patch.priority = priority;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    const parsed = UpdateTaskSchema.safeParse(patch);
    if (!parsed.success) {
      setError(!title.trim() ? "The title can't be empty." : "Titles can be up to 200 characters, list names up to 40.");
      return;
    }
    setBusy(true);
    try {
      const { task: updated } = await api.tasks.update(task.id, parsed.data);
      onSaved(updated);
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const quickDays = DUE_CHOICES.map((c) => ({ ...c, day: dueFor(c.key) ?? null }));
  // A due date that isn't one of the quick choices (e.g. set by voice) stays selectable.
  const customDue = due && !quickDays.some((c) => c.day === due) ? due : null;
  const dueInfo = task ? dueLabel(task.dueDate) : null;
  const priorityMeta = PRIORITIES.find((p) => p.key === task?.priority) ?? PRIORITIES[1];

  return (
    <Modal visible={!!task} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close task details" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title} accessibilityRole="header">
              {editing ? "Edit task" : "Task details"}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.close}>
              <Ionicons name="close" size={22} color={Colors.textDim} />
            </Pressable>
          </View>
          {task && (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
              {editing ? (
                <>
                  <TextField label="Title" value={title} onChangeText={setTitle} maxLength={200} autoFocus />
                  <ChipRow label="List">
                    {listChoices.map((n) => (
                      <Chip key={n} label={n} selected={!newList.trim() && sameList(n, list)} onPress={() => (setList(n), setNewList(""))} />
                    ))}
                  </ChipRow>
                  <TextField label="…or a new list name" value={newList} onChangeText={setNewList} maxLength={40} placeholder="e.g. Groceries" />
                  <ChipRow label="Due">
                    {quickDays.map((c) => (
                      <Chip key={c.key} label={c.label} selected={due === c.day} onPress={() => setDue(c.day)} />
                    ))}
                    {customDue && <Chip label={dueLabel(customDue)?.text ?? customDue} selected onPress={() => {}} />}
                  </ChipRow>
                  <ChipRow label="Priority">
                    {PRIORITIES.map((p) => (
                      <Chip key={p.key} label={p.label} color={p.color} selected={priority === p.key} onPress={() => setPriority(p.key)} />
                    ))}
                  </ChipRow>
                  {error && <Banner tone="error" text={error} />}
                  <Button title="Save changes" onPress={() => void save()} loading={busy} />
                  <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} disabled={busy} />
                </>
              ) : (
                <>
                  <Text style={[styles.taskTitle, task.done && styles.taskDone]} accessibilityLabel={`${task.title}${task.done ? ", completed" : ""}`}>
                    {task.title}
                  </Text>
                  <View style={styles.facts}>
                    <Fact icon="list-outline" label="List" value={task.list} />
                    <Fact
                      icon="calendar-outline"
                      label="Due"
                      value={dueInfo?.text ?? "No date"}
                      color={!task.done && dueInfo?.tone === "overdue" ? Colors.danger : !task.done && dueInfo?.tone === "today" ? Colors.warning : undefined}
                    />
                    <Fact icon="flag-outline" label="Priority" value={priorityMeta.label} color={task.priority === "high" ? Colors.danger : undefined} />
                    <Fact icon="time-outline" label="Created" value={stamp(task.createdAt)} />
                    <Fact
                      icon="checkmark-done-outline"
                      label="Completed"
                      value={task.done ? stamp(task.completedAt) : "Not yet"}
                      color={task.done ? Colors.success : undefined}
                    />
                  </View>
                  <Button
                    title="Edit"
                    variant="secondary"
                    onPress={startEdit}
                    accessibilityLabel="Edit task"
                    icon={<Ionicons name="create-outline" size={18} color={Colors.primary} />}
                  />
                  <Button
                    title="Delete task"
                    variant="danger"
                    onPress={() => onDelete(task)}
                    icon={<Ionicons name="trash-outline" size={18} color={Colors.danger} />}
                  />
                </>
              )}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Fact({ icon, label, value, color }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; color?: string }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      <Ionicons name={icon} size={16} color={Colors.textFaint} />
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
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
  taskTitle: { color: Colors.text, ...Font.h3, fontSize: 18 },
  taskDone: { color: Colors.textFaint, textDecorationLine: "line-through" },
  facts: { backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  fact: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  factLabel: { color: Colors.textDim, ...Font.small, width: 80 },
  factValue: { color: Colors.text, ...Font.body, flex: 1, textAlign: "right" },
});

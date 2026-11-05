import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { CreateTaskSchema, DEFAULT_TASK_LIST, type Task, type TaskPriority } from "@nova/shared";

import { TaskDetailsSheet } from "@/components/TaskDetailsSheet";
import { Chip, ChipRow, DUE_CHOICES, PRIORITIES, SUGGESTED_LISTS, dueFor, sameList, type DueChoice } from "@/components/task-options";
import { Banner, Card, SectionTitle } from "@/components/ui";
import { Colors, Font, HitSize, Radius, Spacing } from "@/constants/theme";
import { api, errorMessage } from "@/lib/api";
import { dueLabel } from "@/lib/format";

type Props = {
  tasks: Task[];
  setTasks: Dispatch<SetStateAction<Task[]>>;
  /** Something changed (so other screens / the briefing can refresh). */
  onChanged: () => void;
};

export function TasksSection({ tasks, setTasks, onChanged }: Props) {
  const [title, setTitle] = useState("");
  const [list, setList] = useState(DEFAULT_TASK_LIST);
  const [newList, setNewList] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [due, setDue] = useState<DueChoice>("none");
  const [showOptions, setShowOptions] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  /** Task whose details sheet is open. Looked up live so toggles/edits show in the sheet. */
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsTask = detailsId ? (tasks.find((t) => t.id === detailsId) ?? null) : null;

  /** Lists in a stable order: Inbox first, then by first appearance. */
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; open: Task[]; done: Task[] }>();
    const ensure = (name: string) => {
      const key = name.trim().toLowerCase();
      if (!map.has(key)) map.set(key, { name, open: [], done: [] });
      return map.get(key)!;
    };
    ensure(DEFAULT_TASK_LIST);
    for (const t of tasks) (t.done ? ensure(t.list).done : ensure(t.list).open).push(t);
    const rank = { high: 0, normal: 1, low: 2 } as const;
    for (const g of map.values()) {
      g.open.sort(
        (a, b) =>
          (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt),
      );
    }
    return [...map.values()].filter((g) => g.open.length || g.done.length || sameList(g.name, DEFAULT_TASK_LIST));
  }, [tasks]);

  const listChoices = useMemo(() => {
    const names = [...SUGGESTED_LISTS];
    for (const g of groups) if (!names.some((n) => sameList(n, g.name))) names.push(g.name);
    return names;
  }, [groups]);

  async function add() {
    setError(null);
    const target = newList.trim() || list;
    const parsed = CreateTaskSchema.safeParse({ title: title.trim(), list: target, priority, dueDate: dueFor(due) });
    if (!parsed.success) {
      setError(title.trim() ? "List names can be up to 40 characters." : "Type a task first.");
      return;
    }
    setAdding(true);
    try {
      const { task } = await api.tasks.create(parsed.data);
      setTasks((ts) => [task, ...ts]);
      setTitle("");
      setNewList("");
      setList(task.list);
      setDue("none");
      setPriority("normal");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  async function toggle(t: Task) {
    const done = !t.done;
    void (done
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.selectionAsync()
    ).catch(() => {});
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done } : x)));
    try {
      const { task } = await api.tasks.update(t.id, { done });
      setTasks((ts) => ts.map((x) => (x.id === t.id ? task : x)));
      onChanged();
    } catch (e) {
      setTasks((ts) => ts.map((x) => (x.id === t.id ? t : x)));
      setError(errorMessage(e));
    }
  }

  function confirmDelete(t: Task) {
    Alert.alert("Delete task?", t.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          setTasks((ts) => ts.filter((x) => x.id !== t.id));
          try {
            await api.tasks.remove(t.id);
            onChanged();
          } catch (e) {
            setTasks((ts) => [t, ...ts]);
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  const onSaved = (task: Task) => {
    setTasks((ts) => ts.map((x) => (x.id === task.id ? task : x)));
    onChanged();
  };

  return (
    <View>
      <SectionTitle>Tasks</SectionTitle>
      <Card style={{ gap: Spacing.md }}>
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            value={title}
            onChangeText={setTitle}
            placeholder={`Add to ${newList.trim() || list}…`}
            placeholderTextColor={Colors.textFaint}
            selectionColor={Colors.primary}
            returnKeyType="done"
            onSubmitEditing={() => void add()}
            maxLength={200}
            accessibilityLabel={`New task title, adding to ${newList.trim() || list}`}
          />
          <Pressable
            onPress={() => setShowOptions((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showOptions ? "Hide task options" : "Show task options: list, due date, priority"}
            accessibilityState={{ expanded: showOptions }}
            style={[styles.iconBtn, showOptions && { borderColor: Colors.primary }]}
          >
            <Ionicons name="options-outline" size={20} color={showOptions ? Colors.primary : Colors.textDim} />
          </Pressable>
          <Pressable
            onPress={() => void add()}
            disabled={!title.trim() || adding}
            accessibilityRole="button"
            accessibilityLabel="Add task"
            accessibilityState={{ disabled: !title.trim() || adding, busy: adding }}
            style={[styles.addBtn, (!title.trim() || adding) && { opacity: 0.4 }]}
          >
            <Ionicons name="add" size={24} color={Colors.bg} />
          </Pressable>
        </View>

        {showOptions && (
          <View style={styles.options}>
            <ChipRow label="List">
              {listChoices.map((n) => (
                <Chip key={n} label={n} selected={!newList.trim() && sameList(n, list)} onPress={() => (setList(n), setNewList(""))} />
              ))}
            </ChipRow>
            <TextInput
              style={styles.smallInput}
              value={newList}
              onChangeText={setNewList}
              placeholder="…or a new list name"
              placeholderTextColor={Colors.textFaint}
              selectionColor={Colors.primary}
              maxLength={40}
              accessibilityLabel="New list name"
            />
            <ChipRow label="Due">
              {DUE_CHOICES.map((d) => (
                <Chip key={d.key} label={d.label} selected={due === d.key} onPress={() => setDue(d.key)} />
              ))}
            </ChipRow>
            <ChipRow label="Priority">
              {PRIORITIES.map((p) => (
                <Chip key={p.key} label={p.label} color={p.color} selected={priority === p.key} onPress={() => setPriority(p.key)} />
              ))}
            </ChipRow>
          </View>
        )}

        {error && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}
      </Card>

      <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
        {groups.map((g) => {
          const doneOpen = !!showDone[g.name.toLowerCase()];
          return (
            <View key={g.name.toLowerCase()} style={styles.group}>
              <View style={styles.groupHeader}>
                <Ionicons name={sameList(g.name, "Shopping") ? "cart-outline" : sameList(g.name, DEFAULT_TASK_LIST) ? "file-tray-outline" : "list-outline"} size={16} color={Colors.accent} />
                <Text style={styles.groupName} accessibilityRole="header">
                  {g.name}
                </Text>
                <Text style={styles.count}>{g.open.length}</Text>
              </View>
              {g.open.length === 0 && g.done.length === 0 && (
                <Text style={[styles.dim, { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md }]}>
                  Nothing here. Add a task above or say "add milk to my shopping list".
                </Text>
              )}
              {g.open.map((t) => (
                <TaskRow key={t.id} task={t} onToggle={() => void toggle(t)} onOpen={() => setDetailsId(t.id)} onDelete={() => confirmDelete(t)} />
              ))}
              {g.done.length > 0 && (
                <Pressable
                  onPress={() => setShowDone((s) => ({ ...s, [g.name.toLowerCase()]: !doneOpen }))}
                  accessibilityRole="button"
                  accessibilityLabel={`${doneOpen ? "Hide" : "Show"} ${g.done.length} completed in ${g.name}`}
                  style={styles.doneToggle}
                >
                  <Ionicons name={doneOpen ? "chevron-up" : "chevron-down"} size={14} color={Colors.textFaint} />
                  <Text style={styles.small}>
                    {doneOpen ? "Hide" : "Show"} completed ({g.done.length})
                  </Text>
                </Pressable>
              )}
              {doneOpen &&
                g.done.map((t) => (
                  <TaskRow key={t.id} task={t} onToggle={() => void toggle(t)} onOpen={() => setDetailsId(t.id)} onDelete={() => confirmDelete(t)} />
                ))}
            </View>
          );
        })}
        <Text style={[styles.small, { textAlign: "center" }]}>Tap the circle to complete · tap a task for details · long-press to delete</Text>
      </View>

      <TaskDetailsSheet
        task={detailsTask}
        lists={groups.map((g) => g.name)}
        onClose={() => setDetailsId(null)}
        onSaved={onSaved}
        onDelete={confirmDelete}
      />
    </View>
  );
}

function TaskRow({ task: t, onToggle, onOpen, onDelete }: { task: Task; onToggle: () => void; onOpen: () => void; onDelete: () => void }) {
  const due = dueLabel(t.dueDate);
  const dueColor = due?.tone === "overdue" ? Colors.danger : due?.tone === "today" ? Colors.warning : Colors.textDim;
  const label = [t.title, t.done ? "completed" : null, due?.text, t.priority !== "normal" ? `${t.priority} priority` : null]
    .filter(Boolean)
    .join(", ");
  // Two siblings (not nested) so screen readers reach both: the circle toggles done, the rest opens details.
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: t.done }}
        accessibilityLabel={t.title}
        accessibilityHint={t.done ? "Marks the task as not done" : "Marks the task as done"}
        hitSlop={4}
        style={({ pressed }) => [styles.check, pressed && { opacity: 0.6 }]}
      >
        <Ionicons
          name={t.done ? "checkmark-circle" : "ellipse-outline"}
          size={24}
          color={t.done ? Colors.success : t.priority === "high" ? Colors.danger : Colors.borderStrong}
        />
      </Pressable>
      <Pressable
        onPress={onOpen}
        onLongPress={onDelete}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens task details. Long press to delete."
        accessibilityActions={[{ name: "delete", label: "Delete task" }]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === "delete" && onDelete()}
        style={({ pressed }) => [styles.rowBody, pressed && { backgroundColor: Colors.surfaceAlt }]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.title, t.done && styles.titleDone]} numberOfLines={2}>
            {t.title}
          </Text>
          {(due || t.priority !== "normal") && !t.done && (
            <View style={styles.meta}>
              {due && <Text style={[styles.small, { color: dueColor, fontWeight: "700" }]}>{due.text}</Text>}
              {t.priority === "high" && (
                <View style={styles.meta}>
                  <Ionicons name="flag" size={11} color={Colors.danger} />
                  <Text style={[styles.small, { color: Colors.danger }]}>High</Text>
                </View>
              )}
              {t.priority === "low" && <Text style={[styles.small, { color: Colors.textFaint }]}>Low</Text>}
            </View>
          )}
        </View>
        <Ionicons name="chevron-forward" size={16} color={Colors.textFaint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  addRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  addInput: {
    flex: 1,
    minHeight: HitSize + 4,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bgElevated,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    color: Colors.text,
    ...Font.body,
  },
  smallInput: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bgElevated,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    color: Colors.text,
    ...Font.small,
  },
  iconBtn: {
    width: HitSize,
    height: HitSize,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: { width: HitSize, height: HitSize, borderRadius: Radius.md, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  options: { gap: Spacing.md },
  group: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  groupName: { color: Colors.text, ...Font.h3, flex: 1 },
  count: { color: Colors.textFaint, ...Font.small, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  check: { width: HitSize + Spacing.lg, paddingLeft: Spacing.lg, justifyContent: "center" },
  rowBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing.sm, paddingRight: Spacing.lg },
  title: { color: Colors.text, ...Font.body },
  titleDone: { color: Colors.textFaint, textDecorationLine: "line-through" },
  meta: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  doneToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: Spacing.lg,
    minHeight: 40,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  dim: { color: Colors.textDim, ...Font.small },
  small: { color: Colors.textDim, ...Font.small },
});

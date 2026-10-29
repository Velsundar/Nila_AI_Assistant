import { forwardRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { Colors, Font, HitSize, Radius, Spacing } from "@/constants/theme";

type ButtonProps = Omit<PressableProps, "style" | "children"> & {
  title: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, variant = "primary", loading, icon, disabled, style, ...rest }: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rest.accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variantStyles[variant],
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? Colors.bg : Colors.text} />
      ) : (
        <View style={styles.btnRow}>
          {icon}
          <Text style={[styles.btnText, variant === "primary" && { color: Colors.bg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

type FieldProps = TextInputProps & { label: string; error?: string | null };

export const TextField = forwardRef<TextInputInstance, FieldProps>(function TextField({ label, error, style, ...rest }, ref) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={rest.accessibilityLabel ?? label}
        placeholderTextColor={Colors.textFaint}
        selectionColor={Colors.primary}
        style={[styles.input, !!error && { borderColor: Colors.danger }, style]}
        {...rest}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
});

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.section} accessibilityRole="header">
        {children}
      </Text>
      {right}
    </View>
  );
}

export function ProgressBar({ value, color, height = 8 }: { value: number; color: string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={[styles.track, { height, borderRadius: height }]}>
      <View style={{ width: `${pct * 100}%`, height, borderRadius: height, backgroundColor: color }} />
    </View>
  );
}

export function Banner({ text, tone = "info", onDismiss }: { text: string; tone?: "info" | "warn" | "error"; onDismiss?: () => void }) {
  const color = tone === "error" ? Colors.danger : tone === "warn" ? Colors.warning : Colors.primary;
  return (
    <Pressable
      onPress={onDismiss}
      disabled={!onDismiss}
      accessibilityRole={onDismiss ? "button" : "text"}
      accessibilityLabel={onDismiss ? `${text}. Tap to dismiss.` : text}
      style={[styles.banner, { borderColor: color }]}
    >
      <Text style={[styles.bannerText, { color }]}>{text}</Text>
    </Pressable>
  );
}

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: Colors.primary },
  secondary: { backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.borderStrong },
  danger: { backgroundColor: "rgba(248,113,113,0.12)", borderWidth: 1, borderColor: Colors.danger },
  ghost: { backgroundColor: "transparent" },
});

const styles = StyleSheet.create({
  btn: {
    minHeight: HitSize + 4,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  btnRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  btnText: { color: Colors.text, ...Font.h3 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.5 },
  field: { gap: 6 },
  label: { color: Colors.textDim, ...Font.small, fontWeight: "600" },
  input: {
    minHeight: HitSize + 4,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    color: Colors.text,
    ...Font.body,
  },
  error: { color: Colors.danger, ...Font.small },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: Spacing.sm },
  section: { color: Colors.textDim, ...Font.tiny, fontWeight: "700" },
  track: { width: "100%", backgroundColor: Colors.surfaceAlt, overflow: "hidden" },
  banner: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: "rgba(14,20,36,0.9)",
  },
  bannerText: { ...Font.small, textAlign: "center" },
});

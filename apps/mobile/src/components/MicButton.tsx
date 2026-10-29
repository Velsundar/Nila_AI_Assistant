import Ionicons from "@expo/vector-icons/Ionicons";
import { useRef } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, withSpring, type SharedValue } from "react-native-reanimated";

import { Colors, OrbColors } from "@/constants/theme";

type Props = {
  listening: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  volume: SharedValue<number>;
  size?: number;
  /** Begin listening. */
  onStart: () => void;
  /** Stop and send. */
  onStop: () => void;
};

const HOLD_MS = 400;

/**
 * Hybrid mic: tap to toggle (the recognizer also auto-stops on silence),
 * or press-and-hold for push-to-talk (release sends).
 */
export function MicButton({ listening, disabled, unavailable, volume, size = 72, onStart, onStop }: Props) {
  const pressStart = useRef(0);
  const startedByThisPress = useRef(false);

  const ring = useAnimatedStyle(() => ({
    opacity: listening ? 0.35 + volume.value * 0.5 : 0,
    transform: [{ scale: withSpring(listening ? 1.15 + volume.value * 0.45 : 1) }],
  }));

  const color = listening ? OrbColors.listening : unavailable ? Colors.textFaint : Colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={listening ? "Stop listening and send" : "Talk to the assistant"}
      accessibilityHint={unavailable ? "Voice needs a development build; use the text box instead" : "Tap to talk, or hold to talk and release to send"}
      accessibilityState={{ disabled: !!disabled, selected: listening }}
      disabled={disabled}
      hitSlop={8}
      onPressIn={() => {
        pressStart.current = Date.now();
        if (listening) {
          startedByThisPress.current = false;
        } else {
          startedByThisPress.current = true;
          onStart();
        }
      }}
      onPressOut={() => {
        const held = Date.now() - pressStart.current >= HOLD_MS;
        if (!startedByThisPress.current) onStop(); // tap while listening → stop
        else if (held) onStop(); // push-to-talk release
      }}
      style={({ pressed }) => [styles.wrap, { width: size, height: size }, pressed && { transform: [{ scale: 0.95 }] }]}
    >
      <Animated.View
        style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderColor: color }, ring]}
      />
      <Animated.View
        style={[
          styles.btn,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: listening ? "rgba(52,211,153,0.18)" : "rgba(56,189,248,0.14)",
            borderColor: color,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      >
        <Ionicons name={listening ? "stop" : unavailable ? "mic-off" : "mic"} size={size * 0.42} color={color} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", borderWidth: 2 },
  btn: { alignItems: "center", justifyContent: "center", borderWidth: 2 },
});

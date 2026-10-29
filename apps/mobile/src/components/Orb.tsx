import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

import { OrbColors } from "@/constants/theme";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const STATE_INDEX: Record<OrbState, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3 };
const PALETTE = [OrbColors.idle, OrbColors.listening, OrbColors.thinking, OrbColors.speaking];
const STATE_LABEL: Record<OrbState, string> = {
  idle: "Assistant is idle",
  listening: "Assistant is listening",
  thinking: "Assistant is thinking",
  speaking: "Assistant is speaking",
};

type Props = {
  state: OrbState;
  size: number;
  /** Mic level 0..1 (only used while listening). */
  volume?: SharedValue<number>;
};

/**
 * Nova's robot orb. Layers (back → front): glow halos, two dashed rings, the sphere core
 * with a 3D highlight, a visor with two eyes, and an equalizer "mouth" while speaking.
 *
 *  idle      – slow breathing glow, lazy ring drift, periodic blink
 *  listening – grows and glows with mic volume, eyes widen
 *  thinking  – rings spin fast in opposite directions, eyes glance side to side
 *  speaking  – rhythmic pulse + equalizer mouth
 */
function OrbImpl({ state, size, volume }: Props) {
  const reduceMotion = useReducedMotion();
  const mode = useSharedValue(STATE_INDEX[state]);
  const colorT = useSharedValue(STATE_INDEX[state]);
  const breathe = useSharedValue(0);
  const ringA = useSharedValue(0);
  const ringB = useSharedValue(0);
  const pulse = useSharedValue(0);
  const blink = useSharedValue(1);
  const look = useSharedValue(0);
  const fallbackVolume = useSharedValue(0);
  const vol = volume ?? fallbackVolume;
  const smoothVol = useDerivedValue(() => withSpring(vol.value, { damping: 14, stiffness: 180, mass: 0.6 }));

  // Always-on ambient loops.
  useEffect(() => {
    breathe.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    blink.value = withRepeat(
      withSequence(withDelay(3200, withTiming(0.1, { duration: 90 })), withTiming(1, { duration: 140 })),
      -1,
      false,
    );
    return () => {
      cancelAnimation(breathe);
      cancelAnimation(blink);
    };
  }, [breathe, blink]);

  // Per-state animation drivers.
  useEffect(() => {
    const idx = STATE_INDEX[state];
    mode.value = idx;
    colorT.value = withTiming(idx, { duration: 450 });

    const spin = (sv: SharedValue<number>, durationMs: number, dir: 1 | -1) => {
      cancelAnimation(sv);
      const from = sv.value % 360;
      sv.value = from;
      if (reduceMotion) return;
      sv.value = withRepeat(withTiming(from + 360 * dir, { duration: durationMs, easing: Easing.linear }), -1, false);
    };
    const fast = state === "thinking";
    spin(ringA, fast ? 1100 : state === "listening" ? 6000 : 16000, 1);
    spin(ringB, fast ? 1600 : state === "listening" ? 9000 : 22000, -1);

    cancelAnimation(pulse);
    if (state === "speaking" && !reduceMotion) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 170, easing: Easing.out(Easing.quad) }),
          withTiming(0.35, { duration: 210 }),
          withTiming(0.8, { duration: 150 }),
          withTiming(0.1, { duration: 260 }),
        ),
        -1,
        false,
      );
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }

    cancelAnimation(look);
    if (state === "thinking" && !reduceMotion) {
      look.value = withRepeat(
        withSequence(
          withTiming(-1, { duration: 420, easing: Easing.inOut(Easing.quad) }),
          withDelay(250, withTiming(1, { duration: 520, easing: Easing.inOut(Easing.quad) })),
          withDelay(250, withTiming(0, { duration: 380 })),
        ),
        -1,
        false,
      );
    } else {
      look.value = withTiming(0, { duration: 250 });
    }
  }, [state, reduceMotion, mode, colorT, ringA, ringB, pulse, look]);

  /** Overall sphere scale, per state. */
  const scale = useDerivedValue(() => {
    switch (mode.value) {
      case 1:
        return 1 + smoothVol.value * 0.22 + breathe.value * 0.015;
      case 2:
        return 0.94 + breathe.value * 0.02;
      case 3:
        return 1 + pulse.value * 0.08;
      default:
        return 1 + breathe.value * 0.035;
    }
  });
  const glow = useDerivedValue(() => {
    switch (mode.value) {
      case 1:
        return 0.45 + smoothVol.value * 0.55;
      case 2:
        return 0.35 + breathe.value * 0.2;
      case 3:
        return 0.45 + pulse.value * 0.5;
      default:
        return 0.3 + breathe.value * 0.3;
    }
  });

  const color = useDerivedValue(() => interpolateColor(colorT.value, [0, 1, 2, 3], PALETTE));

  const haloOuter = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    opacity: 0.07 + glow.value * 0.1,
    transform: [{ scale: 0.9 + glow.value * 0.22 }],
  }));
  const haloMid = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    opacity: 0.1 + glow.value * 0.14,
    transform: [{ scale: 0.95 + glow.value * 0.12 }],
  }));
  const haloInner = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    opacity: 0.18 + glow.value * 0.18,
    transform: [{ scale: scale.value * 1.02 }],
  }));
  const ringAStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${ringA.value}deg` }, { scale: 0.98 + glow.value * 0.04 }],
    opacity: mode.value === 2 ? 1 : 0.55 + glow.value * 0.35,
  }));
  const ringBStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${ringB.value}deg` }],
    opacity: mode.value === 2 ? 0.95 : 0.4 + glow.value * 0.3,
  }));
  const coreStyle = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    transform: [{ scale: scale.value }],
  }));
  const eyeStyle = useAnimatedStyle(() => {
    const open = mode.value === 1 ? 1.25 + smoothVol.value * 0.3 : mode.value === 2 ? 0.55 : 1;
    return {
      transform: [
        { translateX: look.value * size * 0.05 },
        { scaleY: open * (mode.value === 2 ? 1 : blink.value) },
      ],
    };
  });
  const mouthStyle = useAnimatedStyle(() => ({
    opacity: withTiming(mode.value === 3 ? 1 : 0, { duration: 200 }),
  }));

  const ringColor = PALETTE[STATE_INDEX[state]];
  const box = size * 1.5;
  const ringOuter = size * 1.3;
  const ringInner = size * 1.14;

  return (
    <View
      style={[styles.box, { width: box, height: box }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={STATE_LABEL[state]}
      accessibilityLiveRegion="polite"
      pointerEvents="none"
    >
      <Animated.View style={[styles.abs, circle(size * 1.48), haloOuter]} />
      <Animated.View style={[styles.abs, circle(size * 1.26), haloMid]} />
      <Animated.View style={[styles.abs, circle(size * 1.08), haloInner]} />

      <Animated.View style={[styles.abs, { width: ringOuter, height: ringOuter }, ringAStyle]}>
        <Svg width={ringOuter} height={ringOuter}>
          <Circle
            cx={ringOuter / 2}
            cy={ringOuter / 2}
            r={ringOuter / 2 - 2}
            stroke={ringColor}
            strokeWidth={2}
            strokeDasharray={`${ringOuter * 0.42} ${ringOuter * 0.18}`}
            strokeLinecap="round"
            fill="none"
          />
          <Circle cx={ringOuter / 2} cy={3} r={3.5} fill={ringColor} />
        </Svg>
      </Animated.View>
      <Animated.View style={[styles.abs, { width: ringInner, height: ringInner }, ringBStyle]}>
        <Svg width={ringInner} height={ringInner}>
          <Circle
            cx={ringInner / 2}
            cy={ringInner / 2}
            r={ringInner / 2 - 1.5}
            stroke={ringColor}
            strokeWidth={1.2}
            strokeDasharray={`4 ${ringInner * 0.05}`}
            fill="none"
            opacity={0.8}
          />
        </Svg>
      </Animated.View>

      <Animated.View style={[styles.abs, circle(size), styles.core, coreStyle]}>
        {/* Shading overlay gives the flat colored circle a glassy 3D sphere look. */}
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="shine" cx="35%" cy="28%" r="75%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.75} />
              <Stop offset="0.28" stopColor="#FFFFFF" stopOpacity={0.12} />
              <Stop offset="0.7" stopColor="#05070D" stopOpacity={0.35} />
              <Stop offset="1" stopColor="#05070D" stopOpacity={0.85} />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#shine)" />
        </Svg>

        <View
          style={[
            styles.visor,
            { width: size * 0.64, height: size * 0.3, borderRadius: size * 0.15, marginTop: -size * 0.04 },
          ]}
        >
          <Animated.View style={[styles.eye, eyeDims(size), eyeStyle]} />
          <Animated.View style={[styles.eye, eyeDims(size), eyeStyle]} />
        </View>

        <Animated.View style={[styles.mouth, { marginTop: size * 0.06, gap: size * 0.025, height: size * 0.14 }, mouthStyle]}>
          {[0.55, 0.9, 1, 0.75, 0.5].map((weight, i) => (
            <MouthBar key={i} weight={weight} index={i} pulse={pulse} size={size} />
          ))}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function MouthBar({ weight, index, pulse, size }: { weight: number; index: number; pulse: SharedValue<number>; size: number }) {
  const style = useAnimatedStyle(() => {
    // Phase-shift each bar so the "voice" looks organic rather than uniform.
    const phase = (pulse.value + index * 0.37) % 1;
    const h = interpolate(phase, [0, 0.5, 1], [0.25, 1, 0.25]) * weight;
    return { height: Math.max(3, h * size * 0.12) };
  });
  return <Animated.View style={[styles.bar, { width: Math.max(3, size * 0.03) }, style]} />;
}

const circle = (d: number) => ({ width: d, height: d, borderRadius: d / 2 });
const eyeDims = (size: number) => ({ width: size * 0.1, height: size * 0.13, borderRadius: size * 0.05 });

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
  abs: { position: "absolute" },
  core: { overflow: "hidden", alignItems: "center", justifyContent: "center" },
  visor: {
    backgroundColor: "rgba(3,6,14,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
  },
  eye: {
    backgroundColor: "#E9FBFF",
    shadowColor: "#FFFFFF",
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  mouth: { flexDirection: "row", alignItems: "center" },
  bar: { backgroundColor: "rgba(255,255,255,0.9)", borderRadius: 3 },
});

export const Orb = memo(OrbImpl);

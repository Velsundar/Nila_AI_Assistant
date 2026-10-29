import type { Category } from "@nova/shared";

/** Single source of truth for the app's dark sci-fi look. */
export const Colors = {
  bg: "#05070D",
  bgElevated: "#0A0F1C",
  surface: "#0E1424",
  surfaceAlt: "#141C31",
  border: "#1F2A44",
  borderStrong: "#2C3B5E",
  text: "#E6EDF7",
  textDim: "#8B98B3",
  textFaint: "#5A6684",
  primary: "#38BDF8",
  primaryDim: "#0C4A6E",
  accent: "#A78BFA",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  overlay: "rgba(2, 4, 10, 0.72)",
} as const;

/** Orb palette — each assistant state gets its own clearly distinct hue. */
export const OrbColors = {
  idle: "#38BDF8", // cyan-sky
  listening: "#34D399", // emerald
  thinking: "#A78BFA", // violet
  speaking: "#F472B6", // pink
} as const;

export const Spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const Radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

export const Font = {
  title: { fontSize: 28, fontWeight: "700" as const, letterSpacing: 0.3 },
  h2: { fontSize: 20, fontWeight: "700" as const },
  h3: { fontSize: 16, fontWeight: "600" as const },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
  tiny: { fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase" as const },
};

/** Minimum touch target (Apple HIG / Material). */
export const HitSize = 44;

export const CategoryMeta: Record<Category, { color: string; icon: string }> = {
  Food: { color: "#FB923C", icon: "fast-food-outline" },
  Groceries: { color: "#4ADE80", icon: "cart-outline" },
  Transport: { color: "#60A5FA", icon: "car-outline" },
  Shopping: { color: "#F472B6", icon: "bag-handle-outline" },
  Bills: { color: "#FACC15", icon: "receipt-outline" },
  Rent: { color: "#C084FC", icon: "home-outline" },
  Entertainment: { color: "#F87171", icon: "film-outline" },
  Health: { color: "#2DD4BF", icon: "medkit-outline" },
  Education: { color: "#818CF8", icon: "school-outline" },
  Travel: { color: "#38BDF8", icon: "airplane-outline" },
  Other: { color: "#94A3B8", icon: "ellipsis-horizontal-circle-outline" },
};

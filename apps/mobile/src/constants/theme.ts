import type Ionicons from "@expo/vector-icons/Ionicons";
import type { Category, IncomeCategory } from "@nova/shared";

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

/** Ionicons glyph name, typed so a missing glyph fails typecheck instead of rendering "?". */
type IconName = keyof typeof Ionicons.glyphMap;

export const CategoryMeta: Record<Category, { color: string; icon: IconName }> = {
  Food: { color: "#FB923C", icon: "fast-food-outline" },
  Groceries: { color: "#4ADE80", icon: "cart-outline" },
  Shopping: { color: "#F472B6", icon: "bag-handle-outline" },
  Housing: { color: "#E879F9", icon: "bed-outline" },
  Rent: { color: "#C084FC", icon: "home-outline" },
  Transportation: { color: "#60A5FA", icon: "bus-outline" },
  Vehicle: { color: "#93C5FD", icon: "car-sport-outline" },
  Bills: { color: "#FACC15", icon: "receipt-outline" },
  "Life & Entertainment": { color: "#F87171", icon: "film-outline" },
  Health: { color: "#2DD4BF", icon: "medkit-outline" },
  Education: { color: "#818CF8", icon: "school-outline" },
  Travel: { color: "#38BDF8", icon: "airplane-outline" },
  Investments: { color: "#A3E635", icon: "trending-up-outline" },
  "Savings & Insurance": { color: "#5EEAD4", icon: "shield-checkmark-outline" },
  Other: { color: "#94A3B8", icon: "ellipsis-horizontal-circle-outline" },
};

/** Income reads as money in: every category is a shade of green/teal so it never looks like spending. */
export const IncomeCategoryMeta: Record<IncomeCategory, { color: string; icon: IconName }> = {
  Salary: { color: "#34D399", icon: "briefcase-outline" },
  Business: { color: "#2DD4BF", icon: "storefront-outline" },
  Refund: { color: "#4ADE80", icon: "return-down-back-outline" },
  Gift: { color: "#86EFAC", icon: "gift-outline" },
  Transfer: { color: "#5EEAD4", icon: "swap-horizontal-outline" },
  Interest: { color: "#A3E635", icon: "trending-up-outline" },
  Other: { color: "#6EE7B7", icon: "cash-outline" },
};

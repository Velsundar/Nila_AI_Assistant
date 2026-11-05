/**
 * Category vocabulary shared by the REST routes, the agent tools and the mock brain: legacy-name
 * mapping (v5 renamed Transport and Entertainment), spoken aliases, and the keyword rules that
 * infer a category + subcategory from merchant/note ("swiggy" → Food / Swiggy).
 */
import type { Category } from "@nova/shared";
import { CATEGORIES, LEGACY_CATEGORIES, SUBCATEGORIES } from "@nova/shared";

/** Words people say for a category (lowercase). Exact names and LEGACY_CATEGORIES are matched first. */
export const CATEGORY_ALIASES: Record<string, Category> = {
  grocery: "Groceries",
  transport: "Transportation",
  commute: "Transportation",
  cab: "Transportation",
  travelling: "Travel",
  bill: "Bills",
  utilities: "Bills",
  network: "Bills",
  recharge: "Bills",
  mobile: "Bills",
  medical: "Health",
  fun: "Life & Entertainment",
  entertainment: "Life & Entertainment",
  movie: "Life & Entertainment",
  movies: "Life & Entertainment",
  ott: "Life & Entertainment",
  shop: "Shopping",
  misc: "Other",
  miscellaneous: "Other",
  dining: "Food",
  fuel: "Vehicle",
  petrol: "Vehicle",
  bike: "Vehicle",
  car: "Vehicle",
  investment: "Investments",
  invest: "Investments",
  sip: "Investments",
  insurance: "Savings & Insurance",
  savings: "Savings & Insurance",
  housing: "Housing",
  home: "Housing",
  house: "Housing",
};

const LEGACY_LOWER: Record<string, Category> = Object.fromEntries(Object.entries(LEGACY_CATEGORIES).map(([k, v]) => [k.toLowerCase(), v]));

/** A pre-v5 name ("Transport") → its current name; anything else unchanged. */
export function currentCategory<T>(v: T): T | Category {
  return typeof v === "string" && v in LEGACY_CATEGORIES ? LEGACY_CATEGORIES[v]! : v;
}

/** REST input: map a legacy `category` in a body/query object before Zod validates it. */
export function withCurrentCategory<T>(obj: T): T {
  if (obj && typeof obj === "object" && "category" in obj) return { ...obj, category: currentCategory((obj as { category: unknown }).category) };
  return obj;
}

const spokenKey = (s: string) => s.trim().toLowerCase().replace(/\s+and\s+/g, " & ").replace(/\s+/g, " ");

/** Exact name, legacy name or alias (case-insensitive, "and" = "&"); undefined if none. */
export function lookupCategory(s: string): Category | undefined {
  const k = spokenKey(s);
  return CATEGORIES.find((c) => c.toLowerCase() === k) ?? LEGACY_LOWER[k] ?? CATEGORY_ALIASES[k];
}

// ---------- keyword rules ----------

type Rule = { re: RegExp; category: Category; sub?: string };
const r = (re: RegExp, category: Category, sub?: string): Rule => ({ re, category, sub });

/**
 * Ordered: specific phrases before generic words ("health insurance" before "health", "prime video"
 * before "amazon", "swiggy instamart" before "swiggy"). Tested against lowercase merchant + note.
 */
const RULES: Rule[] = [
  // money set aside (reported as invested, not spent)
  r(/\b(sent|send|gave|give|given|transferred|transfer)\s+(to\s+)?(my\s+)?(dad|father|papa|appa)\b|\bto (my )?(dad|father|papa|appa)\b|^(my )?(dad|father|papa|appa)\b/, "Investments", "Sent to Dad"),
  r(/\b(health insurance|mediclaim|medical insurance)\b/, "Savings & Insurance", "Health insurance"),
  r(/\b(term|life) (insurance|plan|policy)\b|\blic\b/, "Savings & Insurance", "Term insurance"),
  r(/\b(bike|car|vehicle|scooter|scooty|two wheeler|motor) insurance\b/, "Vehicle", "Insurance"),
  r(/\b(sip|mutual funds?|index fund)\b/, "Investments", "Mutual fund / SIP"),
  r(/\b(stocks?|shares|zerodha|groww)\b/, "Investments", "Stocks"),
  r(/\b(fixed deposit|fd|recurring deposit)\b/, "Investments", "Fixed deposit"),
  r(/\b(gold|sgb)\b/, "Investments", "Gold"),
  r(/\bemergency fund\b/, "Savings & Insurance", "Emergency fund"),
  r(/\b(savings|piggy bank)\b/, "Savings & Insurance", "Savings"),
  r(/\binsurance\b/, "Savings & Insurance"),
  // vehicle
  r(/\b(petrol|diesel|fuel|cng)\b/, "Vehicle", "Fuel"),
  r(/\b(bike|car|vehicle|scooter|scooty) (service|servicing|repair|wash)\b|\b(servicing|mechanic)\b/, "Vehicle", "Maintenance"),
  r(/\bparking\b/, "Vehicle", "Parking"),
  r(/\b(toll|fastag)\b/, "Vehicle", "Toll"),
  // entertainment (before bills and shopping: "jio hotstar", "amazon prime")
  r(/\b(netflix|prime video|amazon prime|hotstar|jiocinema|spotify|youtube premium|zee5|sonyliv|ott)\b/, "Life & Entertainment", "OTT"),
  r(/\b(movies?|films?|cinema|theatre|theater|pvr|inox|bookmyshow|book my show)\b/, "Life & Entertainment", "Theatre"),
  r(/\b(concert|event|events)\b/, "Life & Entertainment", "Events"),
  r(/\b(gaming|games?|playstation|steam)\b/, "Life & Entertainment", "Games"),
  r(/\b(outing|party|bowling)\b/, "Life & Entertainment", "Outing"),
  // bills
  r(/\b(jio|airtel|vodafone|bsnl|recharge|network|mobile bill|phone bill|postpaid|prepaid)\b/, "Bills", "Mobile & network"),
  r(/\b(wifi|wi-fi|broadband|internet|fibernet)\b/, "Bills", "Internet"),
  r(/\b(electricity|bescom|power bill|eb bill)\b/, "Bills", "Electricity"),
  r(/\bwater (bill|can)\b/, "Bills", "Water"),
  r(/\b(gas bill|cylinder|lpg)\b/, "Bills", "Gas"),
  // groceries (before food: "swiggy instamart", zepto for groceries)
  r(/\binstamart\b/, "Groceries", "Instamart"),
  r(/\bblinkit\b/, "Groceries", "Blinkit"),
  r(/\b(bigbasket|big basket)\b/, "Groceries", "BigBasket"),
  r(/\b(dmart|d mart|supermarket|jiomart|more supermarket)\b/, "Groceries", "Supermarket"),
  r(/\bzepto\b.*\b(grocer\w*|vegetables|veggies|milk|fruits)\b|\b(grocer\w*|vegetables|veggies|milk|fruits)\b.*\bzepto\b/, "Groceries", "Zepto"),
  // food
  r(/\bswiggy\b/, "Food", "Swiggy"),
  r(/\bzomato\b/, "Food", "Zomato"),
  r(/\bzepto\b/, "Food", "Zepto"),
  r(/\b(local shop|kirana|petty shop|corner shop|bakery)\b/, "Food", "Local shop"),
  r(/\b(tea|chai|coffee|snacks?|juice|starbucks|chai point)\b/, "Food", "Tea & snacks"),
  r(/\b(restaurant|cafe|dining|dine out)\b/, "Food", "Restaurant"),
  r(/\b(lunch|dinner|breakfast|brunch|food|meal|biryani|pizza|burger|dosa|dominos|domino's|mcdonalds|mcdonald's|kfc|eatsure)\b/, "Food"),
  r(/\b(grocery|groceries|vegetables|veggies|milk|fruits)\b/, "Groceries"),
  // shopping
  r(/\bamazon\b/, "Shopping", "Amazon"),
  r(/\bflipkart\b/, "Shopping", "Flipkart"),
  r(/\bmyntra\b/, "Shopping", "Myntra"),
  r(/\bmeesho\b/, "Shopping", "Meesho"),
  r(/\b(clothes|shirts?|t-shirts?|jeans|shoes|dress|saree|kurta|ajio)\b/, "Shopping", "Clothes"),
  r(/\b(electronics|headphones|earphones|charger|laptop|gadgets?)\b/, "Shopping", "Electronics"),
  r(/\b(nykaa|shopping)\b/, "Shopping"),
  // transportation
  r(/\blong distance\b/, "Transportation", "Long distance"),
  r(/\brapido\b/, "Transportation", "Rapido"),
  r(/\b(auto|rickshaw)\b/, "Transportation", "Auto"),
  r(/\bmetro\b/, "Transportation", "Metro"),
  r(/\bbus\b/, "Transportation", "Bus"),
  r(/\b(train|irctc)\b/, "Transportation", "Train"),
  r(/\b(flight|indigo|air india|akasa)\b/, "Transportation", "Flight"),
  r(/\b(uber|ola|cab|taxi)\b/, "Transportation", "Cab"),
  r(/\b(commute|transport|public transport)\b/, "Transportation", "Public transport"),
  // home
  r(/\b(rent|room|house|security) deposit\b/, "Rent", "Deposit"),
  r(/\b(rent|landlord)\b/, "Rent", "House rent"),
  r(/\bmaintenance\b/, "Housing", "Maintenance"),
  r(/\b(repairs?|plumber|electrician|carpenter)\b/, "Housing", "Repairs"),
  r(/\b(furniture|sofa|ikea)\b/, "Housing", "Furniture"),
  r(/\bhousehold\b/, "Housing", "Household"),
  // health, education, travel
  r(/\b(medicines?|pharmacy|apollo|pharmeasy|1mg|tablets)\b/, "Health", "Medicine"),
  r(/\b(doctor|clinic|hospital|dentist|consultation|practo)\b/, "Health", "Doctor"),
  r(/\b(gym|cult|fitness)\b/, "Health", "Gym"),
  r(/\b(health|medical)\b/, "Health"),
  r(/\b(course|udemy|coursera)\b/, "Education", "Course"),
  r(/\b(books?|kindle)\b/, "Education", "Books"),
  r(/\b(fees|tuition|school|college|exam)\b/, "Education", "Fees"),
  r(/\b(hotel|airbnb|oyo|resort)\b/, "Travel", "Hotel"),
  r(/\b(trip|vacation|holiday|makemytrip|goibibo|tour)\b/, "Travel", "Trip"),
  // generic bills last ("electricity bill" matched above)
  r(/\b(bill|bills|dth|emi)\b/, "Bills"),
];

const lower = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

/** Every rule matching the text, in priority order. */
function matchRules(text: string): Rule[] {
  const t = lower(text);
  return t ? RULES.filter((x) => x.re.test(t)) : [];
}

/** Best category guess for free text ("uber to office" → Transportation), or undefined. */
export function categoryFromKeywords(text: string): Category | undefined {
  return matchRules(text)[0]?.category;
}

const MAX_SUB = 40;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Snap free text to the category's listed spelling: case/punctuation-insensitive, plural, one typo,
 * a word of the option ("sip" → "Mutual fund / SIP", "dad" → "Sent to Dad"), or a keyword rule for
 * that category ("petrol" → Fuel, "uber" → Cab). Otherwise the user's own text is kept.
 */
export function snapSubcategory(category: Category, raw: string): string | undefined {
  const text = raw.trim().replace(/\s+/g, " ").slice(0, MAX_SUB);
  if (!text) return undefined;
  const options = SUBCATEGORIES[category] ?? [];
  const k = squash(text);
  const hit =
    options.find((o) => squash(o) === k) ??
    options.find((o) => squash(o) === k.replace(/e?s$/, "") || squash(o).replace(/e?s$/, "") === k) ??
    (k.length >= 5 ? options.find((o) => editDistanceAtMost1(squash(o), k)) : undefined) ??
    (k.length >= 3 && !text.includes(" ") ? options.find((o) => o.toLowerCase().split(/[^a-z0-9]+/).includes(text.toLowerCase())) : undefined) ??
    matchRules(text).find((x) => x.category === category && x.sub)?.sub;
  return hit ?? text;
}

export type Classified = { category: Category; subcategory?: string; note?: string };

/** "Leo movie" / "movie Leo" → "Leo": the subcategory already says it was a film. */
function movieTitle(note: string): string | undefined {
  const m = /^(?:the )?(.+?)\s+(?:movie|film)$/i.exec(note) ?? /^(?:movie|film)\s+(.+)$/i.exec(note);
  if (!m || /^(a|the|some|to|at|for)$/i.test(m[1]!)) return undefined;
  const name = m[1]!.trim();
  return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
}

/**
 * Fill in what the caller left out. The category is inferred only when it is missing or "Other";
 * the subcategory is snapped when given, else inferred from merchant + note for that category.
 */
export function classifyExpense(input: { category?: Category; subcategory?: string; merchant?: string; note?: string }): Classified {
  const merchant = input.merchant?.trim() ?? "";
  const note = input.note?.trim() ?? "";
  const hits = matchRules(`${merchant} ${note}`);
  const category = input.category && input.category !== "Other" ? input.category : (hits[0]?.category ?? "Other");
  let subcategory: string | undefined;
  if (input.subcategory?.trim()) subcategory = snapSubcategory(category, input.subcategory);
  else {
    subcategory = hits.find((h) => h.category === category && h.sub)?.sub;
    // A merchant that is itself a listed subcategory ("Blinkit" under Groceries).
    if (!subcategory && merchant) subcategory = SUBCATEGORIES[category]?.find((o) => squash(o) === squash(merchant));
  }
  const out: Classified = { category, ...(subcategory ? { subcategory } : {}) };
  if (subcategory === "Theatre" && note) {
    const title = movieTitle(note);
    if (title) out.note = title;
  }
  return out;
}

/**
 * Seed a demo account: demo@nova.app / password123 with ~2 months of realistic INR expenses,
 * a few budgets, reminders and memories. Idempotent: wipes and recreates only the demo user's data.
 */
import type { Category } from "@nova/shared";
import { connectDb, disconnectDb } from "./db";
import { config } from "./config";
import { UserModel } from "./models/User";
import { ExpenseModel } from "./models/Expense";
import { BudgetModel } from "./models/Budget";
import { ReminderModel } from "./models/Reminder";
import { MemoryModel } from "./models/Memory";
import { ConversationModel } from "./models/Conversation";
import { hashPassword } from "./services/auth";
import { addDays, localDateString, zonedParts, zonedToUtc, pad } from "./services/dates";

const TZ = "Asia/Kolkata";
const EMAIL = "demo@nova.app";

// Deterministic PRNG so every seed produces the same data.
let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (a: number, b: number, step = 10) => Math.round((a + rand() * (b - a)) / step) * step;
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;

type Row = { amount: number; category: Category; merchant?: string; note?: string; date: Date; source: "voice" | "manual" | "receipt" };

function at(ymd: string, hour: number, minute = between(0, 59, 1)): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, m, d, hour, minute, 0, TZ);
}

function buildExpenses(now: Date): Row[] {
  const p = zonedParts(now, TZ);
  const first = localDateString(zonedToUtc(p.year, p.month - 1, 1, 12, 0, 0, TZ), TZ); // 1st of last month
  const today = localDateString(now, TZ);
  const rows: Row[] = [];
  const src = () => (chance(0.6) ? "voice" : chance(0.85) ? "manual" : "receipt") as Row["source"];
  const push = (r: Omit<Row, "source">) => {
    if (r.date.getTime() <= now.getTime()) rows.push({ ...r, source: src() });
  };

  for (let d = first; d <= today; d = addDays(d, 1)) {
    const [, , day] = d.split("-").map(Number);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    const weekend = wd === 0 || wd === 6;

    if (day === 1) push({ amount: 18000, category: "Rent", merchant: "Landlord", note: "monthly rent", date: at(d, 10) });
    if (day === 3) push({ amount: 649, category: "Entertainment", merchant: "Netflix", note: "subscription", date: at(d, 9) });
    if (day === 5) push({ amount: 299, category: "Bills", merchant: "Jio", note: "mobile recharge", date: at(d, 11) });
    if (day === 8) push({ amount: between(1200, 2200), category: "Bills", merchant: "BESCOM", note: "electricity bill", date: at(d, 19) });
    if (day === 12) push({ amount: 799, category: "Bills", merchant: "Airtel", note: "broadband", date: at(d, 20) });
    if (day === 15 && d.slice(0, 7) === first.slice(0, 7)) push({ amount: 499, category: "Education", merchant: "Udemy", note: "react course", date: at(d, 22) });

    // Daily food
    if (chance(0.85)) push({ amount: between(20, 60, 5), category: "Food", merchant: pick(["Chai Point", "Third Wave Coffee", "Starbucks"]), note: pick(["chai", "coffee"]), date: at(d, 11) });
    if (!weekend && chance(0.7)) push({ amount: between(150, 450), category: "Food", merchant: pick(["Swiggy", "Zomato", "Office canteen"]), note: "lunch", date: at(d, 13) });
    if (chance(0.35)) push({ amount: between(250, 900), category: "Food", merchant: pick(["Swiggy", "Zomato", "Dominos", "Meghana Foods"]), note: "dinner", date: at(d, 21) });

    // Transport on weekdays
    if (!weekend && chance(0.75)) push({ amount: between(60, 350), category: "Transport", merchant: pick(["Uber", "Ola", "Rapido", "Namma Metro"]), note: "commute", date: at(d, 9) });
    if (chance(0.06)) push({ amount: between(1500, 2500, 50), category: "Transport", merchant: "HP Petrol", note: "fuel", date: at(d, 18) });

    // Groceries roughly twice a week
    if (wd === 0 || (wd === 3 && chance(0.6))) push({ amount: between(600, 2400), category: "Groceries", merchant: pick(["Blinkit", "BigBasket", "Zepto", "DMart"]), note: "groceries", date: at(d, 18) });

    if (weekend && chance(0.25)) push({ amount: between(400, 900), category: "Entertainment", merchant: pick(["PVR", "BookMyShow", "INOX"]), note: "movie", date: at(d, 19) });
    if (chance(0.07)) push({ amount: between(499, 3200, 1), category: "Shopping", merchant: pick(["Amazon", "Myntra", "Flipkart", "Decathlon"]), note: pick(["shoes", "t-shirt", "headphones", "kitchen stuff", "books"]), date: at(d, 20) });
    if (chance(0.04)) push({ amount: between(250, 950), category: "Health", merchant: pick(["Apollo Pharmacy", "PharmEasy", "Practo"]), note: pick(["medicines", "doctor visit"]), date: at(d, 17) });
  }

  // One trip last month
  const trip = addDays(first, 17);
  push({ amount: 1845, category: "Travel", merchant: "IRCTC", note: "train to Mysore", date: at(trip, 7) });
  push({ amount: 2600, category: "Travel", merchant: "Airbnb", note: "weekend stay", date: at(trip, 14) });
  return rows;
}

async function main() {
  await connectDb();
  console.log(`[seed] Connected to ${config.mongoUri.replace(/\/\/[^@]*@/, "//***@")}`);
  const existing = await UserModel.findOne({ email: EMAIL });
  if (existing) {
    const userId = existing._id;
    await Promise.all([
      ExpenseModel.deleteMany({ userId }),
      BudgetModel.deleteMany({ userId }),
      ReminderModel.deleteMany({ userId }),
      MemoryModel.deleteMany({ userId }),
      ConversationModel.deleteMany({ userId }),
      UserModel.deleteOne({ _id: userId }),
    ]);
  }

  const user = await UserModel.create({ name: "Demo User", email: EMAIL, passwordHash: await hashPassword("password123") });
  const userId = user._id;
  const now = new Date();

  const rows = buildExpenses(now);
  await ExpenseModel.insertMany(rows.map((r) => ({ ...r, userId })));

  await BudgetModel.insertMany(
    ([
      ["Food", 16000],
      ["Groceries", 15000],
      ["Transport", 4500],
      ["Shopping", 5000],
      ["Entertainment", 2500],
      ["Bills", 4000],
    ] as [Category, number][]).map(([category, monthlyLimit]) => ({ userId, category, monthlyLimit })),
  );

  const p = zonedParts(now, TZ);
  const nextFirst = zonedToUtc(p.year, p.month + 1, 1, 9, 0, 0, TZ);
  const nextEighth = zonedToUtc(p.year, p.month + 1, 8, 18, 0, 0, TZ);
  const tomorrow = addDays(localDateString(now, TZ), 1).split("-").map(Number);
  await ReminderModel.insertMany([
    { userId, text: "Pay rent", dateTime: nextFirst },
    { userId, text: "Pay electricity bill", dateTime: nextEighth },
    { userId, text: "Call mom", dateTime: zonedToUtc(tomorrow[0], tomorrow[1], tomorrow[2], 19, 0, 0, TZ) },
    { userId, text: "Renew bike insurance", dateTime: zonedToUtc(p.year, p.month, 2, 10, 0, 0, TZ), done: true },
  ]);

  await MemoryModel.insertMany([
    { userId, fact: "Salary arrives on the 1st of every month" },
    { userId, fact: "Prefers vegetarian food" },
    { userId, fact: "Commutes to the office in Bengaluru on weekdays" },
  ]);

  const total = rows.reduce((a, r) => a + r.amount, 0);
  console.log(`[seed] Created ${EMAIL} / password123 with ${rows.length} expenses (₹${total.toLocaleString("en-IN")}), 6 budgets, 4 reminders, 3 memories`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error("[seed] failed:", e);
  await disconnectDb().catch(() => {});
  process.exit(1);
});

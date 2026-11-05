import { describe, expect, it } from "vitest";
import { agent, api, registerUser } from "../test/helpers";
import { getLedger, LEDGER_MAX_ENTRIES } from "../services/ledger";
import { getTrends } from "../services/trends";
import { addDays, localDateString, pad, zonedParts, zonedToUtc } from "../services/dates";
import { speakYmd } from "../services/insights";
import { composeReply, planFor } from "../agent/mock";
import { ExpenseModel } from "../models/Expense";
import type { LlmContext } from "../agent/llm";

const TZ = "Asia/Kolkata";
// Thursday 2026-11-05 12:00 IST
const NOW = new Date("2026-11-05T06:30:00Z");

async function seedUser() {
  const u = await registerUser();
  const spend = (amount: number, category: string, date: string, extra: Record<string, unknown> = {}) =>
    api().post("/api/expenses").set(u.auth).send({ amount, category, date, ...extra }).expect(201);
  const earn = (amount: number, category: string, date: string, extra: Record<string, unknown> = {}) =>
    api().post("/api/income").set(u.auth).send({ amount, category, date, ...extra }).expect(201);
  return { ...u, id: u.user.id as string, spend, earn };
}

describe("ledger", () => {
  it("starts at the latest salary, merges oldest first with a running balance, and splits spent / invested", async () => {
    const u = await seedUser();
    await u.spend(500, "Food", "2026-10-30"); // before the salary: excluded
    await u.earn(70000, "Salary", "2026-10-01", { payer: "Acme" }); // older salary
    await u.earn(75000, "Salary", "2026-11-01T09:00:00+05:30", { payer: "Acme" });
    await u.spend(300, "Food", "2026-11-01T08:00:00+05:30", { merchant: "Swiggy" }); // same day, before pay: included
    await u.spend(5000, "Investments", "2026-11-02", { note: "sent to dad" });
    await u.spend(1250, "Savings & Insurance", "2026-11-03", { note: "term insurance" });
    await u.earn(200, "Refund", "2026-11-04", { note: "returned shoes" });
    await u.spend(10.1, "Food", "2026-11-04T18:00:00+05:30", { note: "tea" });
    await u.spend(20.2, "Food", "2026-11-04T19:00:00+05:30", { note: "snacks" });

    const l = await getLedger(u.id, { period: "cycle" }, TZ, NOW);
    expect(l.period).toBe("salary-cycle");
    expect(l.from).toBe("2026-10-31T18:30:00.000Z"); // start of 1 Nov IST
    expect(l.to).toBe(NOW.toISOString());
    expect(l.entries.map((e) => [e.kind, e.label, e.amount, e.balance])).toEqual([
      ["expense", "Swiggy", -300, -300],
      ["income", "Acme", 75000, 74700],
      ["expense", "sent to dad", -5000, 69700],
      ["expense", "term insurance", -1250, 68450],
      ["income", "returned shoes", 200, 68650],
      ["expense", "tea", -10.1, 68639.9],
      ["expense", "snacks", -20.2, 68619.7],
    ]);
    expect(l.entries[0]).toMatchObject({ category: "Food", subcategory: "Swiggy" });
    expect(l.entries[2]).toMatchObject({ category: "Investments", subcategory: "Sent to Dad" });
    expect(l.totals).toEqual({ received: 75200, spent: 330.3, invested: 6250, balance: 68619.7 });
  });

  it("falls back to the calendar month without a recent salary, and serves a chosen month", async () => {
    const u = await seedUser();
    await u.earn(75000, "Salary", "2026-09-15"); // 51 days before NOW
    await u.spend(400, "Food", "2026-10-31T23:00:00+05:30");
    await u.spend(250, "Food", "2026-11-01T00:30:00+05:30");
    await u.earn(1000, "Gift", "2026-11-02");

    const l = await getLedger(u.id, { period: "cycle" }, TZ, NOW);
    expect(l.period).toBe("month");
    expect([l.from, l.to]).toEqual(["2026-10-31T18:30:00.000Z", "2026-11-30T18:29:59.999Z"]);
    expect(l.entries.map((e) => e.balance)).toEqual([-250, 750]);
    expect(l.totals).toEqual({ received: 1000, spent: 250, invested: 0, balance: 750 });

    const oct = await getLedger(u.id, { period: "month", month: "2026-10" }, TZ, NOW);
    expect(oct).toMatchObject({ period: "month", from: "2026-09-30T18:30:00.000Z", totals: { received: 0, spent: 400, invested: 0, balance: -400 } });
  });

  it("caps entries but keeps totals and balances for the whole period", async () => {
    const u = await seedUser();
    const base = zonedToUtc(2026, 11, 2, 0, 0, 0, TZ).getTime();
    await ExpenseModel.insertMany(
      Array.from({ length: LEDGER_MAX_ENTRIES + 5 }, (_, i) => ({ userId: u.id, amount: 1, category: "Food", date: new Date(base + i * 60_000), source: "manual" })),
    );
    const l = await getLedger(u.id, { period: "month", month: "2026-11" }, TZ, NOW);
    expect(l.entries).toHaveLength(LEDGER_MAX_ENTRIES);
    expect(l.entries[l.entries.length - 1]!.balance).toBe(-(LEDGER_MAX_ENTRIES + 5));
    expect(l.totals.spent).toBe(LEDGER_MAX_ENTRIES + 5);
  });

  it("GET /api/ledger validates, isolates users and requires auth", async () => {
    const u = await seedUser();
    const other = await seedUser();
    await other.spend(999, "Food", localDateString(new Date(), TZ));
    const r = await api().get("/api/ledger").set(u.auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ period: "month", entries: [], totals: { received: 0, spent: 0, invested: 0, balance: 0 } });
    expect((await api().get("/api/ledger?period=month&month=2026-10").set(u.auth)).body.period).toBe("month");
    expect((await api().get("/api/ledger?period=month&month=2026-13").set(u.auth)).status).toBe(400);
    expect((await api().get("/api/ledger?period=year").set(u.auth)).status).toBe(400);
    expect((await api().get("/api/ledger")).status).toBe(401);
  });
});

describe("trends", () => {
  async function trendUser() {
    const u = await seedUser();
    // September: nothing. October:
    await u.earn(50000, "Salary", "2026-10-01");
    await u.spend(4000, "Food", "2026-10-10");
    await u.spend(2000, "Shopping", "2026-10-12");
    await u.spend(10000, "Investments", "2026-10-02");
    // November (partial), incl. one just after midnight IST on the 1st (still 31 Oct in UTC):
    await u.earn(50000, "Salary", "2026-11-01");
    await u.spend(100, "Food", "2026-10-31T20:00:00Z");
    await u.spend(5900, "Food", "2026-11-02");
    await u.spend(1000, "Transportation", "2026-11-03");
    return u;
  }

  it("returns every month oldest first with savings, top categories and changes", async () => {
    const u = await trendUser();
    const t = await getTrends(u.id, { months: 3 }, TZ, NOW);
    expect(t.months).toEqual([
      { month: "2026-09", received: 0, spent: 0, invested: 0, saved: 0, savingsRate: null, topCategories: [] },
      {
        month: "2026-10",
        received: 50000,
        spent: 6000,
        invested: 10000,
        saved: 44000,
        savingsRate: 88,
        topCategories: [
          { category: "Food", total: 4000 },
          { category: "Shopping", total: 2000 },
        ],
      },
      {
        month: "2026-11",
        received: 50000,
        spent: 7000,
        invested: 0,
        saved: 43000,
        savingsRate: 86,
        topCategories: [
          { category: "Food", total: 6000 },
          { category: "Transportation", total: 1000 },
        ],
      },
    ]);
    expect(t.spentChangePercent).toBe(16.7);
    expect(t.categoryChanges).toEqual([
      { category: "Food", thisMonth: 6000, lastMonth: 4000, changePercent: 50 },
      { category: "Shopping", thisMonth: 0, lastMonth: 2000, changePercent: -100 },
      { category: "Transportation", thisMonth: 1000, lastMonth: 0, changePercent: null },
    ]);
    // Only October is complete (September is before any activity).
    expect(t.averageMonthlySpent).toBe(6000);

    const six = await getTrends(u.id, { months: 6 }, TZ, NOW);
    expect(six.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(six.averageMonthlySpent).toBe(6000);
  });

  it("handles an empty account and the REST route", async () => {
    const u = await seedUser();
    const t = await getTrends(u.id, {}, TZ, NOW);
    expect(t.months).toHaveLength(6);
    expect(t).toMatchObject({ spentChangePercent: null, categoryChanges: [], averageMonthlySpent: 0 });

    const r = await api().get("/api/insights/trends?months=2").set(u.auth);
    expect(r.status).toBe(200);
    const p = zonedParts(new Date(), TZ);
    expect(r.body.months.map((m: { month: string }) => m.month).at(-1)).toBe(`${p.year}-${pad(p.month)}`);
    expect((await api().get("/api/insights/trends?months=1").set(u.auth)).status).toBe(400);
    expect((await api().get("/api/insights/trends?months=13").set(u.auth)).status).toBe(400);
    expect((await api().get("/api/insights/trends")).status).toBe(401);
  });
});

describe("agent: deleteReminder and getMoneyOverview", () => {
  const today = () => localDateString(new Date(), TZ);
  const at = (ymd: string, h: number) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return zonedToUtc(y!, m!, d!, h, 0, 0, TZ).toISOString();
  };

  it("deletes a reminder by text after a yes, and the next one when none is named", async () => {
    const { auth } = await registerUser();
    await api().post("/api/reminders").set(auth).send({ text: "Call mom", dateTime: at(addDays(today(), 1), 19) }).expect(201);
    await api().post("/api/reminders").set(auth).send({ text: "Pay rent", dateTime: at(addDays(today(), 3), 9) }).expect(201);

    const ask = await agent(auth, "delete the reminder to pay rent");
    expect(ask.actions).toEqual([]);
    expect(ask.pendingConfirmation?.summary).toMatch(/^Delete the reminder to pay rent on \w+day, \d+ \w+ at 9 AM\?$/);
    const no = await agent(auth, "no", ask.conversationId);
    expect(no.actions).toEqual([]);
    expect((await api().get("/api/reminders").set(auth)).body.reminders).toHaveLength(2);

    const ask2 = await agent(auth, "delete my reminder");
    expect(ask2.pendingConfirmation?.summary).toBe("Delete the reminder to call mom tomorrow at 7 PM?");
    const yes = await agent(auth, "yes", ask2.conversationId);
    expect(yes.reply).toBe("Done, I deleted the reminder to call mom.");
    expect(yes.actions[0]).toMatchObject({ tool: "deleteReminder", ok: true });
    const left = (await api().get("/api/reminders").set(auth)).body.reminders;
    expect(left.map((r: { text: string }) => r.text)).toEqual(["Pay rent"]);

    const miss = await agent(auth, "delete the reminder to water plants");
    expect(miss.pendingConfirmation).toBeUndefined();
    expect(miss.reply).toContain('No reminder matches "water plants"');
  });

  it("answers balance, savings and trend questions", async () => {
    const { auth } = await registerUser();
    const empty = await agent(auth, "what's my balance");
    expect(empty.reply).toBe("You haven't logged any money in or out this month.");

    const justNow = new Date(Date.now() - 60_000).toISOString();
    await api().post("/api/income").set(auth).send({ amount: 75000, category: "Salary", payer: "Acme", date: justNow }).expect(201);
    await api().post("/api/expenses").set(auth).send({ amount: 12300, category: "Food", date: justNow }).expect(201);
    await api().post("/api/expenses").set(auth).send({ amount: 5000, category: "Investments", note: "sent to dad", date: justNow }).expect(201);

    const bal = await agent(auth, "what's my balance");
    expect(bal.actions[0]).toMatchObject({ tool: "getMoneyOverview", ok: true, args: { view: "balance" } });
    expect(bal.actions[0]!.result).toMatchObject({ period: "salary-cycle", received: 75000, spent: 12300, invested: 5000, balance: 57700 });
    expect(bal.reply).toBe(
      `You received ₹75,000 and spent ₹12,300 since your salary on ${speakYmd(today())}. ₹5,000 went to investments, so ₹57,700 is left.`,
    );
    expect((await agent(auth, "how much is left")).actions[0]!.args).toEqual({ view: "balance" });

    const save = await agent(auth, "how much did I save");
    expect(save.actions[0]).toMatchObject({ tool: "getMoneyOverview", args: { view: "trends" } });
    expect(save.reply).toBe("This month you've saved ₹62,700 of the ₹75,000 you received, a savings rate of 84%.");

    const trend = await agent(auth, "compare with last month");
    expect(trend.reply).toBe("You've spent ₹12,300 this month.");
    const r = trend.actions[0]!.result as { months: unknown[]; thisMonthTop: unknown[] };
    expect(r.months).toHaveLength(3);
    expect(r.thisMonthTop).toEqual([{ category: "Food", total: 12300 }]);
  });

  it("reports subcategories for one category's summary", async () => {
    const { auth } = await registerUser();
    await agent(auth, "spent 250 on lunch at swiggy");
    await agent(auth, "spent 300 on Leo movie at PVR");
    const e = (await api().get("/api/expenses").set(auth)).body.expenses[0];
    expect(e).toMatchObject({ category: "Life & Entertainment", subcategory: "Theatre", merchant: "Pvr", note: "Leo" });
    const s = await agent(auth, "how much did I spend on food this month");
    expect(s.actions[0]!.result).toMatchObject({ bySubcategory: [{ subcategory: "Swiggy", total: 250, count: 1 }] });
  });
});

describe("mock parser: v5 phrases", () => {
  const ctx: LlmContext = { timezone: TZ, now: new Date("2026-10-30T09:30:00Z"), userName: "Test", assistantName: "Nila", currency: "INR", memories: [] };
  it.each([
    ["delete the reminder to call mom", { tool: "deleteReminder", args: { query: "call mom" } }],
    ["delete my reminder", { tool: "deleteReminder", args: {} }],
    ["cancel my dentist reminder", { tool: "deleteReminder", args: { query: "dentist" } }],
    ["what's my balance", { tool: "getMoneyOverview", args: { view: "balance" } }],
    ["how much is left", { tool: "getMoneyOverview", args: { view: "balance" } }],
    ["how much money do I have left", { tool: "getMoneyOverview", args: { view: "balance" } }],
    ["how much did I save", { tool: "getMoneyOverview", args: { view: "trends" } }],
    ["show my spending trend", { tool: "getMoneyOverview", args: { view: "trends" } }],
    ["compare with last month", { tool: "getMoneyOverview", args: { view: "trends" } }],
    ["how much is left in my food budget", { tool: "getSpendingSummary", args: { category: "Food" } }],
    ["how much did I spend last month", { tool: "getSpendingSummary", args: { from: "2026-09-01", to: "2026-09-30" } }],
    ["spent 300 on Leo movie at PVR", { tool: "addExpense", args: { amount: 300, category: "Life & Entertainment", subcategory: "Theatre", merchant: "Pvr", note: "Leo" } }],
    ["sent 5000 to dad", { tool: "addExpense", args: { amount: 5000, category: "Investments", subcategory: "Sent to Dad", merchant: "Dad" } }],
    ["gave dad 3000", { tool: "addExpense", args: { amount: 3000, category: "Investments", subcategory: "Sent to Dad" } }],
    ["paid 2000 for petrol", { tool: "addExpense", args: { amount: 2000, category: "Vehicle", subcategory: "Fuel", note: "petrol" } }],
    ["recharged jio for 299", { tool: "addExpense", args: { amount: 299, category: "Bills", subcategory: "Mobile & network", merchant: "Jio" } }],
    ["spent 500 at the local shop", { tool: "addExpense", args: { amount: 500, category: "Food", subcategory: "Local shop" } }],
    ["paid 150 for auto", { tool: "addExpense", args: { amount: 150, category: "Transportation", subcategory: "Auto", note: "auto" } }],
    ["paid 649 for netflix", { tool: "addExpense", args: { amount: 649, category: "Life & Entertainment", subcategory: "OTT", merchant: "Netflix" } }],
    ["spent 1250 on term insurance", { tool: "addExpense", args: { amount: 1250, category: "Savings & Insurance", subcategory: "Term insurance", note: "term insurance" } }],
    ["set entertainment budget to 2000", { tool: "setBudget", args: { category: "Life & Entertainment", monthlyLimit: 2000 } }],
    ["how much did I spend on transport", { tool: "getSpendingSummary", args: { category: "Transportation" } }],
  ])("%s", (msg, expected) => {
    expect(planFor(msg, ctx)).toEqual(expected);
  });
});

describe("mock replies: getMoneyOverview", () => {
  const ctx: LlmContext = { timezone: TZ, now: NOW, userName: "Test", assistantName: "Nila", currency: "INR", memories: [] };
  const month = (m: string, received: number, spent: number, savingsRate: number | null) => ({ month: m, received, spent, invested: 0, saved: received - spent, savingsRate });

  it("speaks the month fallback and an overspend", () => {
    expect(composeReply("getMoneyOverview", { period: "month", from: "2026-11-01", received: 20000, spent: 8000, invested: 0, balance: 12000 }, ctx, "")).toBe(
      "This month you received ₹20,000 and spent ₹8,000. So ₹12,000 is left.",
    );
    expect(composeReply("getMoneyOverview", { period: "month", from: "2026-11-01", received: 0, spent: 800, invested: 200, balance: -1000 }, ctx, "")).toBe(
      "You haven't logged any income this month, and you've spent ₹800. ₹200 went to investments, so you're ₹1,000 over what came in.",
    );
  });

  it("speaks the change vs last month and the biggest mover", () => {
    const r = {
      months: [month("2026-10", 50000, 6000, 88), month("2026-11", 50000, 7000, 86)],
      spentChangePercent: 16.7,
      categoryChanges: [{ category: "Food", thisMonth: 6000, lastMonth: 4000, changePercent: 50 }],
      averageMonthlySpent: 6000,
    };
    expect(composeReply("getMoneyOverview", r, ctx, "spending trend")).toBe(
      "You've spent ₹7,000 this month, 17% more than last month's ₹6,000. Your monthly average is ₹6,000. The biggest change is Food: ₹6,000 this month against ₹4,000 last month.",
    );
    expect(composeReply("getMoneyOverview", r, ctx, "how much did I save")).toBe(
      "This month you've saved ₹43,000 of the ₹50,000 you received, a savings rate of 86%. Last month it was 88%.",
    );
  });
});

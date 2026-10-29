import { describe, expect, it } from "vitest";
import { agent, api, registerUser } from "../test/helpers";
import { addDays, localDateString } from "../services/dates";
import { classifyConfirmation } from "../agent/agent";
import { ConversationModel } from "../models/Conversation";

const TZ = "Asia/Kolkata";
const today = () => localDateString(new Date(), TZ);

describe("POST /api/agent (mock provider)", () => {
  it("requires auth and validates input", async () => {
    expect((await api().post("/api/agent").send({ message: "hi" })).status).toBe(401);
    const { auth } = await registerUser();
    const res = await api().post("/api/agent").set(auth).send({ message: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("adds an expense from speech and it shows up in the summary", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "spent 250 on lunch at swiggy");
    expect(r.reply).toBe("Added ₹250 at Swiggy under Food.");
    expect(r.conversationId).toMatch(/^[a-f0-9]{24}$/);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ tool: "addExpense", ok: true, args: { amount: 250, category: "Food", merchant: "Swiggy", note: "lunch" } });

    const list = await api().get("/api/expenses").set(auth);
    expect(list.body.expenses[0]).toMatchObject({ amount: 250, category: "Food", merchant: "Swiggy", source: "voice" });
    const s = await api().get("/api/expenses/summary").set(auth);
    expect(s.body.total).toBe(250);
  });

  it("resolves 'yesterday' in the user's timezone", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "paid 1200 for uber yesterday");
    expect(r.actions[0].args).toMatchObject({ amount: 1200, category: "Transport", merchant: "Uber", date: addDays(today(), -1) });
    const e = (await api().get("/api/expenses").set(auth)).body.expenses[0];
    expect(localDateString(new Date(e.date), TZ)).toBe(addDays(today(), -1));
    expect(r.reply).toContain("yesterday");
  });

  it("answers totals from aggregation and warns about budgets", async () => {
    const { auth } = await registerUser();
    const b = await agent(auth, "set food budget to 5000");
    expect(b.actions[0]).toMatchObject({ tool: "setBudget", ok: true, args: { category: "Food", monthlyLimit: 5000 } });
    await agent(auth, "spent 2000 on groceries at bigbasket");
    await agent(auth, "spent 3800 on dinner at zomato");
    const warn = await agent(auth, "spent 300 on lunch");
    expect(warn.actions[0].result).toMatchObject({ budget: { category: "Food", spent: 4100, percentUsed: 82 } });
    expect(warn.reply).toContain("82% of your Food budget");

    const q = await agent(auth, "how much did I spend on food this month?");
    expect(q.actions[0]).toMatchObject({ tool: "getSpendingSummary", args: { category: "Food" } });
    expect(q.reply).toContain("₹4,100 on Food this month");

    const all = await agent(auth, "what's my total spending this month");
    expect(all.reply).toContain("₹6,100");

    const budgets = await agent(auth, "what are my budgets");
    expect(budgets.actions[0].tool).toBe("getBudgets");
    expect(budgets.reply).toContain("Food ₹4,100 of ₹5,000");
  });

  it("requires confirmation before deleting, and executes on yes", async () => {
    const { auth } = await registerUser();
    await agent(auth, "spent 100 on tea");
    const add = await agent(auth, "spent 250 on lunch at swiggy");
    const first = await agent(auth, "delete my last expense");
    expect(first.actions).toEqual([]);
    expect(first.pendingConfirmation?.summary).toBe("Delete ₹250 at Swiggy from today?");
    expect(first.reply).toBe("Delete ₹250 at Swiggy from today? Say yes or no.");
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toHaveLength(2); // not deleted yet

    const yes = await agent(auth, "Haan", first.conversationId);
    expect(yes.pendingConfirmation).toBeUndefined();
    expect(yes.actions).toHaveLength(1);
    expect(yes.actions[0]).toMatchObject({ tool: "deleteExpense", ok: true, args: { expenseId: add.actions[0].result && (add.actions[0].result as { expense: { id: string } }).expense.id } });
    expect(yes.reply).toBe("Done, I deleted ₹250 at Swiggy.");
    const left = (await api().get("/api/expenses").set(auth)).body.expenses;
    expect(left).toHaveLength(1);
    expect(left[0].amount).toBe(100);

    // pending action is cleared: another "yes" does nothing destructive
    const again = await agent(auth, "yes", first.conversationId);
    expect(again.actions).toEqual([]);
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toHaveLength(1);
  });

  it("cancels on no, and treats an unrelated reply as a new message", async () => {
    const { auth } = await registerUser();
    await agent(auth, "spent 250 on lunch at swiggy");
    const p = await agent(auth, "delete my last expense");
    const no = await agent(auth, "no", p.conversationId);
    expect(no.reply).toBe("Okay, I've cancelled that.");
    expect(no.actions).toEqual([]);
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toHaveLength(1);

    const p2 = await agent(auth, "delete the swiggy expense", p.conversationId);
    expect(p2.pendingConfirmation).toBeDefined();
    const other = await agent(auth, "spent 40 on chai", p.conversationId);
    expect(other.actions[0]).toMatchObject({ tool: "addExpense", ok: true });
    expect(other.pendingConfirmation).toBeUndefined();
    const conv = await ConversationModel.findById(p.conversationId).lean();
    expect(conv?.pendingAction ?? null).toBeNull();
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toHaveLength(2);
  });

  it("updateExpense also requires confirmation", async () => {
    const { auth } = await registerUser();
    await agent(auth, "spent 250 on lunch at swiggy");
    const p = await agent(auth, "change my last expense to 300");
    expect(p.pendingConfirmation?.summary).toBe("Change ₹250 at Swiggy from today, setting the amount to ₹300?");
    expect((await api().get("/api/expenses").set(auth)).body.expenses[0].amount).toBe(250);
    const yes = await agent(auth, "yes do it", p.conversationId);
    expect(yes.actions[0]).toMatchObject({ tool: "updateExpense", ok: true });
    expect((await api().get("/api/expenses").set(auth)).body.expenses[0].amount).toBe(300);
  });

  it("deleting with nothing to delete reports gracefully", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "delete my last expense");
    expect(r.pendingConfirmation).toBeUndefined();
    expect(r.reply).toMatch(/no expenses/i);
  });

  it("creates and lists reminders", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "remind me to pay rent on the 5th");
    expect(r.actions[0]).toMatchObject({ tool: "createReminder", ok: true, args: { text: "pay rent" } });
    const reminder = (r.actions[0].result as { reminder: { dateTime: string } }).reminder;
    const local = localDateString(new Date(reminder.dateTime), TZ);
    expect(local.endsWith("-05")).toBe(true);
    expect(new Date(reminder.dateTime).getTime()).toBeGreaterThan(Date.now());
    expect(r.reply).toMatch(/^Okay, I'll remind you to pay rent/);

    const list = await agent(auth, "what are my reminders");
    expect(list.actions[0].tool).toBe("listReminders");
    expect(list.reply).toContain("pay rent");
    expect((await api().get("/api/reminders").set(auth)).body.reminders).toHaveLength(1);
  });

  it("remembers facts and keeps conversation history capped", async () => {
    const { auth } = await registerUser("Meera");
    const r = await agent(auth, "remember that my salary comes on the 1st");
    expect(r.actions[0]).toMatchObject({ tool: "manageMemory", ok: true, args: { action: "save", fact: "my salary comes on the 1st" } });
    const recall = await agent(auth, "what do you know about me", r.conversationId);
    expect(recall.reply).toContain("my salary comes on the 1st");
    expect(recall.conversationId).toBe(r.conversationId);

    for (let i = 0; i < 12; i++) await agent(auth, "hi", r.conversationId);
    const conv = await ConversationModel.findById(r.conversationId).lean();
    expect(conv!.messages.length).toBeLessThanOrEqual(20);
  });

  it("uses the user's assistantName and gives speakable replies", async () => {
    const { auth } = await registerUser("Kiran");
    await api().patch("/api/auth/me").set(auth).send({ assistantName: "Jarvis" });
    const r = await agent(auth, "hello");
    expect(r.reply).toContain("Jarvis");
    expect(r.reply).not.toMatch(/[*#`]|\p{Extended_Pictographic}/u);
    const unknown = await agent(auth, "blorp");
    expect(unknown.actions).toEqual([]);
    expect(unknown.reply).toMatch(/didn't catch/);
  });
});

describe("classifyConfirmation", () => {
  it.each(["yes", "Yeah!", "haan", "confirm", "do it", "yes please", "ok", "go ahead"])("%s → yes", (m) => {
    expect(classifyConfirmation(m)).toBe("yes");
  });
  it.each(["no", "nope", "nahi", "cancel", "don't", "never mind"])("%s → no", (m) => {
    expect(classifyConfirmation(m)).toBe("no");
  });
  it.each(["spent 40 on chai", "what's my budget", "yesterday"])("%s → other", (m) => {
    expect(classifyConfirmation(m)).toBe("other");
  });
});

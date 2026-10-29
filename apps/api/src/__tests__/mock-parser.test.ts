import { describe, expect, it } from "vitest";
import { parseAmount, planFor, parseReminder } from "../agent/mock";
import type { LlmContext } from "../agent/llm";

// Fixed "now": Friday 2026-10-30 15:00 IST
const ctx: LlmContext = {
  timezone: "Asia/Kolkata",
  now: new Date("2026-10-30T09:30:00Z"),
  userName: "Test",
  assistantName: "Nova",
  currency: "INR",
  memories: [],
};
const plan = (m: string) => planFor(m, ctx);

describe("mock parser", () => {
  it("parses amounts", () => {
    expect(parseAmount("spent ₹1,200 today")).toBe(1200);
    expect(parseAmount("paid rs. 99.5")).toBe(99.5);
    expect(parseAmount("2k on shoes")).toBe(2000);
    expect(parseAmount("remind me on the 5th at 6pm")).toBeUndefined();
  });

  it.each([
    ["spent 250 on lunch at swiggy", { tool: "addExpense", args: { amount: 250, category: "Food", merchant: "Swiggy", note: "lunch" } }],
    ["paid 1200 for uber yesterday", { tool: "addExpense", args: { amount: 1200, category: "Transport", merchant: "Uber", date: "2026-10-29" } }],
    ["spent 499 at amazon", { tool: "addExpense", args: { amount: 499, category: "Shopping", merchant: "Amazon" } }],
    ["paid 15000 rent", { tool: "addExpense", args: { amount: 15000, category: "Rent" } }],
    ["spent 600 on medicines 2 days ago", { tool: "addExpense", args: { amount: 600, category: "Health", note: "medicines", date: "2026-10-28" } }],
    ["how much did I spend on food this month", { tool: "getSpendingSummary", args: { category: "Food" } }],
    ["how much did i spend last month", { tool: "getSpendingSummary", args: { from: "2026-09-01", to: "2026-09-30" } }],
    ["how much did I spend today", { tool: "getSpendingSummary", args: { from: "2026-10-30", to: "2026-10-30" } }],
    ["set food budget to 5000", { tool: "setBudget", args: { category: "Food", monthlyLimit: 5000 } }],
    ["set my transport budget at 3k", { tool: "setBudget", args: { category: "Transport", monthlyLimit: 3000 } }],
    ["what are my budgets", { tool: "getBudgets", args: {} }],
    ["delete my last expense", { tool: "deleteExpense", args: {} }],
    ["remove the swiggy expense", { tool: "deleteExpense", args: { match: { merchant: "swiggy" } } }],
    ["change my last expense to 300", { tool: "updateExpense", args: { amount: 300 } }],
    ["remind me to pay rent on the 5th", { tool: "createReminder", args: { text: "pay rent", dateTime: "2026-11-05T09:00" } }],
    ["show my recent expenses", { tool: "listRecentExpenses", args: { limit: 5 } }],
    ["remember that I am vegetarian", { tool: "manageMemory", args: { action: "save", fact: "i am vegetarian" } }],
  ])("%s", (msg, expected) => {
    expect(plan(msg)).toEqual(expected);
  });

  it("parses reminder times", () => {
    expect(parseReminder("remind me to call mom tomorrow at 6pm", ctx)).toEqual({ text: "call mom", dateTime: "2026-10-31T18:00" });
    expect(parseReminder("remind me to drink water in 2 hours", ctx)).toEqual({ text: "drink water", dateTime: "2026-10-30T17:00" });
    expect(parseReminder("remind me to pay electricity bill on monday", ctx)).toEqual({ text: "pay electricity bill", dateTime: "2026-11-02T09:00" });
    expect(parseReminder("remind me to renew insurance on the 30th", ctx).dateTime).toBe("2026-11-30T09:00");
  });

  it("asks for missing info instead of guessing", () => {
    expect(plan("I spent on lunch")).toEqual({ reply: "How much was it?" });
  });
});

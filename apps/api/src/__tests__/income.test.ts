import { describe, expect, it } from "vitest";
import { IncomeSchema } from "@nova/shared";
import { agent, api, registerUser } from "../test/helpers";
import { buildSystemPrompt } from "../agent/prompt";
import { TOOL_DEFINITIONS } from "../agent/tools";

describe("income", () => {
  it("creates, lists, updates and deletes, scoped to the user", async () => {
    const { auth } = await registerUser();
    const a = await api().post("/api/income").set(auth).send({ amount: 75000, category: "Salary", payer: "Acme", date: "2026-01-01" });
    expect(a.status).toBe(201);
    expect(IncomeSchema.parse(a.body.income)).toBeTruthy();
    const b = await api().post("/api/income").set(auth).send({ amount: 500, payer: "Ravi", date: "2026-01-03" });
    expect(b.body.income.category).toBe("Other");

    const list = await api().get("/api/income").set(auth);
    expect(list.body.income.map((i: { amount: number }) => i.amount)).toEqual([500, 75000]);
    expect(JSON.stringify(list.body)).not.toMatch(/"_id"|__v|userId/);

    const upd = await api().patch(`/api/income/${b.body.income.id}`).set(auth).send({ note: "lunch split" });
    expect(upd.body.income).toMatchObject({ amount: 500, category: "Other", note: "lunch split" });

    const other = await registerUser();
    expect((await api().delete(`/api/income/${a.body.income.id}`).set(other.auth)).status).toBe(404);
    expect((await api().delete(`/api/income/${a.body.income.id}`).set(auth)).status).toBe(204);
    expect((await api().get("/api/income").set(auth)).body.income).toHaveLength(1);
    expect((await api().post("/api/income").set(auth).send({ amount: -5 })).status).toBe(400);
  });

  it("summarises income without touching spending totals", async () => {
    const { auth } = await registerUser();
    await api().post("/api/income").set(auth).send({ amount: 75000, category: "Salary" });
    await api().post("/api/income").set(auth).send({ amount: 250, category: "Refund" });
    await api().post("/api/expenses").set(auth).send({ amount: 100, category: "Food" });

    const inc = await api().get("/api/income/summary").set(auth);
    expect(inc.body).toMatchObject({ total: 75250, count: 2 });
    expect(inc.body.byCategory[0]).toEqual({ category: "Salary", total: 75000, count: 1 });
    const spent = await api().get("/api/expenses/summary").set(auth);
    expect(spent.body.total).toBe(100);
  });
});

describe("agent: money received is income, not spending", () => {
  it.each([
    ["received 75000 salary credit", { amount: 75000, category: "Salary" }],
    ["75k incoming salary credited", { amount: 75000, category: "Salary" }],
    ["Ravi gave me 500", { amount: 500, payer: "Ravi" }],
    ["got a refund of 299 from amazon", { amount: 299, category: "Refund", payer: "Amazon" }],
  ])("%j → manageIncome add", async (message, args) => {
    const { auth } = await registerUser();
    const r = await agent(auth, message);
    expect(r.actions[0]).toMatchObject({ tool: "manageIncome", ok: true, args: { action: "add", ...args } });
    expect(r.reply).toMatch(/received/);
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toHaveLength(0);
  });

  it("still treats spending as spending", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "I gave the plumber 500");
    expect(r.actions[0].tool).toBe("addExpense");
  });

  it("answers how much was received", async () => {
    const { auth } = await registerUser();
    await agent(auth, "received 75000 salary");
    const r = await agent(auth, "how much did I receive this month?");
    expect(r.actions[0]).toMatchObject({ tool: "manageIncome", args: { action: "summary" } });
    expect(r.reply).toBe("You've received ₹75,000 this month, across 1 payment.");
  });

  it("deletes income only after a yes", async () => {
    const { auth } = await registerUser();
    await agent(auth, "received 500 from Ravi");
    const ask = await agent(auth, "delete that income");
    expect(ask.pendingConfirmation?.summary).toMatch(/^Delete ₹500 from Ravi/);
    expect((await api().get("/api/income").set(auth)).body.income).toHaveLength(1);
    const yes = await agent(auth, "yes", ask.conversationId);
    expect(yes.reply).toBe("Done, I deleted ₹500 of income.");
    expect((await api().get("/api/income").set(auth)).body.income).toHaveLength(0);
  });

  it("tells the LLM about income and keeps its tool schema small", () => {
    const p = buildSystemPrompt({ assistantName: "Nila", userName: "A", currency: "INR", timezone: "Asia/Kolkata", now: new Date(), memories: [] });
    expect(p).toMatch(/manageIncome add, never addExpense/);
    const def = TOOL_DEFINITIONS.find((d) => d.function.name === "manageIncome")!;
    const props = (def.function.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.incomeId).toBeUndefined();
    expect(JSON.stringify(def).length).toBeLessThan(650);
  });
});

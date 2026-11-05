import { describe, expect, it } from "vitest";
import { ExpenseSchema } from "@nova/shared";
import { api, registerUser } from "../test/helpers";
import { localDateString } from "../services/dates";

const today = () => localDateString(new Date(), "Asia/Kolkata");

describe("expenses", () => {
  it("creates, lists newest first, updates and deletes", async () => {
    const { auth } = await registerUser();
    const a = await api().post("/api/expenses").set(auth).send({ amount: 100, category: "Food", merchant: "Cafe", date: "2026-01-10" });
    expect(a.status).toBe(201);
    expect(ExpenseSchema.parse(a.body.expense)).toBeTruthy();
    expect(a.body.expense.source).toBe("manual");
    // Pre-v5 names are still accepted on input.
    const b = await api().post("/api/expenses").set(auth).send({ amount: 200, category: "Transport", date: "2026-01-12" });
    expect(b.status).toBe(201);
    expect(b.body.expense.category).toBe("Transportation");

    const list = await api().get("/api/expenses").set(auth);
    expect(list.status).toBe(200);
    expect(list.body.expenses.map((e: { amount: number }) => e.amount)).toEqual([200, 100]);
    expect(JSON.stringify(list.body)).not.toMatch(/"_id"|__v|userId/);

    const filtered = await api().get("/api/expenses?category=Food&from=2026-01-01&to=2026-01-10").set(auth);
    expect(filtered.body.expenses).toHaveLength(1);

    const upd = await api().patch(`/api/expenses/${a.body.expense.id}`).set(auth).send({ amount: 150, merchant: "" });
    expect(upd.status).toBe(200);
    expect(upd.body.expense.amount).toBe(150);
    expect(upd.body.expense.merchant).toBeUndefined();

    const del = await api().delete(`/api/expenses/${a.body.expense.id}`).set(auth);
    expect(del.status).toBe(204);
    expect((await api().delete(`/api/expenses/${a.body.expense.id}`).set(auth)).status).toBe(404);
    expect((await api().patch(`/api/expenses/not-an-id`).set(auth).send({ amount: 1 })).status).toBe(404);
  });

  it("validates input", async () => {
    const { auth } = await registerUser();
    const res = await api().post("/api/expenses").set(auth).send({ amount: -5, category: "Nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect((await api().get("/api/expenses?limit=0").set(auth)).status).toBe(400);
  });

  it("summary aggregates the current month by default, by category and by day", async () => {
    const { auth } = await registerUser();
    const t = today();
    await api().post("/api/expenses").set(auth).send({ amount: 250, category: "Food", date: t });
    await api().post("/api/expenses").set(auth).send({ amount: 100.5, category: "Food", date: t });
    await api().post("/api/expenses").set(auth).send({ amount: 1200, category: "Transportation", date: t });
    await api().post("/api/expenses").set(auth).send({ amount: 999, category: "Food", date: "2020-01-01" }); // outside

    const s = await api().get("/api/expenses/summary").set(auth);
    expect(s.status).toBe(200);
    expect(s.body.total).toBe(1550.5);
    expect(s.body.count).toBe(3);
    expect(s.body.byCategory).toEqual([
      { category: "Transportation", total: 1200, count: 1 },
      { category: "Food", total: 350.5, count: 2 },
    ]);
    expect(s.body.byDay).toEqual([{ date: t, total: 1550.5 }]);
    expect(s.body.bySubcategory).toBeUndefined();
    expect(Date.parse(s.body.from)).toBeLessThan(Date.parse(s.body.to));

    const old = await api().get("/api/expenses/summary?from=2020-01-01&to=2020-01-31").set(auth);
    expect(old.body.total).toBe(999);
    expect(old.body.byDay).toEqual([{ date: "2020-01-01", total: 999 }]);
  });
});

describe("data isolation between users", () => {
  it("a user can never read or modify another user's data", async () => {
    const alice = await registerUser("Alice");
    const bob = await registerUser("Bob");

    const exp = (await api().post("/api/expenses").set(alice.auth).send({ amount: 500, category: "Food" })).body.expense;
    await api().put("/api/budgets").set(alice.auth).send({ category: "Food", monthlyLimit: 1000 });
    const rem = (await api().post("/api/reminders").set(alice.auth).send({ text: "secret", dateTime: "2030-01-01T10:00:00Z" })).body.reminder;

    // Bob sees nothing
    expect((await api().get("/api/expenses").set(bob.auth)).body.expenses).toEqual([]);
    expect((await api().get("/api/expenses/summary").set(bob.auth)).body.total).toBe(0);
    expect((await api().get("/api/budgets").set(bob.auth)).body.budgets).toEqual([]);
    expect((await api().get("/api/reminders").set(bob.auth)).body.reminders).toEqual([]);

    // Bob cannot touch Alice's records
    expect((await api().get(`/api/expenses/${exp.id}`).set(bob.auth)).status).toBe(404);
    expect((await api().patch(`/api/expenses/${exp.id}`).set(bob.auth).send({ amount: 1 })).status).toBe(404);
    expect((await api().delete(`/api/expenses/${exp.id}`).set(bob.auth)).status).toBe(404);
    expect((await api().patch(`/api/reminders/${rem.id}`).set(bob.auth).send({ done: true })).status).toBe(404);
    expect((await api().delete(`/api/reminders/${rem.id}`).set(bob.auth)).status).toBe(404);
    expect((await api().delete(`/api/budgets/Food`).set(bob.auth)).status).toBe(404);

    // Bob's agent can't delete Alice's expense either (no expenses of his own)
    const r = await api().post("/api/agent").set(bob.auth).send({ message: "delete my last expense" });
    expect(r.body.pendingConfirmation).toBeUndefined();
    const r2 = await api().post("/api/agent").set(bob.auth).send({ message: "how much did I spend this month" });
    expect(r2.body.actions[0].result.total).toBe(0);
    // Bob can't hijack Alice's conversation
    const aliceConv = (await api().post("/api/agent").set(alice.auth).send({ message: "hi" })).body.conversationId;
    const hijack = await api().post("/api/agent").set(bob.auth).send({ message: "hi", conversationId: aliceConv });
    expect(hijack.body.conversationId).not.toBe(aliceConv);

    // Alice's data is intact
    expect((await api().get(`/api/expenses/${exp.id}`).set(alice.auth)).body.expense.amount).toBe(500);
    expect((await api().get("/api/reminders").set(alice.auth)).body.reminders[0].done).toBe(false);
    expect((await api().get("/api/budgets").set(alice.auth)).body.budgets[0].spent).toBe(500);
  });
});

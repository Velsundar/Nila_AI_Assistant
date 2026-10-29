import { describe, expect, it } from "vitest";
import { api, registerUser } from "../test/helpers";

describe("budgets", () => {
  it("upserts, computes spent/percentUsed for this month, deletes", async () => {
    const { auth } = await registerUser();
    await api().post("/api/expenses").set(auth).send({ amount: 4100, category: "Food" });
    await api().post("/api/expenses").set(auth).send({ amount: 900, category: "Food", date: "2020-05-01" }); // other month
    const put = await api().put("/api/budgets").set(auth).send({ category: "Food", monthlyLimit: 5000 });
    expect(put.status).toBe(200);
    expect(put.body.budget).toEqual({ category: "Food", monthlyLimit: 5000, spent: 4100, percentUsed: 82 });

    const again = await api().put("/api/budgets").set(auth).send({ category: "Food", monthlyLimit: 2000 });
    expect(again.body.budget.percentUsed).toBe(205);
    await api().put("/api/budgets").set(auth).send({ category: "Travel", monthlyLimit: 10000 });

    const list = await api().get("/api/budgets").set(auth);
    expect(list.body.budgets).toHaveLength(2);
    expect(list.body.budgets.find((b: { category: string }) => b.category === "Travel")).toMatchObject({ spent: 0, percentUsed: 0 });

    expect((await api().put("/api/budgets").set(auth).send({ category: "Food", monthlyLimit: 0 })).status).toBe(400);
    expect((await api().delete("/api/budgets/Food").set(auth)).status).toBe(204);
    expect((await api().delete("/api/budgets/Food").set(auth)).status).toBe(404);
    expect((await api().delete("/api/budgets/Bogus").set(auth)).status).toBe(404);
  });
});

describe("reminders", () => {
  it("creates, lists upcoming first, marks done, deletes", async () => {
    const { auth } = await registerUser();
    const later = await api().post("/api/reminders").set(auth).send({ text: "later", dateTime: "2030-02-01T10:00:00Z" });
    expect(later.status).toBe(201);
    const soon = await api().post("/api/reminders").set(auth).send({ text: "soon", dateTime: "2030-01-01T10:00:00Z" });
    expect(soon.body.reminder).toMatchObject({ text: "soon", done: false, dateTime: "2030-01-01T10:00:00.000Z" });

    let list = await api().get("/api/reminders").set(auth);
    expect(list.body.reminders.map((r: { text: string }) => r.text)).toEqual(["soon", "later"]);

    const done = await api().patch(`/api/reminders/${soon.body.reminder.id}`).set(auth).send({ done: true });
    expect(done.status).toBe(200);
    expect(done.body.reminder.done).toBe(true);
    list = await api().get("/api/reminders").set(auth);
    expect(list.body.reminders.map((r: { text: string }) => r.text)).toEqual(["later", "soon"]);

    expect((await api().patch(`/api/reminders/${soon.body.reminder.id}`).set(auth).send({ done: "yes" })).status).toBe(400);
    expect((await api().delete(`/api/reminders/${later.body.reminder.id}`).set(auth)).status).toBe(204);
    expect((await api().post("/api/reminders").set(auth).send({ text: "", dateTime: "x" })).status).toBe(400);
  });
});

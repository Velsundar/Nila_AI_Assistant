import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { api, registerUser } from "../test/helpers";
import { classifyExpense, lookupCategory, snapSubcategory } from "../services/categories";
import { migrateLegacyCategories } from "../services/migrations";
import { normalizeCategory } from "../agent/tools";
import { ExpenseModel } from "../models/Expense";
import { BudgetModel } from "../models/Budget";

describe("category vocabulary", () => {
  it("maps names, legacy names and spoken aliases", () => {
    expect(lookupCategory("life and entertainment")).toBe("Life & Entertainment");
    expect(lookupCategory("Transport")).toBe("Transportation");
    expect(lookupCategory("entertainment")).toBe("Life & Entertainment");
    expect(lookupCategory("petrol")).toBe("Vehicle");
    expect(lookupCategory("sip")).toBe("Investments");
    expect(lookupCategory("insurance")).toBe("Savings & Insurance");
    expect(lookupCategory("home")).toBe("Housing");
    expect(lookupCategory("recharge")).toBe("Bills");
    expect(normalizeCategory("ott")).toBe("Life & Entertainment");
    expect(normalizeCategory("Uber ride")).toBe("Transportation"); // keyword fallback
    expect(normalizeCategory("Nope")).toBe("Nope"); // still fails validation
  });

  it.each([
    [{ merchant: "Swiggy" }, { category: "Food", subcategory: "Swiggy" }],
    [{ merchant: "Zomato", note: "dinner" }, { category: "Food", subcategory: "Zomato" }],
    [{ merchant: "Zepto" }, { category: "Food", subcategory: "Zepto" }],
    [{ merchant: "Zepto", note: "groceries" }, { category: "Groceries", subcategory: "Zepto" }],
    [{ note: "kirana" }, { category: "Food", subcategory: "Local shop" }],
    [{ note: "local shop" }, { category: "Food", subcategory: "Local shop" }],
    [{ merchant: "Meesho" }, { category: "Shopping", subcategory: "Meesho" }],
    [{ merchant: "Rapido" }, { category: "Transportation", subcategory: "Rapido" }],
    [{ note: "auto to office" }, { category: "Transportation", subcategory: "Auto" }],
    [{ merchant: "Namma Metro" }, { category: "Transportation", subcategory: "Metro" }],
    [{ note: "long distance bus" }, { category: "Transportation", subcategory: "Long distance" }],
    [{ merchant: "Uber" }, { category: "Transportation", subcategory: "Cab" }],
    [{ note: "flight to Delhi" }, { category: "Transportation", subcategory: "Flight" }],
    [{ note: "petrol" }, { category: "Vehicle", subcategory: "Fuel" }],
    [{ note: "bike insurance" }, { category: "Vehicle", subcategory: "Insurance" }],
    [{ note: "bike service" }, { category: "Vehicle", subcategory: "Maintenance" }],
    [{ merchant: "Jio", note: "recharge" }, { category: "Bills", subcategory: "Mobile & network" }],
    [{ merchant: "Airtel" }, { category: "Bills", subcategory: "Mobile & network" }],
    [{ merchant: "Netflix" }, { category: "Life & Entertainment", subcategory: "OTT" }],
    [{ merchant: "Amazon", note: "prime video" }, { category: "Life & Entertainment", subcategory: "OTT" }],
    [{ merchant: "BookMyShow" }, { category: "Life & Entertainment", subcategory: "Theatre" }],
    [{ note: "sent to dad" }, { category: "Investments", subcategory: "Sent to Dad" }],
    [{ note: "gave dad" }, { category: "Investments", subcategory: "Sent to Dad" }],
    [{ merchant: "Dad" }, { category: "Investments", subcategory: "Sent to Dad" }],
    [{ note: "health insurance premium" }, { category: "Savings & Insurance", subcategory: "Health insurance" }],
    [{ note: "term insurance" }, { category: "Savings & Insurance", subcategory: "Term insurance" }],
    [{ note: "something odd" }, { category: "Other" }],
  ])("infers %o", (input, expected) => {
    expect(classifyExpense(input)).toEqual(expected);
  });

  it("keeps the movie name as the note", () => {
    expect(classifyExpense({ merchant: "PVR", note: "Leo movie" })).toEqual({ category: "Life & Entertainment", subcategory: "Theatre", note: "Leo" });
    expect(classifyExpense({ merchant: "pvr", note: "leo movie" }).note).toBe("Leo");
    expect(classifyExpense({ merchant: "INOX", note: "movie Jailer" }).note).toBe("Jailer");
    expect(classifyExpense({ merchant: "PVR", note: "popcorn" }).note).toBeUndefined();
  });

  it("only infers the category when it's missing or Other, and the subcategory within it", () => {
    expect(classifyExpense({ category: "Other", merchant: "Swiggy" })).toEqual({ category: "Food", subcategory: "Swiggy" });
    expect(classifyExpense({ category: "Groceries", merchant: "Zepto" })).toEqual({ category: "Groceries", subcategory: "Zepto" });
    expect(classifyExpense({ category: "Groceries", merchant: "Blinkit" })).toEqual({ category: "Groceries", subcategory: "Blinkit" });
    expect(classifyExpense({ category: "Health", merchant: "Swiggy" })).toEqual({ category: "Health" });
  });

  it("snaps near-matches to the listed spelling", () => {
    expect(snapSubcategory("Life & Entertainment", "ott")).toBe("OTT");
    expect(snapSubcategory("Life & Entertainment", "theater")).toBe("Theatre");
    expect(snapSubcategory("Food", "SWIGGY")).toBe("Swiggy");
    expect(snapSubcategory("Food", "local-shop")).toBe("Local shop");
    expect(snapSubcategory("Food", "Restaurants")).toBe("Restaurant");
    expect(snapSubcategory("Bills", "electrcity")).toBe("Electricity"); // one typo
    expect(snapSubcategory("Investments", "sip")).toBe("Mutual fund / SIP");
    expect(snapSubcategory("Investments", "dad")).toBe("Sent to Dad");
    expect(snapSubcategory("Vehicle", "petrol")).toBe("Fuel");
    expect(snapSubcategory("Transportation", "uber")).toBe("Cab");
    expect(snapSubcategory("Food", "  Mom's tiffin  ")).toBe("Mom's tiffin"); // own text kept
    expect(snapSubcategory("Food", "   ")).toBeUndefined();
  });
});

describe("legacy category migration", () => {
  it("renames expenses and budgets, keeping the new-name budget on a clash, and is idempotent", async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const now = new Date();
    await ExpenseModel.collection.insertMany([
      { userId: a, amount: 100, category: "Transport", date: now, source: "manual" },
      { userId: a, amount: 200, category: "Entertainment", date: now, source: "manual" },
      { userId: b, amount: 300, category: "Food", date: now, source: "manual" },
    ]);
    await BudgetModel.collection.insertMany([
      { userId: a, category: "Transport", monthlyLimit: 3000 },
      { userId: a, category: "Transportation", monthlyLimit: 5000 },
      { userId: a, category: "Entertainment", monthlyLimit: 1000 },
      { userId: b, category: "Transport", monthlyLimit: 2000 },
    ]);

    expect(await migrateLegacyCategories()).toEqual({ expenses: 2, budgetsRenamed: 2, budgetsDropped: 1 });
    const cats = (await ExpenseModel.find({ userId: a }).sort({ amount: 1 }).lean()).map((e) => e.category);
    expect(cats).toEqual(["Transportation", "Life & Entertainment"]);
    const budgets = await BudgetModel.find({}).sort({ userId: 1, category: 1 }).lean();
    expect(budgets.map((x) => [x.userId.toString(), x.category, x.monthlyLimit])).toEqual([
      [a.toString(), "Life & Entertainment", 1000],
      [a.toString(), "Transportation", 5000],
      [b.toString(), "Transportation", 2000],
    ]);

    expect(await migrateLegacyCategories()).toEqual({ expenses: 0, budgetsRenamed: 0, budgetsDropped: 0 });
  });
});

describe("subcategories over REST", () => {
  it("infers, snaps, unsets and re-infers subcategories, and splits a category summary by them", async () => {
    const { auth } = await registerUser();
    const post = (body: Record<string, unknown>) => api().post("/api/expenses").set(auth).send(body);
    const swiggy = (await post({ amount: 300, category: "Food", merchant: "Swiggy" })).body.expense;
    expect(swiggy.subcategory).toBe("Swiggy");
    expect((await post({ amount: 50, category: "Food", subcategory: "swiggy", note: "chai" })).body.expense.subcategory).toBe("Swiggy");
    await post({ amount: 200, category: "Food", merchant: "Zomato" });
    await post({ amount: 100, category: "Food", note: "lunch" });
    const other = (await post({ amount: 499, category: "Other", merchant: "Myntra" })).body.expense;
    expect(other).toMatchObject({ category: "Shopping", subcategory: "Myntra" });
    expect((await post({ amount: 1, category: "Food", subcategory: "x".repeat(41) })).status).toBe(400);

    const s = await api().get("/api/expenses/summary?category=Food").set(auth);
    expect(s.body.bySubcategory).toEqual([
      { subcategory: "Swiggy", total: 350, count: 2 },
      { subcategory: "Zomato", total: 200, count: 1 },
      { subcategory: "Other", total: 100, count: 1 },
    ]);

    const cleared = await api().patch(`/api/expenses/${swiggy.id}`).set(auth).send({ subcategory: "" });
    expect(cleared.body.expense.subcategory).toBeUndefined();
    const set = await api().patch(`/api/expenses/${swiggy.id}`).set(auth).send({ subcategory: "restaurants" });
    expect(set.body.expense.subcategory).toBe("Restaurant");
    // Moving category drops a subcategory that doesn't belong to it (nothing to infer for Health).
    const moved = await api().patch(`/api/expenses/${swiggy.id}`).set(auth).send({ category: "Health" });
    expect(moved.body.expense).toMatchObject({ category: "Health" });
    expect(moved.body.expense.subcategory).toBeUndefined();
    const back = await api().patch(`/api/expenses/${swiggy.id}`).set(auth).send({ category: "Food" });
    expect(back.body.expense.subcategory).toBe("Swiggy"); // re-inferred from the merchant

    // Legacy names on queries and budgets.
    await post({ amount: 700, category: "Entertainment", merchant: "PVR", note: "Leo movie" });
    const ent = await api().get("/api/expenses/summary?category=Entertainment").set(auth);
    expect(ent.status).toBe(200);
    expect(ent.body.bySubcategory).toEqual([{ subcategory: "Theatre", total: 700, count: 1 }]);
    expect((await api().get("/api/expenses?category=Entertainment").set(auth)).body.expenses[0]).toMatchObject({ note: "Leo", category: "Life & Entertainment" });
    const bud = await api().put("/api/budgets").set(auth).send({ category: "Transport", monthlyLimit: 2000 });
    expect(bud.body.budget.category).toBe("Transportation");
    expect((await api().delete("/api/budgets/Transport").set(auth)).status).toBe(204);
  });
});

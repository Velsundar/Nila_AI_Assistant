import { afterEach, describe, expect, it } from "vitest";
import { api, fakeOpenMeteo, registerUser } from "../test/helpers";
import { addDays, localDateString } from "../services/dates";
import { mondayOf, resolveWeekStart } from "../services/insights";
import { setWeatherFetch } from "../services/weather";

const TZ = "Asia/Kolkata";
const today = () => localDateString(new Date(), TZ);

afterEach(() => setWeatherFetch(undefined));

describe("PATCH /api/auth/me city", () => {
  it("geocodes and stores the city, rejects unknown cities, and clears with an empty string", async () => {
    const om = fakeOpenMeteo();
    setWeatherFetch(om.impl);
    const { auth } = await registerUser();
    const set = await api().patch("/api/auth/me").set(auth).send({ city: "bangalore" });
    expect(set.status).toBe(200);
    expect(set.body.user.city).toBe("Bengaluru");
    expect((await api().get("/api/auth/me").set(auth)).body.user.city).toBe("Bengaluru");

    const bad = await api().patch("/api/auth/me").set(auth).send({ city: "Nowhereville" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    expect((await api().get("/api/auth/me").set(auth)).body.user.city).toBe("Bengaluru");

    const cleared = await api().patch("/api/auth/me").set(auth).send({ city: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.user.city).toBeUndefined();
  });

  it("returns 503 when the geocoder is down", async () => {
    setWeatherFetch(fakeOpenMeteo({ down: true }).impl);
    const { auth } = await registerUser();
    const r = await api().patch("/api/auth/me").set(auth).send({ city: "Mumbai" });
    expect(r.status).toBe(503);
  });
});

describe("GET /api/briefing", () => {
  it("aggregates today's reminders, due tasks, spending and budget alerts; weather fails soft", async () => {
    const { auth } = await registerUser("Asha Rao");
    const td = today();
    const yd = addDays(td, -1);
    await api().post("/api/expenses").set(auth).send({ amount: 300, category: "Food", date: yd });
    await api().post("/api/expenses").set(auth).send({ amount: 200, category: "Food", date: yd });
    await api().post("/api/expenses").set(auth).send({ amount: 1000, category: "Food", date: td });
    await api().put("/api/budgets").set(auth).send({ category: "Food", monthlyLimit: 1500 });
    await api().put("/api/budgets").set(auth).send({ category: "Travel", monthlyLimit: 9000 });
    await api().post("/api/reminders").set(auth).send({ text: "Call mom", dateTime: `${td}T23:58:00+05:30` });
    await api().post("/api/reminders").set(auth).send({ text: "Next week thing", dateTime: `${addDays(td, 7)}T10:00:00+05:30` });
    await api().post("/api/tasks").set(auth).send({ title: "Renew passport", dueDate: addDays(td, -3) });
    await api().post("/api/tasks").set(auth).send({ title: "Call plumber", dueDate: td });
    await api().post("/api/tasks").set(auth).send({ title: "Future", dueDate: addDays(td, 5) });
    await api().post("/api/tasks").set(auth).send({ title: "Undated" });

    const r = await api().get("/api/briefing").query({ tz: TZ }).set(auth);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.date).toBe(td);
    expect(b.weather).toBeUndefined(); // no city
    expect(b.reminders.map((x: { text: string }) => x.text)).toEqual(["Call mom"]);
    expect(b.tasksDue.map((x: { title: string }) => x.title)).toEqual(["Renew passport", "Call plumber"]);
    expect(b.spentYesterday).toBe(500);
    const sameMonth = yd.slice(0, 7) === td.slice(0, 7);
    expect(b.spentThisMonth).toBe(sameMonth ? 1500 : 1000);
    if (sameMonth) expect(b.budgetAlerts).toEqual([{ category: "Food", monthlyLimit: 1500, spent: 1500, percentUsed: 100 }]);
    expect(b.text).toMatch(/Asha\./);
    expect(b.text).toContain("Call mom at 11:58 PM");
    expect(b.text).toContain("2 tasks are due, 1 of them overdue: Renew passport and Call plumber.");
    expect(b.text).toContain("You spent ₹500 yesterday");
    expect(b.text).not.toMatch(/[*#_]/);
  });

  it("includes weather for a user with a city, and omits it when the service is down", async () => {
    setWeatherFetch(fakeOpenMeteo().impl);
    const { auth } = await registerUser();
    await api().patch("/api/auth/me").set(auth).send({ city: "Bengaluru" });
    const r = await api().get("/api/briefing").set(auth);
    expect(r.body.weather).toEqual({ city: "Bengaluru", tempC: 24, condition: "Partly cloudy", highC: 29, lowC: 19, rainChance: 60 });
    expect(r.body.text).toContain("In Bengaluru it's 24 degrees and partly cloudy, with a high of 29 and a 60% chance of rain.");
    expect(r.body.text).toContain("Nothing is due today.");

    setWeatherFetch(fakeOpenMeteo({ down: true }).impl);
    const down = await api().get("/api/briefing").set(auth);
    expect(down.status).toBe(200);
    expect(down.body.weather).toBeUndefined();
  });

  it("caches the forecast", async () => {
    const om = fakeOpenMeteo();
    setWeatherFetch(om.impl);
    const { auth } = await registerUser();
    await api().patch("/api/auth/me").set(auth).send({ city: "Mumbai" });
    await api().get("/api/briefing").set(auth);
    await api().get("/api/briefing").set(auth);
    expect(om.calls.filter((u) => u.includes("/v1/forecast"))).toHaveLength(1);
  });
});

describe("GET /api/reports/weekly", () => {
  it("defaults to the last completed Monday-Sunday week", () => {
    const fri = new Date("2026-10-30T06:00:00Z");
    expect(resolveWeekStart(undefined, TZ, fri)).toBe("2026-10-19");
    const mon = new Date("2026-10-26T00:30:00+05:30");
    expect(resolveWeekStart(undefined, TZ, mon)).toBe("2026-10-19");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26"); // Sunday
    expect(resolveWeekStart("2026-10-22", TZ)).toBe("2026-10-19");
  });

  it("aggregates the week vs the previous week", async () => {
    const { auth } = await registerUser();
    const add = (amount: number, category: string, date: string, merchant?: string) =>
      api().post("/api/expenses").set(auth).send({ amount, category, date, merchant });
    // week of 2026-09-07 .. 2026-09-13
    await add(400, "Food", "2026-09-07", "Swiggy");
    await add(300, "Food", "2026-09-13", "swiggy");
    await add(500, "Transport", "2026-09-10", "Uber");
    await add(99, "Food", "2026-09-14", "Swiggy"); // next week, excluded
    // previous week
    await add(1000, "Shopping", "2026-09-02", "Amazon");

    const r = await api().get("/api/reports/weekly").query({ weekStart: "2026-09-09" }).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      weekStart: "2026-09-07",
      weekEnd: "2026-09-13",
      total: 1200,
      previousTotal: 1000,
      changePercent: 20,
      byCategory: [
        { category: "Food", total: 700, count: 2 },
        { category: "Transport", total: 500, count: 1 },
      ],
      topMerchants: [
        { merchant: "Swiggy", total: 700, count: 2 },
        { merchant: "Uber", total: 500, count: 1 },
      ],
    });
    expect(r.body.text).toBe(
      "From 7 September to 13 September you spent ₹1,200 across 3 expenses, 20% more than the week before. Most of it went to Food at ₹700. Your top merchant was Swiggy, ₹700 over 2 payments.",
    );
  });

  it("handles empty weeks and validates weekStart", async () => {
    const { auth } = await registerUser();
    const r = await api().get("/api/reports/weekly").set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 0, previousTotal: 0, changePercent: null, byCategory: [], topMerchants: [] });
    expect(r.body.text).toBe("Last week you didn't log any spending.");
    expect((await api().get("/api/reports/weekly?weekStart=last-week").set(auth)).status).toBe(400);
    expect((await api().get("/api/reports/weekly")).status).toBe(401);
  });
});

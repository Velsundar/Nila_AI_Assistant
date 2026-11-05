import { afterEach, describe, expect, it } from "vitest";
import { agent, api, fakeOpenMeteo, registerUser } from "../test/helpers";
import { planFor } from "../agent/mock";
import { addDays, localDateString } from "../services/dates";
import { setWeatherFetch } from "../services/weather";

const TZ = "Asia/Kolkata";
const ctx = { timezone: TZ, now: new Date(), userName: "Asha", assistantName: "Nila", currency: "INR", memories: [] };
const today = () => localDateString(new Date(), TZ);
const titles = async (auth: Record<string, string>, q = "") =>
  (await api().get(`/api/tasks${q}`).set(auth)).body.tasks.map((t: { title: string; done: boolean }) => `${t.title}${t.done ? " (done)" : ""}`);

afterEach(() => setWeatherFetch(undefined));

describe("agent: tasks (mock provider)", () => {
  it("'add milk and eggs to my shopping list' creates two tasks", async () => {
    const { auth } = await registerUser();
    const r = await agent(auth, "Add milk and eggs to my shopping list");
    expect(r.actions[0]).toMatchObject({ tool: "manageTask", ok: true, args: { action: "add", titles: ["milk", "eggs"], list: "Shopping" } });
    expect(r.reply).toBe("Added milk and eggs to your Shopping list.");
    const list = (await api().get("/api/tasks?list=shopping").set(auth)).body.tasks;
    expect(list.map((t: { title: string; list: string }) => [t.title, t.list])).toEqual([
      ["milk", "Shopping"],
      ["eggs", "Shopping"],
    ]);
  });

  it("adds a task with a due date, lists, completes fuzzily and lists due today", async () => {
    const { auth } = await registerUser();
    const a = await agent(auth, "add a task to call the plumber tomorrow");
    expect(a.actions[0].args).toMatchObject({ action: "add", titles: ["call the plumber"], dueDate: addDays(today(), 1) });
    expect(a.reply).toBe("Added call the plumber to your tasks for tomorrow.");
    await agent(auth, "add bread, butter and jam to my shopping list");
    await agent(auth, "add pay rent today");

    const shop = await agent(auth, "what's on my shopping list?");
    expect(shop.reply).toBe("Your Shopping list has 3 items: bread, butter and jam.");

    const done = await agent(auth, "mark butter as done");
    expect(done.actions[0]).toMatchObject({ tool: "manageTask", ok: true, result: { completed: ["butter"] } });
    expect(done.reply).toBe("Nice, I've marked butter as done.");
    expect(await titles(auth, "?list=Shopping")).toEqual(["bread", "jam", "butter (done)"]);

    const miss = await agent(auth, "mark the tax filing as done");
    expect(miss.actions[0].ok).toBe(false);
    expect(miss.reply).toMatch(/No open task matches tax filing\. Open tasks:/);

    const all = await agent(auth, "show my tasks");
    expect(all.actions[0].args).toEqual({ action: "list" });
    expect(all.reply).toMatch(/^You have 3 items open: call the plumber, bread and jam\.$/);
  });

  it("deleting a task asks for confirmation first", async () => {
    const { auth } = await registerUser();
    await agent(auth, "add milk and eggs to my shopping list");
    const ask = await agent(auth, "remove eggs from my shopping list");
    expect(ask.pendingConfirmation?.summary).toBe("Delete the task eggs from Shopping?");
    expect(ask.actions).toEqual([]);
    expect(await titles(auth)).toHaveLength(2);
    const no = await agent(auth, "no", ask.conversationId);
    expect(no.reply).toBe("Okay, I've cancelled that.");
    const ask2 = await agent(auth, "remove eggs from my shopping list", ask.conversationId);
    const yes = await agent(auth, "yes", ask2.conversationId);
    expect(yes.reply).toBe("Done, I deleted eggs.");
    expect(yes.actions[0]).toMatchObject({ tool: "manageTask", ok: true });
    expect(await titles(auth)).toEqual(["milk"]);
  });

  it("never touches another user's tasks or notes", async () => {
    const a = await registerUser("A");
    const b = await registerUser("B");
    await agent(a.auth, "add milk to my shopping list");
    await agent(a.auth, "note that my wifi password is sunflower");
    const del = await agent(b.auth, "remove milk from my shopping list");
    expect(del.pendingConfirmation).toBeUndefined();
    expect(del.reply).toMatch(/No task matches milk/);
    expect((await agent(b.auth, "mark milk as done")).actions[0].ok).toBe(false);
    const s = await agent(b.auth, "what was my wifi password note");
    expect(s.reply).toBe("I couldn't find a note about that.");
    expect(await titles(a.auth)).toEqual(["milk"]);
  });
});

describe("agent: notes", () => {
  it("saves, finds and deletes (with confirmation) notes", async () => {
    const { auth } = await registerUser();
    const save = await agent(auth, "Take a note: the wifi password is sunflower@2024");
    expect(save.actions[0]).toMatchObject({ tool: "manageNote", ok: true, args: { action: "save", text: "the wifi password is sunflower@2024" } });
    expect(save.reply).toBe("Saved your note.");
    await agent(auth, "note that parking spot is B2-47");

    const find = await agent(auth, "What was my wifi password note?");
    expect(find.reply).toBe("Your note says: the wifi password is sunflower@2024");

    const ask = await agent(auth, "delete my wifi note");
    expect(ask.pendingConfirmation?.summary).toBe("Delete your note: the wifi password is sunflower@2024?");
    const yes = await agent(auth, "yes please", ask.conversationId);
    expect(yes.reply).toBe("Done, I deleted that note.");
    const notes = (await api().get("/api/notes").set(auth)).body.notes;
    expect(notes.map((n: { text: string }) => n.text)).toEqual(["parking spot is B2-47"]);
  });
});

describe("agent: weather, briefing, weekly report, general questions", () => {
  it("uses the home city, a named city, or explains when none is set", async () => {
    setWeatherFetch(fakeOpenMeteo().impl);
    const { auth } = await registerUser();
    const none = await agent(auth, "what's the weather like?");
    expect(none.reply).toMatch(/No home city is set/);
    await api().patch("/api/auth/me").set(auth).send({ city: "Bengaluru" });
    const home = await agent(auth, "what's the weather like?");
    expect(home.reply).toBe("In Bengaluru it's 24 degrees and partly cloudy, with a high of 29 and a 60% chance of rain.");
    const tmr = await agent(auth, "will it rain tomorrow in mumbai");
    expect(tmr.actions[0].args).toEqual({ city: "Mumbai", day: "tomorrow" });
    expect(tmr.reply).toBe("Tomorrow in Mumbai: overcast, 19 to 27 degrees, with a 10% chance of rain.");
  });

  it("briefs the day and reports last week from the same templates as the REST routes", async () => {
    const { auth } = await registerUser("Asha Rao");
    await api().post("/api/expenses").set(auth).send({ amount: 420, category: "Food", date: addDays(today(), -1) });
    const b = await agent(auth, "brief me");
    expect(b.actions[0].tool).toBe("getDailyBriefing");
    const rest = (await api().get("/api/briefing").set(auth)).body.text;
    expect(b.reply).toBe(rest);
    expect(b.reply).toContain("₹420 yesterday");

    const w = await agent(auth, "give me my weekly report");
    expect(w.actions[0].tool).toBe("getWeeklyReport");
    expect(w.reply).toBe((await api().get("/api/reports/weekly").set(auth)).body.text);
  });

  it("answers everyday questions with no tool", async () => {
    const { auth } = await registerUser();
    const g = await agent(auth, "how many grams in a cup?");
    expect(g.actions).toEqual([]);
    expect(g.reply).toMatch(/240 millilitres/);
    expect((await agent(auth, "give me a 10-min workout")).reply).toMatch(/10 minute workout/);
    expect((await agent(auth, "plan my evening")).actions).toEqual([]);
  });

  it("still routes expenses, reminders and budgets the old way", () => {
    expect(planFor("spent 250 on lunch at swiggy", ctx)).toMatchObject({ tool: "addExpense" });
    expect(planFor("add 300 for groceries", ctx)).toMatchObject({ tool: "addExpense" });
    expect(planFor("remind me to pay rent tomorrow", ctx)).toMatchObject({ tool: "createReminder" });
    expect(planFor("check my budget", ctx)).toMatchObject({ tool: "getBudgets" });
    expect(planFor("delete my last expense", ctx)).toMatchObject({ tool: "deleteExpense" });
    expect(planFor("what's overdue", ctx)).toEqual({ tool: "manageTask", args: { action: "list", when: "overdue" } });
    expect(planFor("what tasks are due today", ctx)).toEqual({ tool: "manageTask", args: { action: "list", when: "today" } });
    expect(planFor("what's on my to-do list", ctx)).toEqual({ tool: "manageTask", args: { action: "list", list: "Inbox" } });
  });
});

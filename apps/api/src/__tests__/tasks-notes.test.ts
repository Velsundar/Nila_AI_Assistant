import { describe, expect, it } from "vitest";
import { api, registerUser } from "../test/helpers";
import { normalizeListName, titleSimilarity } from "../services/tasks";

describe("tasks REST", () => {
  it("requires auth", async () => {
    expect((await api().get("/api/tasks")).status).toBe(401);
    expect((await api().post("/api/tasks").send({ title: "x" })).status).toBe(401);
  });

  it("creates with defaults, validates, and lists open first then by due date", async () => {
    const { auth } = await registerUser();
    const bad = await api().post("/api/tasks").set(auth).send({ title: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const inbox = await api().post("/api/tasks").set(auth).send({ title: "Call plumber" });
    expect(inbox.status).toBe(201);
    expect(inbox.body.task).toMatchObject({ title: "Call plumber", list: "Inbox", priority: "normal", done: false });
    expect(inbox.body.task.dueDate).toBeUndefined();

    const later = (await api().post("/api/tasks").set(auth).send({ title: "Later", dueDate: "2026-12-20", priority: "high" })).body.task;
    const sooner = (await api().post("/api/tasks").set(auth).send({ title: "Sooner", dueDate: "2026-11-02" })).body.task;
    const done = (await api().post("/api/tasks").set(auth).send({ title: "Done one", dueDate: "2026-10-01" })).body.task;
    await api().patch(`/api/tasks/${done.id}`).set(auth).send({ done: true });

    const list = (await api().get("/api/tasks").set(auth)).body.tasks.map((t: { title: string }) => t.title);
    expect(list).toEqual(["Sooner", "Later", "Call plumber", "Done one"]);
    expect(later.priority).toBe("high");
    expect(sooner.dueDate).toMatch(/^2026-11-02T/);
  });

  it("filters by list case-insensitively and by done", async () => {
    const { auth } = await registerUser();
    await api().post("/api/tasks").set(auth).send({ title: "Milk", list: "Shopping" });
    const eggs = (await api().post("/api/tasks").set(auth).send({ title: "Eggs", list: "shopping" })).body.task;
    expect(eggs.list).toBe("Shopping"); // reuses the existing list's casing
    await api().post("/api/tasks").set(auth).send({ title: "Report", list: "Work" });

    const shopping = (await api().get("/api/tasks?list=SHOPPING").set(auth)).body.tasks;
    expect(shopping.map((t: { title: string }) => t.title).sort()).toEqual(["Eggs", "Milk"]);

    await api().patch(`/api/tasks/${eggs.id}`).set(auth).send({ done: true });
    const open = (await api().get("/api/tasks?done=false").set(auth)).body.tasks;
    expect(open.map((t: { title: string }) => t.title).sort()).toEqual(["Milk", "Report"]);
    const closed = (await api().get("/api/tasks?done=true").set(auth)).body.tasks;
    expect(closed).toHaveLength(1);
    expect((await api().get("/api/tasks?done=maybe").set(auth)).status).toBe(400);
  });

  it("PATCH sets and clears completedAt and dueDate", async () => {
    const { auth } = await registerUser();
    const t = (await api().post("/api/tasks").set(auth).send({ title: "Pay bill", dueDate: "2026-11-05" })).body.task;
    const doneRes = await api().patch(`/api/tasks/${t.id}`).set(auth).send({ done: true, title: "Pay electricity bill", list: "Home" });
    expect(doneRes.status).toBe(200);
    expect(doneRes.body.task).toMatchObject({ done: true, title: "Pay electricity bill", list: "Home" });
    expect(Date.parse(doneRes.body.task.completedAt)).toBeGreaterThan(Date.now() - 60_000);

    const undone = (await api().patch(`/api/tasks/${t.id}`).set(auth).send({ done: false, dueDate: null })).body.task;
    expect(undone.done).toBe(false);
    expect(undone.completedAt).toBeUndefined();
    expect(undone.dueDate).toBeUndefined();
  });

  it("isolates users: another user's task is a 404 and never listed", async () => {
    const a = await registerUser("A");
    const b = await registerUser("B");
    const t = (await api().post("/api/tasks").set(a.auth).send({ title: "Secret task" })).body.task;
    expect((await api().get("/api/tasks").set(b.auth)).body.tasks).toEqual([]);
    expect((await api().patch(`/api/tasks/${t.id}`).set(b.auth).send({ done: true })).status).toBe(404);
    expect((await api().delete(`/api/tasks/${t.id}`).set(b.auth)).status).toBe(404);
    expect((await api().delete("/api/tasks/not-an-id").set(a.auth)).status).toBe(404);
    expect((await api().delete(`/api/tasks/${t.id}`).set(a.auth)).status).toBe(204);
    expect((await api().get("/api/tasks").set(a.auth)).body.tasks).toEqual([]);
  });

  it("normalizes spoken list names and matches titles fuzzily", () => {
    expect(normalizeListName("my shopping list")).toBe("Shopping");
    expect(normalizeListName("to-do")).toBe("Inbox");
    expect(normalizeListName(undefined)).toBe("Inbox");
    expect(titleSimilarity("milk", "Milk")).toBe(1);
    expect(titleSimilarity("the plumber", "Call the plumber")).toBeGreaterThanOrEqual(0.5);
    expect(titleSimilarity("egg", "Eggs")).toBeGreaterThanOrEqual(0.5);
    expect(titleSimilarity("bread", "Call the plumber")).toBe(0);
  });
});

describe("notes REST", () => {
  it("CRUD, newest first", async () => {
    const { auth } = await registerUser();
    expect((await api().post("/api/notes").set(auth).send({ text: "" })).status).toBe(400);
    const n1 = (await api().post("/api/notes").set(auth).send({ text: "Home WiFi password is sunflower" })).body.note;
    await new Promise((r) => setTimeout(r, 5));
    const n2 = await api().post("/api/notes").set(auth).send({ text: "Parking spot B2-47" });
    expect(n2.status).toBe(201);
    expect(n2.body.note).toMatchObject({ text: "Parking spot B2-47" });
    expect(n2.body.note.updatedAt).toBeTruthy();

    let list = (await api().get("/api/notes").set(auth)).body.notes;
    expect(list.map((n: { text: string }) => n.text)).toEqual(["Parking spot B2-47", "Home WiFi password is sunflower"]);

    const upd = await api().patch(`/api/notes/${n1.id}`).set(auth).send({ text: "Home WiFi password is daisy" });
    expect(upd.body.note.text).toBe("Home WiFi password is daisy");
    list = (await api().get("/api/notes").set(auth)).body.notes;
    expect(list[0].id).toBe(n1.id); // updated -> newest

    expect((await api().delete(`/api/notes/${n1.id}`).set(auth)).status).toBe(204);
    expect((await api().get("/api/notes").set(auth)).body.notes).toHaveLength(1);
  });

  it("searches with ?q (whole words, stems, and partial words)", async () => {
    const { auth } = await registerUser();
    for (const text of ["Home WiFi password is sunflower", "Gym locker combination 3-17-29", "Passwords for the bank are in the safe"]) {
      await api().post("/api/notes").set(auth).send({ text });
    }
    const wifi = (await api().get("/api/notes").query({ q: "wifi password" }).set(auth)).body.notes;
    expect(wifi[0].text).toMatch(/WiFi/);
    const gym = (await api().get("/api/notes").query({ q: "locker" }).set(auth)).body.notes;
    expect(gym.map((n: { text: string }) => n.text)).toEqual(["Gym locker combination 3-17-29"]);
    const partial = (await api().get("/api/notes").query({ q: "combin" }).set(auth)).body.notes;
    expect(partial).toHaveLength(1);
    expect((await api().get("/api/notes").query({ q: "zebra" }).set(auth)).body.notes).toEqual([]);
  });

  it("isolates users", async () => {
    const a = await registerUser("A");
    const b = await registerUser("B");
    const n = (await api().post("/api/notes").set(a.auth).send({ text: "A's secret wifi password" })).body.note;
    expect((await api().get("/api/notes").set(b.auth)).body.notes).toEqual([]);
    expect((await api().get("/api/notes?q=wifi").set(b.auth)).body.notes).toEqual([]);
    expect((await api().patch(`/api/notes/${n.id}`).set(b.auth).send({ text: "hacked" })).status).toBe(404);
    expect((await api().delete(`/api/notes/${n.id}`).set(b.auth)).status).toBe(404);
    expect((await api().get("/api/notes").set(a.auth)).body.notes[0].text).toBe("A's secret wifi password");
  });
});

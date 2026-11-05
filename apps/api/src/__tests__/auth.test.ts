import { describe, expect, it } from "vitest";
import { UserSchema } from "@nova/shared";
import { api, registerUser } from "../test/helpers";

describe("auth", () => {
  it("health is public", async () => {
    const res = await api().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("registers, returns a token and a contract-shaped user without secrets", async () => {
    const res = await api().post("/api/auth/register").send({ name: "Asha", email: "Asha@Example.COM", password: "password123" });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    expect(UserSchema.parse(res.body.user)).toBeTruthy();
    expect(res.body.user).toMatchObject({ name: "Asha", email: "asha@example.com", currency: "INR", assistantName: "Nila" });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/passwordHash|"_id"|__v/);
  });

  it("rejects duplicate emails (case-insensitive) with 409", async () => {
    await api().post("/api/auth/register").send({ name: "A", email: "dup@example.com", password: "password123" });
    const res = await api().post("/api/auth/register").send({ name: "B", email: "DUP@example.com", password: "password123" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("validates register input", async () => {
    const res = await api().post("/api/auth/register").send({ name: "", email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toBeDefined();
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    const { email } = await registerUser();
    const ok = await api().post("/api/auth/login").send({ email: email.toUpperCase(), password: "password123" });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user.email).toBe(email);
    const bad = await api().post("/api/auth/login").send({ email, password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("GET/PATCH /me require a valid token", async () => {
    expect((await api().get("/api/auth/me")).status).toBe(401);
    const bad = await api().get("/api/auth/me").set({ Authorization: "Bearer garbage" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("UNAUTHORIZED");

    const { auth, user } = await registerUser("Ravi");
    const me = await api().get("/api/auth/me").set(auth);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    const upd = await api().patch("/api/auth/me").set(auth).send({ assistantName: "Jarvis", currency: "usd" });
    expect(upd.status).toBe(200);
    expect(upd.body.user).toMatchObject({ assistantName: "Jarvis", currency: "USD", name: "Ravi" });
  });

  it("returns the error shape for unknown routes and bad JSON", async () => {
    const r404 = await api().get("/api/nope");
    expect(r404.status).toBe(404);
    expect(r404.body.error.code).toBe("NOT_FOUND");
    const badJson = await api().post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe("BAD_JSON");
  });
});

import request from "supertest";
import { createApp } from "../app";

export const app = createApp({ rateLimit: false });
export const api = () => request(app);

let n = 0;
export async function registerUser(name = "Test User") {
  const email = `user${Date.now()}${++n}@example.com`;
  const res = await api().post("/api/auth/register").send({ name, email, password: "password123" });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  return { token, user: res.body.user, email, auth };
}

export async function agent(auth: Record<string, string>, message: string, conversationId?: string) {
  const res = await api().post("/api/agent").set(auth).send({ message, conversationId, timezone: "Asia/Kolkata" });
  if (res.status !== 200) throw new Error(`agent failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as import("@nova/shared").AgentResponse;
}

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

/** Fake Open-Meteo: knows Bengaluru and Mumbai; anything else is an unknown city. */
export function fakeOpenMeteo(opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (opts.down) throw new TypeError("fetch failed");
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("geocoding-api")) {
      const name = new URL(u).searchParams.get("name")?.toLowerCase();
      if (name === "bengaluru" || name === "bangalore") return json({ results: [{ name: "Bengaluru", latitude: 12.97, longitude: 77.59, country: "India" }] });
      if (name === "mumbai") return json({ results: [{ name: "Mumbai", latitude: 19.07, longitude: 72.88, country: "India" }] });
      return json({ generationtime_ms: 0.1 });
    }
    if (u.includes("/v1/forecast")) {
      const mumbai = u.includes("latitude=19.07");
      return json({
        current: { temperature_2m: mumbai ? 31.4 : 24.4, weather_code: mumbai ? 0 : 2 },
        daily: {
          weather_code: [mumbai ? 0 : 61, 3],
          temperature_2m_max: [mumbai ? 33.2 : 28.6, 27.1],
          temperature_2m_min: [mumbai ? 26 : 19.2, 18.8],
          precipitation_probability_max: [mumbai ? 0 : 60, 10],
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

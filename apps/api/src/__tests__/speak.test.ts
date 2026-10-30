import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Types } from "mongoose";
import { INTERRUPT_ACKS } from "@nova/shared";
import { createApp } from "../app";
import { api, registerUser } from "../test/helpers";
import { UsageModel } from "../models/Usage";
import { consumeDailyLlmCall } from "../services/usage";
import {
  LruCache,
  PROBE_VOICE,
  audioCache,
  concatWav,
  parseVoiceList,
  parseWav,
  pickDefaultVoice,
  setTtsOverrides,
  splitForTts,
  type TtsConfig,
} from "../services/speech";

const VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
const CFG: TtsConfig = { baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "canopylabs/orpheus-v1-english", maxInputChars: 200, timeoutMs: 20_000 };

/** A tiny valid 16-bit mono PCM WAV with `n` samples of value `v`. */
function makeWav(n = 8, v = 1): Buffer {
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(v, i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const groqError = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code } }), { status, headers: { "Content-Type": "application/json", ...headers } });

type FakeState = { terms?: boolean; rateLimited?: boolean; voices?: string[] };

/** Fake Groq /audio/speech: lists voices on an unknown voice, enforces terms, can 429. */
function fakeGroq(state: FakeState = {}) {
  const calls: { url: string; body: { model: string; voice: string; input: string; response_format: string }; auth?: string }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, auth: (init?.headers as Record<string, string>)?.Authorization });
    if (state.terms) {
      return groqError(400, "model_terms_required", "The model `canopylabs/orpheus-v1-english` requires terms acceptance. Please have the org admin accept the terms at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english");
    }
    if (state.rateLimited) return groqError(429, "rate_limit_exceeded", "Rate limit reached. Please try again in 7.5s.", { "retry-after": "8" });
    const voices = state.voices ?? VOICES;
    if (!voices.includes(body.voice)) return groqError(400, "invalid_voice", `voice must be one of the following voices: [${voices.join(" ")}]`);
    return new Response(new Uint8Array(makeWav(4, body.input.length)), { status: 200, headers: { "Content-Type": "audio/wav" } });
  });
  return { impl: impl as unknown as typeof fetch, calls, state };
}

function useGroq(state: FakeState = {}, cfg: Partial<TtsConfig> = {}) {
  const g = fakeGroq(state);
  const clock = { t: 1_000_000 };
  setTtsOverrides({ cfg: { ...CFG, ...cfg }, fetchImpl: g.impl, now: () => clock.t });
  return { ...g, clock, speechCalls: () => g.calls.filter((c) => c.body.voice !== PROBE_VOICE) };
}

afterEach(() => setTtsOverrides());

const ttsCallsFor = async (userId: string) => (await UsageModel.findOne({ userId: new Types.ObjectId(userId) }).lean())?.ttsCalls ?? 0;

describe("GET /api/speak/voices", () => {
  it("requires auth", async () => {
    expect((await api().get("/api/speak/voices")).status).toBe(401);
    expect((await api().post("/api/speak").send({ text: "Hi." })).status).toBe(401);
  });

  it("reports NO_KEY in mock mode without calling Groq", async () => {
    const { auth } = await registerUser();
    const r = await api().get("/api/speak/voices").set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, reason: "NO_KEY", voices: [] });
  });

  it("discovers voices from the invalid-voice error, maps genders and picks a female default", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    const r = await api().get("/api/speak/voices").set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      available: true,
      voices: [
        { id: "autumn", gender: "female" },
        { id: "diana", gender: "female" },
        { id: "hannah", gender: "female" },
        { id: "austin", gender: "male" },
        { id: "daniel", gender: "male" },
        { id: "troy", gender: "male" },
      ],
      defaultVoice: "autumn",
    });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/speech");
    expect(g.calls[0]!.auth).toBe("Bearer k");
    expect(g.calls[0]!.body).toMatchObject({ model: "canopylabs/orpheus-v1-english", voice: PROBE_VOICE, response_format: "wav" });
    // Cached: a second call doesn't hit Groq.
    await api().get("/api/speak/voices").set(auth);
    expect(g.calls).toHaveLength(1);
  });

  it("uses TTS_VOICE as default only when it's a real voice", async () => {
    useGroq({}, { preferredVoice: "Hannah" });
    const { auth } = await registerUser();
    expect((await api().get("/api/speak/voices").set(auth)).body.defaultVoice).toBe("hannah");
    useGroq({}, { preferredVoice: "nobody" });
    expect((await api().get("/api/speak/voices").set(auth)).body.defaultVoice).toBe("autumn");
    expect(pickDefaultVoice([{ id: "x" }, { id: "y", gender: "female" }])).toBe("y");
    expect(pickDefaultVoice([{ id: "x", gender: "male" }])).toBe("x");
  });

  it("reports TERMS_REQUIRED and re-checks after ~1 minute (failure cache)", async () => {
    const g = useGroq({ terms: true });
    const { auth } = await registerUser();
    expect((await api().get("/api/speak/voices").set(auth)).body).toEqual({ available: false, reason: "TERMS_REQUIRED", voices: [] });
    g.clock.t += 30_000;
    await api().get("/api/speak/voices").set(auth);
    expect(g.calls).toHaveLength(1);
    // The user accepts the terms; after the short failure TTL the voices appear.
    g.state.terms = false;
    g.clock.t += 31_000;
    const r = await api().get("/api/speak/voices").set(auth);
    expect(r.body.available).toBe(true);
    expect(g.calls).toHaveLength(2);
  });

  it("caches success for ~1 hour, then rediscovers", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    await api().get("/api/speak/voices").set(auth);
    g.clock.t += 59 * 60_000;
    await api().get("/api/speak/voices").set(auth);
    expect(g.calls).toHaveLength(1);
    g.state.voices = ["tara", "leo"];
    g.clock.t += 2 * 60_000;
    const r = await api().get("/api/speak/voices").set(auth);
    expect(g.calls).toHaveLength(2);
    expect(r.body.voices).toEqual([{ id: "tara", gender: "female" }, { id: "leo", gender: "male" }]);
    expect(r.body.defaultVoice).toBe("tara");
  });

  it("reports UNAVAILABLE for other failures (network, 5xx, unparseable)", async () => {
    const { auth } = await registerUser();
    setTtsOverrides({ cfg: CFG, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect((await api().get("/api/speak/voices").set(auth)).body).toEqual({ available: false, reason: "UNAVAILABLE", voices: [] });
    setTtsOverrides({ cfg: CFG, fetchImpl: (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch });
    expect((await api().get("/api/speak/voices").set(auth)).body.reason).toBe("UNAVAILABLE");
    setTtsOverrides({ cfg: CFG, fetchImpl: (async () => groqError(401, "invalid_api_key", "Invalid API Key")) as unknown as typeof fetch });
    expect((await api().get("/api/speak/voices").set(auth)).body.reason).toBe("UNAVAILABLE");
  });
});

describe("POST /api/speak", () => {
  it("returns a WAV data URL in the default voice", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    const r = await api().post("/api/speak").set(auth).send({ text: "  Good morning!  " });
    expect(r.status).toBe(200);
    expect(r.body.voice).toBe("autumn");
    expect(r.body.audio).toMatch(/^data:audio\/wav;base64,/);
    const wav = Buffer.from(r.body.audio.split(",")[1], "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(g.speechCalls()[0]!.body).toEqual({ model: "canopylabs/orpheus-v1-english", voice: "autumn", input: "Good morning!", response_format: "wav" });
  });

  it("accepts a chosen voice (case-insensitive) and rejects unknown ones with 400", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    const ok = await api().post("/api/speak").set(auth).send({ text: "Hello.", voice: "Daniel" });
    expect(ok.body.voice).toBe("daniel");
    const bad = await api().post("/api/speak").set(auth).send({ text: "Hello.", voice: "robot" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    expect(bad.body.error.details.voices).toContain("autumn");
    expect(g.speechCalls()).toHaveLength(1);
    // Schema validation.
    expect((await api().post("/api/speak").set(auth).send({ text: "   " })).body.error.code).toBe("VALIDATION_ERROR");
    expect((await api().post("/api/speak").set(auth).send({ text: "x".repeat(401) })).status).toBe(400);
  });

  it("returns 503 TTS_UNAVAILABLE without a key and when terms aren't accepted (no budget spent)", async () => {
    const { auth, user } = await registerUser();
    const noKey = await api().post("/api/speak").set(auth).send({ text: "Hi." });
    expect(noKey.status).toBe(503);
    expect(noKey.body.error).toMatchObject({ code: "TTS_UNAVAILABLE", details: { reason: "NO_KEY" } });
    expect(noKey.body.error.message).toMatch(/Groq API key/);

    useGroq({ terms: true });
    const terms = await api().post("/api/speak").set(auth).send({ text: "Hi." });
    expect(terms.status).toBe(503);
    expect(terms.body.error).toMatchObject({ code: "TTS_UNAVAILABLE", details: { reason: "TERMS_REQUIRED" } });
    expect(terms.body.error.message).toMatch(/terms/);
    expect(await ttsCallsFor(user.id)).toBe(0);
  });

  it("maps a Groq 429 to TTS_RATE_LIMITED with retryAfter, then fails fast until it passes", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    await api().get("/api/speak/voices").set(auth);
    g.state.rateLimited = true;
    const r = await api().post("/api/speak").set(auth).send({ text: "Hi there." });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("TTS_RATE_LIMITED");
    expect(r.body.error.details).toEqual({ retryAfter: 8, retryAfterMs: 8000 });
    const before = g.speechCalls().length;
    const again = await api().post("/api/speak").set(auth).send({ text: "Something else." });
    expect(again.status).toBe(429);
    expect(g.speechCalls()).toHaveLength(before); // didn't hit Groq
    g.state.rateLimited = false;
    g.clock.t += 9_000;
    expect((await api().post("/api/speak").set(auth).send({ text: "Something else." })).status).toBe(200);
  });

  it("serves repeats from the cache without calling Groq or spending budget", async () => {
    const g = useGroq();
    const { auth, user } = await registerUser();
    const a = await api().post("/api/speak").set(auth).send({ text: "Mm-hmm." });
    const b = await api().post("/api/speak").set(auth).send({ text: "Mm-hmm." });
    expect(b.body).toEqual(a.body);
    expect(g.speechCalls()).toHaveLength(1);
    expect(await ttsCallsFor(user.id)).toBe(1);
    // Different voice = different entry.
    await api().post("/api/speak").set(auth).send({ text: "Mm-hmm.", voice: "troy" });
    expect(g.speechCalls()).toHaveLength(2);
    // Another user hitting the same phrase is also free.
    const other = await registerUser();
    await api().post("/api/speak").set(other.auth).send({ text: "Mm-hmm." });
    expect(await ttsCallsFor(other.user.id)).toBe(0);
    expect(audioCache.size).toBe(2);
  });

  it("enforces the per-user daily TTS budget separately from the LLM budget", async () => {
    const g = useGroq();
    const { auth, user } = await registerUser();
    await UsageModel.create({ userId: user.id, day: new Date().toISOString().slice(0, 10), calls: 0, ttsCalls: 300, expiresAt: new Date(Date.now() + 86_400_000) });
    const r = await api().post("/api/speak").set(auth).send({ text: "Over the limit." });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("DAILY_LIMIT");
    expect(g.speechCalls()).toHaveLength(0);
    // The LLM budget is untouched.
    expect(await consumeDailyLlmCall(user.id)).toBe(1);
    // Another user is unaffected.
    const other = await registerUser();
    expect((await api().post("/api/speak").set(other.auth).send({ text: "Over the limit." })).status).toBe(200);
  });

  it("counts on usage docs created before the ttsCalls counter existed", async () => {
    useGroq();
    const { auth, user } = await registerUser();
    await UsageModel.collection.insertOne({ userId: new Types.ObjectId(user.id), day: new Date().toISOString().slice(0, 10), calls: 5, expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await api().post("/api/speak").set(auth).send({ text: "Legacy doc." })).status).toBe(200);
    const doc = await UsageModel.findOne({ userId: new Types.ObjectId(user.id) }).lean();
    expect(doc).toMatchObject({ calls: 5, ttsCalls: 1 });
  });

  it("splits text longer than the model limit and joins the WAVs", async () => {
    const g = useGroq({}, { maxInputChars: 40 });
    const { auth } = await registerUser();
    const text = "Good morning, Priya. You have three tasks today. Your budget for food is nearly used up.";
    const r = await api().post("/api/speak").set(auth).send({ text });
    expect(r.status).toBe(200);
    const inputs = g.speechCalls().map((c) => c.body.input);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((s) => s.length <= 40)).toBe(true);
    expect(inputs.join(" ")).toBe(text);
    const wav = parseWav(Buffer.from(r.body.audio.split(",")[1], "base64"))!;
    expect(wav.data.length).toBe(inputs.length * 8); // 4 samples x 2 bytes per chunk
  });

  it("returns 504 TTS_TIMEOUT when Groq hangs past the deadline", async () => {
    const hang = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.voice === PROBE_VOICE) return groqError(400, "invalid_voice", `voice must be one of [${VOICES.join(" ")}]`);
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    }) as unknown as typeof fetch;
    setTtsOverrides({ cfg: { ...CFG, timeoutMs: 50 }, fetchImpl: hang });
    const { auth } = await registerUser();
    const r = await api().post("/api/speak").set(auth).send({ text: "Hello." });
    expect(r.status).toBe(504);
    expect(r.body.error.code).toBe("TTS_TIMEOUT");
  });

  it("turns a model_terms_required during speak into 503 and refreshes the voice status", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    await api().get("/api/speak/voices").set(auth);
    g.state.terms = true;
    const r = await api().post("/api/speak").set(auth).send({ text: "Hi." });
    expect(r.status).toBe(503);
    expect((await api().get("/api/speak/voices").set(auth)).body.reason).toBe("TERMS_REQUIRED");
  });

  it("synthesizes every INTERRUPT_ACKS phrase", async () => {
    const g = useGroq();
    const { auth } = await registerUser();
    for (const text of INTERRUPT_ACKS) {
      const r = await api().post("/api/speak").set(auth).send({ text });
      expect(r.status).toBe(200);
    }
    expect(g.speechCalls().map((c) => c.body.input)).toEqual([...INTERRUPT_ACKS]);
  });

  it("keeps per-user rate limits separate", async () => {
    const limited = createApp({ rateLimit: true, speakPerMinute: 2 });
    const a = await registerUser();
    const b = await registerUser();
    const get = (auth: Record<string, string>) => request(limited).get("/api/speak/voices").set(auth);
    expect((await get(a.auth)).status).toBe(200);
    expect((await get(a.auth)).status).toBe(200);
    const third = await get(a.auth);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
    expect((await get(b.auth)).status).toBe(200);
  });
});

describe("speech helpers", () => {
  it("parses voice lists in several error formats", () => {
    // Exact Groq message (verified against the real API, 2026-10-30).
    expect(parseVoiceList("voice must be one of the following voices: [autumn diana hannah austin daniel troy]")).toEqual(VOICES);
    expect(parseVoiceList("voice must be one of [autumn diana hannah austin daniel troy]")).toEqual(VOICES);
    expect(parseVoiceList("Invalid voice 'nova-voice-probe'. Valid voices: 'autumn', 'diana', 'troy'")).toEqual(["autumn", "diana", "troy"]);
    expect(parseVoiceList("`voice` must be one of: autumn, diana, hannah.")).toEqual(["autumn", "diana", "hannah"]);
    expect(parseVoiceList("Invalid voice. Supported voices are autumn, diana and troy")).toEqual(["autumn", "diana", "troy"]);
    expect(parseVoiceList("something unrelated")).toEqual([]);
  });

  it("splits at sentence, then clause, then word boundaries", () => {
    expect(splitForTts("Short one.", 200)).toEqual(["Short one."]);
    expect(splitForTts("One two. Three four. Five six.", 20)).toEqual(["One two. Three four.", "Five six."]);
    expect(splitForTts("alpha beta, gamma delta, epsilon zeta", 15)).toEqual(["alpha beta,", "gamma delta,", "epsilon zeta"]);
    const long = splitForTts("word ".repeat(100).trim(), 30);
    expect(long.every((c) => c.length <= 30)).toBe(true);
    expect(long.join(" ")).toBe("word ".repeat(100).trim());
    expect(splitForTts("x".repeat(70), 30).map((c) => c.length)).toEqual([30, 30, 10]);
  });

  it("joins WAVs, including streamed ones with an unknown data size", () => {
    const streamed = makeWav(3, 7);
    streamed.writeUInt32LE(0xffffffff, 40);
    const joined = concatWav([makeWav(2, 1), streamed]);
    expect(joined.readUInt32LE(4)).toBe(joined.length - 8);
    const w = parseWav(joined)!;
    expect(w.data.length).toBe(10);
    expect(w.data.readInt16LE(8)).toBe(7);
    expect(() => concatWav([Buffer.from("nope")])).toThrow();
  });

  it("evicts least-recently-used entries by count and by bytes", () => {
    const c = new LruCache(2, 10);
    c.set("a", "111");
    c.set("b", "222");
    c.get("a");
    c.set("c", "333");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("111");
    c.set("d", "4444444");
    expect(c.totalBytes).toBeLessThanOrEqual(10);
    expect(c.get("d")).toBe("4444444");
    c.set("huge", "x".repeat(11));
    expect(c.get("huge")).toBeUndefined();
  });
});

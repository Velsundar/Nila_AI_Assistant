import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatLlm, parseDurationMs, rateLimitWaitMs, type ChatRequest, type ChatMessage } from "../agent/llm";
import { TOOL_DEFINITIONS } from "../agent/tools";
import { HISTORY_MESSAGES, runAgent, toolResultContent } from "../agent/agent";
import { ConversationModel } from "../models/Conversation";
import { UserModel } from "../models/User";
import { registerUser } from "../test/helpers";

const ctx = { timezone: "Asia/Kolkata", now: new Date(), userName: "T", assistantName: "Nila", currency: "INR", memories: [] };
const req: ChatRequest = { messages: [{ role: "user", content: "hi" }], tools: [], context: ctx };

const ok = (content = "hello") =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const limited = (headers: Record<string, string> = {}, body = { error: { message: "Rate limit reached" } }) =>
  new Response(JSON.stringify(body), { status: 429, headers: { "Content-Type": "application/json", ...headers } });

/** Fake fetch that answers per model. */
function byModel(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = vi.fn(async (_url: string, init: RequestInit) => {
    const model = JSON.parse(init.body as string).model as string;
    calls.push(model);
    const h = handlers[model];
    if (!h) throw new Error(`unexpected model ${model}`);
    return h();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("rate-limit parsing", () => {
  it("parses Groq-style durations", () => {
    expect(parseDurationMs("13.657s")).toBe(13657);
    expect(parseDurationMs("5m45.6s")).toBe(345600);
    expect(parseDurationMs("450ms")).toBe(450);
    expect(parseDurationMs("2")).toBe(2000);
    expect(parseDurationMs("1h2m")).toBe(3_720_000);
    expect(parseDurationMs("soon")).toBeUndefined();
  });

  it("prefers retry-after, then the body hint, then reset headers", () => {
    expect(rateLimitWaitMs(new Headers({ "retry-after": "4" }))).toBe(4000);
    expect(rateLimitWaitMs(new Headers({ "x-ratelimit-reset-tokens": "6.5s" }), "Please try again in 7.66s.")).toBe(7660);
    expect(rateLimitWaitMs(new Headers({ "x-ratelimit-reset-tokens": "6.5s" }))).toBe(6500);
    expect(
      rateLimitWaitMs(new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2m59.5s", "x-ratelimit-reset-tokens": "1s" })),
    ).toBe(179500);
    expect(rateLimitWaitMs(new Headers())).toBeUndefined();
  });
});

describe("model fallback chain", () => {
  it("defaults to gpt-oss-120b with the 20b and qwen fallbacks, low reasoning effort and a token cap", async () => {
    const f = byModel({ "openai/gpt-oss-120b": () => ok() });
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", fetchImpl: f.impl });
    expect(llm.model).toBe("openai/gpt-oss-120b");
    await llm.chat(req);
    const body = JSON.parse(((f.impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", reasoning_effort: "low", max_tokens: 700 });
  });

  it("moves to the next model on 429 and remembers the cooldown for later calls", async () => {
    const f = byModel({
      "openai/gpt-oss-120b": () => limited({ "retry-after": "30" }),
      "openai/gpt-oss-20b": () => ok("from 20b"),
    });
    const sleep = vi.fn(async () => {});
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", fetchImpl: f.impl, sleep });
    expect((await llm.chat(req)).content).toBe("from 20b");
    expect(f.calls).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    // Second turn skips the cooling-down model entirely.
    expect((await llm.chat(req)).content).toBe("from 20b");
    expect(f.calls).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-20b"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honours LLM_FALLBACK_MODELS order and skips a missing (404) model", async () => {
    const f = byModel({
      a: () => limited({ "retry-after": "60" }),
      gone: () => new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 }),
      c: () => ok("from c"),
    });
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["gone", "c"], fetchImpl: f.impl });
    expect((await llm.chat(req)).content).toBe("from c");
    expect(f.calls).toEqual(["a", "gone", "c"]);
  });

  it("waits once for a short retry-after when every model is limited", async () => {
    let n = 0;
    const f = byModel({
      a: () => (++n === 1 ? limited({ "retry-after": "2" }) : ok("after wait")),
      b: () => limited({ "retry-after": "40" }),
    });
    const sleep = vi.fn(async () => {});
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["b"], fetchImpl: f.impl, sleep });
    expect((await llm.chat(req)).content).toBe("after wait");
    expect(sleep).toHaveBeenCalledTimes(1);
    const waited = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(waited).toBeGreaterThan(1500);
    expect(waited).toBeLessThanOrEqual(2250);
    expect(f.calls).toEqual(["a", "b", "a"]);
  });

  it("gives up without waiting when the shortest wait is too long", async () => {
    const f = byModel({ a: () => limited({}, { error: { message: "Please try again in 45.2s." } }), b: () => limited({ "retry-after": "20" }) });
    const sleep = vi.fn(async () => {});
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["b"], fetchImpl: f.impl, sleep });
    await expect(llm.chat(req)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not fall back on auth errors", async () => {
    const f = byModel({ a: () => new Response("{}", { status: 401 }), b: () => ok() });
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["b"], fetchImpl: f.impl });
    await expect(llm.chat(req)).rejects.toMatchObject({ kind: "auth" });
    expect(f.calls).toEqual(["a"]);
  });

  it("strips <think> blocks from content", async () => {
    const f = byModel({ a: () => ok("<think>hmm</think>Sure thing.") });
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: [], fetchImpl: f.impl });
    expect((await llm.chat(req)).content).toBe("Sure thing.");
  });

  it("agent only gives the busy reply after every model is exhausted", async () => {
    const { user } = await registerUser();
    const doc = (await UserModel.findById(user.id))!;
    const busy = byModel({ a: () => limited({ "retry-after": "50" }), b: () => limited({ "retry-after": "50" }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r1 = await runAgent(doc, { message: "hello" }, { llm: createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["b"], fetchImpl: busy.impl }) });
    expect(r1.reply).toMatch(/busy/);
    const fine = byModel({ a: () => limited({ "retry-after": "50" }), b: () => ok("Hi there.") });
    const r2 = await runAgent(doc, { message: "hello" }, { llm: createOpenAiCompatLlm({ provider: "groq", apiKey: "k", model: "a", fallbackModels: ["b"], fetchImpl: fine.impl }) });
    warn.mockRestore();
    expect(r2.reply).toBe("Hi there.");
  });
});

describe("token diet", () => {
  it("tool schemas carry no validation noise, hidden args, or repeated category enums", () => {
    const json = JSON.stringify(TOOL_DEFINITIONS);
    for (const k of ["maxLength", "minLength", "exclusiveMinimum", "maximum", "additionalProperties", "maxItems"]) expect(json).not.toContain(`"${k}"`);
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.function.name, t.function.parameters as { properties: Record<string, { enum?: string[] }> }]));
    expect(byName.addExpense.properties.category.enum).toContain("Food");
    expect(byName.getSpendingSummary.properties.category.enum).toBeUndefined();
    expect(byName.manageTask.properties.ids).toBeUndefined();
    expect(byName.manageNote.properties.noteId).toBeUndefined();
    expect(byName.manageTask.properties.action.enum).toEqual(["add", "list", "complete", "delete"]);
    expect(json.length).toBeLessThan(5500);
  });

  it("lets optional tool args be null so Groq doesn't reject the call", () => {
    const params = TOOL_DEFINITIONS.find((t) => t.function.name === "getWeeklyReport")!.function.parameters as {
      properties: Record<string, { type: unknown }>;
    };
    expect(params.properties.weekStart.type).toEqual(["string", "null"]);
    const task = TOOL_DEFINITIONS.find((t) => t.function.name === "manageTask")!.function.parameters as {
      properties: Record<string, { type: unknown; enum?: unknown[] }>;
    };
    expect(task.properties.action.type).toBe("string");
    expect(task.properties.priority.enum).toContain(null);
  });

  it("truncates long tool results", () => {
    const s = toolResultContent({ big: "x".repeat(5000) });
    expect(s.length).toBeLessThan(1600);
    expect(s).toMatch(/truncated\)$/);
  });

  it("sends only the last few history messages", async () => {
    const { user } = await registerUser();
    const doc = (await UserModel.findById(user.id))!;
    const conv = await ConversationModel.create({
      userId: doc._id,
      messages: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
    });
    let seen: ChatMessage[] = [];
    const llm = {
      provider: "groq" as const,
      model: "fake",
      async chat(r: ChatRequest) {
        seen = r.messages;
        return { content: "ok", toolCalls: [] };
      },
    };
    await runAgent(doc, { message: "now", conversationId: conv._id.toString() }, { llm });
    expect(seen).toHaveLength(1 + HISTORY_MESSAGES + 1);
    expect(seen[1].content).toBe(`m${16 - HISTORY_MESSAGES}`);
    expect(seen[0].content).toMatch(/personal assistant for daily life/);
  });
});

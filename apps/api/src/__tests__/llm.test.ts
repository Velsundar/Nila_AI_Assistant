import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatLlm, friendlyLlmError, LlmError, type ChatRequest } from "../agent/llm";
import { TOOL_DEFINITIONS } from "../agent/tools";
import { runAgent } from "../agent/agent";
import { registerUser } from "../test/helpers";
import { UserModel } from "../models/User";

const ctx = { timezone: "Asia/Kolkata", now: new Date(), userName: "T", assistantName: "Nila", currency: "INR", memories: [] };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OpenAI-compatible provider", () => {
  it("sends a spec-compliant tools request and parses tool_calls", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "addExpense", arguments: '{"amount":250,"category":"Food"}' } }],
            },
          },
        ],
      }),
    );
    const llm = createOpenAiCompatLlm({ provider: "groq", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(llm.model).toBe("openai/gpt-oss-120b");
    const req: ChatRequest = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "spent 250" },
        { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "getBudgets", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c0", name: "getBudgets", content: '{"budgets":[]}' },
      ],
      tools: TOOL_DEFINITIONS,
      context: ctx,
    };
    const out = await llm.chat(req);
    expect(out.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "addExpense", arguments: '{"amount":250,"category":"Food"}' } }]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "addExpense", parameters: { type: "object" } } });
    expect(body.tools[0].function.parameters.properties.category.enum).toContain("Food");
    expect(body.tools[0].function.parameters.required).toEqual(["amount", "category"]);
    expect(body.messages[2]).toEqual({ role: "assistant", content: "", tool_calls: req.messages[2].role === "assistant" ? req.messages[2].tool_calls : [] });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c0", content: '{"budgets":[]}' }); // no name for groq
  });

  it("uses provider defaults and includes tool name for gemini", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    const llm = createOpenAiCompatLlm({ provider: "gemini", apiKey: "g", fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await llm.chat({ messages: [{ role: "tool", tool_call_id: "x", name: "getBudgets", content: "{}" }], tools: [], context: ctx });
    expect(out).toEqual({ content: "hi", toolCalls: [] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gemini-2.0-flash");
    expect(body.messages[0].name).toBe("getBudgets");
    expect(body.tools).toBeUndefined();
  });

  it("ollama sends no Authorization header; LLM_MODEL override works", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const llm = createOpenAiCompatLlm({ provider: "ollama", model: "qwen2.5", fetchImpl: fetchImpl as unknown as typeof fetch });
    await llm.chat({ messages: [{ role: "user", content: "hi" }], tools: [], context: ctx });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string).model).toBe("qwen2.5");
  });

  it("maps 429 / network / 401 to LlmError kinds", async () => {
    const mk = (impl: () => Promise<Response>) =>
      createOpenAiCompatLlm({ provider: "openrouter", apiKey: "k", fetchImpl: vi.fn(impl) as unknown as typeof fetch });
    const req: ChatRequest = { messages: [{ role: "user", content: "x" }], tools: [], context: ctx };
    await expect(mk(async () => jsonResponse({ error: "slow down" }, 429)).chat(req)).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(mk(async () => jsonResponse({}, 401)).chat(req)).rejects.toMatchObject({ kind: "auth" });
    await expect(mk(async () => { throw new TypeError("fetch failed"); }).chat(req)).rejects.toMatchObject({ kind: "network" });
    expect(friendlyLlmError(new LlmError("rate_limit", "x"))).toMatch(/try again in a minute/);
  });

  it("agent returns a friendly spoken reply (not a 500) when the provider rate-limits", async () => {
    const { user } = await registerUser();
    const doc = (await UserModel.findById(user.id))!;
    const llm = createOpenAiCompatLlm({
      provider: "groq",
      apiKey: "k",
      fetchImpl: vi.fn(async () => jsonResponse({ error: { message: "rate limited" } }, 429)) as unknown as typeof fetch,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await runAgent(doc, { message: "spent 250 on lunch" }, { llm });
    warn.mockRestore();
    expect(res.reply).toMatch(/try again in a minute/);
    expect(res.actions).toEqual([]);
  });

  it("agent loop returns invalid tool args to the model and continues", async () => {
    const { user } = await registerUser();
    const doc = (await UserModel.findById(user.id))!;
    const seen: ChatRequest[] = [];
    let call = 0;
    const llm = {
      provider: "groq" as const,
      model: "fake",
      async chat(req: ChatRequest) {
        seen.push(structuredClone({ messages: req.messages }) as ChatRequest);
        call++;
        if (call === 1) return { content: null, toolCalls: [{ id: "a", type: "function" as const, function: { name: "addExpense", arguments: '{"amount":"abc","category":"Food"}' } }] };
        if (call === 2) return { content: null, toolCalls: [{ id: "b", type: "function" as const, function: { name: "addExpense", arguments: '{"amount":"250","category":"food","merchant":null}' } }] };
        return { content: "**Added** ₹250 for food 🍔", toolCalls: [] };
      },
    };
    const res = await runAgent(doc, { message: "spent 250 on food" }, { llm });
    const firstToolMsg = seen[1].messages.at(-1) as { role: string; content: string };
    expect(firstToolMsg.role).toBe("tool");
    expect(firstToolMsg.content).toMatch(/Invalid arguments: amount/);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ tool: "addExpense", ok: true, args: { amount: 250, category: "Food" } });
    expect(res.reply).toBe("Added ₹250 for food"); // markdown + emoji stripped for TTS
    expect(seen[0].messages[0].content).toMatch(/Never do arithmetic/);
  });

  it("caps the tool loop at 5 iterations", async () => {
    const { user } = await registerUser();
    const doc = (await UserModel.findById(user.id))!;
    let calls = 0;
    const llm = {
      provider: "groq" as const,
      model: "fake",
      async chat() {
        calls++;
        return { content: null, toolCalls: [{ id: `c${calls}`, type: "function" as const, function: { name: "getBudgets", arguments: "{}" } }] };
      },
    };
    const res = await runAgent(doc, { message: "loop" }, { llm });
    expect(calls).toBe(5);
    expect(res.actions).toHaveLength(5);
    expect(res.reply).toBe("Done.");
  });
});

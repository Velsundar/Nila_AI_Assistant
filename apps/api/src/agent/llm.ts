import { config, type LlmProviderName } from "../config";
import { createMockLlm } from "./mock";

// ---- OpenAI Chat Completions wire types (subset) ----

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string; name?: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Extra context only the mock provider uses (real providers get the same info via the system prompt). */
export type LlmContext = {
  timezone: string;
  now: Date;
  userName: string;
  assistantName: string;
  currency: string;
  memories: string[];
};

export type ChatRequest = { messages: ChatMessage[]; tools: ToolDefinition[]; context: LlmContext };
export type ChatResult = { content: string | null; toolCalls: ToolCall[] };

export interface LlmClient {
  provider: LlmProviderName;
  model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export type LlmErrorKind = "rate_limit" | "auth" | "network" | "server" | "bad_request" | "bad_response";

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

// ---- Provider registry ----

const PROVIDER_DEFAULTS: Record<Exclude<LlmProviderName, "mock">, { baseUrl: string; model: string }> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
};

export type OpenAiCompatOptions = {
  provider: Exclude<LlmProviderName, "mock">;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** One implementation of the OpenAI-compatible Chat Completions API with tool calling, via plain fetch. */
export function createOpenAiCompatLlm(opts: OpenAiCompatOptions): LlmClient {
  const defaults = PROVIDER_DEFAULTS[opts.provider];
  const baseUrl = (opts.baseUrl ?? defaults.baseUrl).replace(/\/+$/, "");
  const model = opts.model ?? defaults.model;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  function wireMessages(messages: ChatMessage[]) {
    return messages.map((m) => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content ?? "",
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        };
      }
      if (m.role === "tool") {
        // Gemini's compat layer wants the function name on tool results; others don't need it.
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: m.content,
          ...(opts.provider === "gemini" && m.name ? { name: m.name } : {}),
        };
      }
      return m;
    });
  }

  async function once(req: ChatRequest): Promise<ChatResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    if (opts.provider === "openrouter") {
      headers["HTTP-Referer"] = "http://localhost:3000";
      headers["X-Title"] = "Nova";
    }
    const body = {
      model,
      messages: wireMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
      max_tokens: 512,
    };

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new LlmError("network", `LLM request failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 429) throw new LlmError("rate_limit", "LLM rate limit exceeded", 429);
      if (res.status === 401 || res.status === 403) throw new LlmError("auth", "LLM API key rejected", res.status);
      if (res.status >= 500) throw new LlmError("server", `LLM server error ${res.status}`, res.status);
      throw new LlmError("bad_request", `LLM request rejected (${res.status}): ${text.slice(0, 300)}`, res.status);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new LlmError("bad_response", "LLM returned invalid JSON");
    }
    // Gemini's compat endpoint sometimes wraps the body in an array.
    const payload = (Array.isArray(data) ? data[0] : data) as {
      choices?: { message?: { content?: string | null; tool_calls?: Partial<ToolCall>[] } }[];
    };
    const msg = payload?.choices?.[0]?.message;
    if (!msg) throw new LlmError("bad_response", "LLM response had no choices");

    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc) => tc?.function?.name)
      .map((tc, i) => ({
        id: tc.id || `call_${Date.now().toString(36)}_${i}`,
        type: "function" as const,
        function: {
          name: tc.function!.name,
          arguments:
            typeof tc.function!.arguments === "string"
              ? tc.function!.arguments
              : JSON.stringify(tc.function!.arguments ?? {}),
        },
      }));
    return { content: typeof msg.content === "string" ? msg.content : null, toolCalls };
  }

  return {
    provider: opts.provider,
    model,
    async chat(req) {
      try {
        return await once(req);
      } catch (e) {
        // Groq returns 400 "tool_use_failed" when the model emits a malformed tool call; one retry usually fixes it.
        if (e instanceof LlmError && e.kind === "bad_request" && /tool_use_failed|failed_generation/i.test(e.message)) {
          return once(req);
        }
        throw e;
      }
    },
  };
}

let cached: LlmClient | undefined;

export function getLlmClient(): LlmClient {
  if (cached) return cached;
  const { provider, apiKey, model, baseUrl } = config.llm;
  cached = provider === "mock" ? createMockLlm() : createOpenAiCompatLlm({ provider, apiKey, model, baseUrl });
  return cached;
}

export function friendlyLlmError(e: unknown): string {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case "rate_limit":
        return "I'm getting a lot of requests right now. Please try again in a minute.";
      case "auth":
        return "My language service rejected the API key. Please check the server configuration.";
      case "network":
        return "I can't reach my language service right now. Please check the connection and try again.";
      default:
        return "Sorry, my language service had a problem. Please try again.";
    }
  }
  return "Sorry, something went wrong on my side. Please try again.";
}

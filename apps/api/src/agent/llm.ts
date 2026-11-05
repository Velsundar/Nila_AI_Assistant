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
  /** User's home city, if set. */
  city?: string;
  now: Date;
  userName: string;
  assistantName: string;
  currency: string;
  memories: string[];
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  context: LlmContext;
  /** Epoch ms after which no further request, fallback or retry is started. */
  deadline?: number;
};
export type ChatResult = { content: string | null; toolCalls: ToolCall[] };

export interface LlmClient {
  provider: LlmProviderName;
  model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export type LlmErrorKind =
  | "rate_limit"
  | "auth"
  | "network"
  | "server"
  | "bad_request"
  | "bad_response"
  | "model_unavailable"
  | "timeout";

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
    /** For rate_limit: how long the provider asked us to wait, if it said. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

// ---- Provider registry ----

export const PROVIDER_DEFAULTS: Record<
  Exclude<LlmProviderName, "mock">,
  { baseUrl: string; model: string; fallbackModels: string[]; visionModel?: string }
> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    fallbackModels: ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    visionModel: "qwen/qwen3.8-27b",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    fallbackModels: [],
    visionModel: "gemini-2.0-flash",
  },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", fallbackModels: [] },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", fallbackModels: [] },
};

/** Longest rate-limit wait we sit through before giving up (all models exhausted). */
export const MAX_RETRY_WAIT_MS = 8_000;
/** Cool-down applied to a rate-limited model when the provider gives no hint. */
const DEFAULT_COOLDOWN_MS = 20_000;
export const MAX_COMPLETION_TOKENS = 700;

/** Parse "13.657s", "5m45.6s", "1h2m", "450ms" or a bare number of seconds into ms. */
export function parseDurationMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

/** How long a 429 says to wait: retry-after, then x-ratelimit-reset-*, then "try again in 7.6s" in the body. */
export function rateLimitWaitMs(headers: Headers, bodyText = ""): number | undefined {
  const ra = headers.get("retry-after");
  if (ra) {
    const n = parseDurationMs(ra);
    if (n !== undefined) return n;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const fromBody = parseDurationMs(/try again in ([\dhms.]+)/i.exec(bodyText)?.[1]);
  if (headers.get("x-ratelimit-remaining-requests") === "0") {
    return parseDurationMs(headers.get("x-ratelimit-reset-requests")) ?? fromBody;
  }
  return fromBody ?? parseDurationMs(headers.get("x-ratelimit-reset-tokens"));
}

/** Per-model request extras: keep reasoning models cheap and their thinking out of the reply. */
function modelExtras(provider: string, model: string): Record<string, unknown> {
  if (provider !== "groq") return {};
  if (/gpt-oss/.test(model)) return { reasoning_effort: "low", include_reasoning: false };
  if (/qwen3/.test(model)) return { reasoning_format: "hidden" };
  return {};
}

export type OpenAiCompatOptions = {
  provider: Exclude<LlmProviderName, "mock">;
  apiKey?: string;
  model?: string;
  /** Tried in order after `model` on 429 / missing model / 5xx. Defaults per provider. */
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  maxRetryWaitMs?: number;
  /** Logs prompt/completion token usage per call (off in tests). */
  logUsage?: boolean;
};

/** Strip <think>…</think> blocks some reasoning models leave in content. */
export function stripThinking(s: string | null): string | null {
  if (s == null) return s;
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
}

/** One implementation of the OpenAI-compatible Chat Completions API with tool calling, via plain fetch. */
export function createOpenAiCompatLlm(opts: OpenAiCompatOptions): LlmClient {
  const defaults = PROVIDER_DEFAULTS[opts.provider];
  const baseUrl = (opts.baseUrl ?? defaults.baseUrl).replace(/\/+$/, "");
  const model = opts.model ?? defaults.model;
  const models = [model, ...(opts.fallbackModels ?? defaults.fallbackModels)].filter((m, i, a) => m && a.indexOf(m) === i);
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  /** model -> epoch ms until which it is known to be rate-limited (shared across turns). */
  const cooldownUntil = new Map<string, number>();

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

  async function once(req: ChatRequest, useModel: string): Promise<ChatResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    if (opts.provider === "openrouter") {
      headers["HTTP-Referer"] = "http://localhost:3000";
      headers["X-Title"] = "Nila";
    }
    const body = {
      model: useModel,
      messages: wireMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
      max_tokens: MAX_COMPLETION_TOKENS,
      ...modelExtras(opts.provider, useModel),
    };

    const budget = req.deadline !== undefined ? Math.min(timeoutMs, req.deadline - Date.now()) : timeoutMs;
    if (budget <= 0) throw new LlmError("timeout", "LLM deadline exceeded");
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budget),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new LlmError("timeout", "LLM request timed out");
      throw new LlmError("network", `LLM request failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Groq answers 413 when one request is bigger than the per-minute token budget.
      if (res.status === 429 || (res.status === 413 && /rate.?limit|tokens per minute|TPM/i.test(text))) {
        throw new LlmError("rate_limit", "LLM rate limit exceeded", res.status, rateLimitWaitMs(res.headers, text));
      }
      if (res.status === 401 || res.status === 403) throw new LlmError("auth", "LLM API key rejected", res.status);
      if (res.status >= 500) throw new LlmError("server", `LLM server error ${res.status}`, res.status);
      if (res.status === 404 || /model_not_found|decommissioned|does not exist/i.test(text)) {
        throw new LlmError("model_unavailable", `Model ${useModel} is not available`, res.status);
      }
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
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (opts.logUsage && payload?.usage) {
      const u = payload.usage;
      console.log(
        `[llm] ${opts.provider} ${useModel} prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens} ` +
          `remaining=${res.headers.get("x-ratelimit-remaining-tokens") ?? "?"}`,
      );
    }
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
    return { content: typeof msg.content === "string" ? stripThinking(msg.content) : null, toolCalls };
  }

  async function onceWithToolRetry(req: ChatRequest, useModel: string): Promise<ChatResult> {
    try {
      return await once(req, useModel);
    } catch (e) {
      // Groq returns 400 "tool_use_failed" when the model emits a malformed tool call; one retry usually fixes it.
      if (e instanceof LlmError && e.kind === "bad_request" && /tool_use_failed|failed_generation/i.test(e.message)) {
        return once(req, useModel);
      }
      throw e;
    }
  }

  return {
    provider: opts.provider,
    model,
    async chat(req) {
      let lastErr: LlmError | undefined;
      let rateErr: LlmError | undefined;
      // Round 1: walk the chain, skipping models known to be cooling down.
      // Round 2 (only if every model is limited): wait for the soonest one if that's short, then retry it.
      for (let round = 0; round < 2; round++) {
        let soonest: { model: string; wait: number } | undefined;
        for (const m of models) {
          if (req.deadline !== undefined && Date.now() >= req.deadline) {
            throw rateErr ?? lastErr ?? new LlmError("timeout", "LLM deadline exceeded");
          }
          const wait = (cooldownUntil.get(m) ?? 0) - Date.now();
          if (wait > 0) {
            if (!soonest || wait < soonest.wait) soonest = { model: m, wait };
            rateErr ??= new LlmError("rate_limit", "LLM rate limit exceeded", 429, wait);
            continue;
          }
          try {
            const out = await onceWithToolRetry(req, m);
            cooldownUntil.delete(m);
            return out;
          } catch (e) {
            if (!(e instanceof LlmError)) throw e;
            if (e.kind === "rate_limit") {
              const w = e.retryAfterMs ?? DEFAULT_COOLDOWN_MS;
              cooldownUntil.set(m, Date.now() + w);
              if (!soonest || w < soonest.wait) soonest = { model: m, wait: w };
              if (opts.logUsage) console.warn(`[llm] ${m} rate-limited (wait ${Math.round(w / 100) / 10}s), trying next model`);
              rateErr = e;
              continue;
            }
            if (e.kind === "timeout") throw e;
            if (e.kind === "model_unavailable" || e.kind === "server" || e.kind === "network") {
              if (opts.logUsage) console.warn(`[llm] ${m} failed (${e.message}), trying next model`);
              lastErr = e;
              continue;
            }
            throw e;
          }
        }
        const fitsDeadline = req.deadline === undefined || Date.now() + (soonest?.wait ?? 0) + 1_000 < req.deadline;
        if (round === 0 && soonest && soonest.wait <= maxRetryWaitMs && fitsDeadline) {
          await sleep(soonest.wait + 250);
          cooldownUntil.delete(soonest.model);
          continue;
        }
        break;
      }
      throw rateErr ?? lastErr ?? new LlmError("rate_limit", "LLM rate limit exceeded", 429);
    },
  };
}

let cached: LlmClient | undefined;

export function getLlmClient(): LlmClient {
  if (cached) return cached;
  const { provider, apiKey, model, baseUrl, fallbackModels } = config.llm;
  cached =
    provider === "mock"
      ? createMockLlm()
      : createOpenAiCompatLlm({ provider, apiKey, model, baseUrl, fallbackModels, logUsage: !config.isTest });
  return cached;
}

export function friendlyLlmError(e: unknown): string {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case "rate_limit":
        return "I'm a little busy right now. Please try again in a minute.";
      case "auth":
        return "My language service rejected the API key. Please check the server configuration.";
      case "network":
        return "I can't reach my language service right now. Please check the connection and try again.";
      case "timeout":
        return "That took too long on my side. Please try again.";
      default:
        return "Sorry, my language service had a problem. Please try again.";
    }
  }
  return "Sorry, something went wrong on my side. Please try again.";
}

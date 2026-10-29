import "dotenv/config";

export type LlmProviderName = "groq" | "gemini" | "openrouter" | "ollama" | "mock";
const PROVIDERS: LlmProviderName[] = ["groq", "gemini", "openrouter", "ollama", "mock"];

function resolveProvider(): LlmProviderName {
  const raw = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  const key = process.env.LLM_API_KEY?.trim();
  if (!raw) return key ? "groq" : "mock";
  if (!PROVIDERS.includes(raw as LlmProviderName)) {
    console.warn(`[config] Unknown LLM_PROVIDER "${raw}", falling back to mock`);
    return "mock";
  }
  if (raw !== "mock" && raw !== "ollama" && !key) {
    console.warn(`[config] LLM_PROVIDER=${raw} but no LLM_API_KEY set, falling back to mock`);
    return "mock";
  }
  return raw as LlmProviderName;
}

function list(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined; // unset -> provider default
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;
const isProduction = process.env.NODE_ENV === "production";

export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * JWT secret: required (>= 32 chars) everywhere except tests. There is deliberately no fallback,
 * so a missing secret can never silently become a public, guessable one.
 */
export function resolveJwtSecret(raw: string | undefined, test: boolean): string {
  const secret = raw?.trim() ?? "";
  if (secret.length >= MIN_JWT_SECRET_LENGTH) return secret;
  if (test) return secret || "test-only-jwt-secret-not-for-real-use";
  throw new Error(
    `JWT_SECRET must be set to at least ${MIN_JWT_SECRET_LENGTH} characters (e.g. \`openssl rand -hex 32\`). Refusing to start.`,
  );
}

/** Local dev origins only outside production; deployments list theirs in CORS_ORIGINS. */
export function buildCorsOrigins(production: boolean, extra: string | undefined): string[] {
  return [
    ...(production ? [] : ["http://localhost:3000", "http://localhost:8081"]),
    ...(extra ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const config = {
  isTest,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nova",
  isProduction,
  jwtSecret: resolveJwtSecret(process.env.JWT_SECRET, isTest),
  jwtExpiresIn: "7d",
  corsOrigins: buildCorsOrigins(isProduction, process.env.CORS_ORIGINS),
  llm: {
    provider: resolveProvider(),
    apiKey: process.env.LLM_API_KEY?.trim() || undefined,
    model: process.env.LLM_MODEL?.trim() || undefined,
    baseUrl: process.env.LLM_BASE_URL?.trim() || undefined,
    /** Comma-separated models tried in order when the primary one is rate-limited (each has its own token bucket). */
    fallbackModels: list(process.env.LLM_FALLBACK_MODELS),
    /** Vision-capable model for receipt scanning (empty string disables it). */
    visionModel: process.env.LLM_VISION_MODEL?.trim(),
    /** Speech-to-text model (Groq Whisper). */
    sttModel: process.env.STT_MODEL?.trim() || "whisper-large-v3-turbo",
    /** Provider calls (agent LLM calls, receipt vision, Whisper) per user per UTC day. */
    dailyCallLimit: positiveInt(process.env.LLM_DAILY_CALL_LIMIT, 200),
    /** Overall deadline for one /api/agent request across iterations, fallbacks and retries. */
    agentDeadlineMs: positiveInt(process.env.AGENT_DEADLINE_MS, 45_000),
  },
  defaultTimezone: "Asia/Kolkata",
};


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

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export const config = {
  isTest,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nova",
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret-change-me",
  jwtExpiresIn: "30d",
  corsOrigins: [
    "http://localhost:3000",
    "http://localhost:8081",
    ...(process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
  llm: {
    provider: resolveProvider(),
    apiKey: process.env.LLM_API_KEY?.trim() || undefined,
    model: process.env.LLM_MODEL?.trim() || undefined,
    baseUrl: process.env.LLM_BASE_URL?.trim() || undefined,
  },
  defaultTimezone: "Asia/Kolkata",
};

if (!process.env.JWT_SECRET && !isTest && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be set in production");
}

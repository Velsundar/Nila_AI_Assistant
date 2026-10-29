import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { errorHandler, HttpError } from "./errors";
import { requireAuth } from "./middleware/auth";
import { authRouter } from "./routes/auth";
import { expensesRouter } from "./routes/expenses";
import { budgetsRouter } from "./routes/budgets";
import { remindersRouter } from "./routes/reminders";
import { agentRouter } from "./routes/agent";
import type { LlmClient } from "./agent/llm";

export type AppOptions = {
  /** Disable rate limiting (tests). Defaults to off under NODE_ENV=test. */
  rateLimit?: boolean;
  /** Override the LLM client (tests). */
  getLlm?: () => LlmClient;
};

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, please slow down" } });
    },
  });
}

export function createApp(opts: AppOptions = {}) {
  const app = express();
  const useLimits = opts.rateLimit ?? !config.isTest;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow non-browser clients (curl, native mobile) that send no Origin.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      allowedHeaders: ["Content-Type", "Authorization", "X-Timezone"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86400,
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  if (useLimits) app.use("/api", limiter(60_000, 300));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", ...(useLimits ? [limiter(15 * 60_000, 30)] : []), authRouter);
  app.use("/api/expenses", requireAuth, expensesRouter);
  app.use("/api/budgets", requireAuth, budgetsRouter);
  app.use("/api/reminders", requireAuth, remindersRouter);
  app.use("/api/agent", ...(useLimits ? [limiter(60_000, 20)] : []), requireAuth, agentRouter(opts.getLlm));

  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Route not found")));
  app.use(errorHandler);
  return app;
}

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
import { tasksRouter } from "./routes/tasks";
import { notesRouter } from "./routes/notes";
import { incomeRouter } from "./routes/income";
import { briefingRouter, reportsRouter } from "./routes/insights";
import { receiptsRouter, transcribeRouter } from "./routes/media";
import { speakRouter } from "./routes/speak";
import type { LlmClient } from "./agent/llm";

export type AppOptions = {
  /** Disable rate limiting (tests). Defaults to off under NODE_ENV=test. */
  rateLimit?: boolean;
  /** Override the LLM client (tests). */
  getLlm?: () => LlmClient;
  /** Per-user requests per minute to /api/speak* (default TTS_RATE_LIMIT_PER_MIN, 60). */
  speakPerMinute?: number;
};

function limiter(windowMs: number, limit: number, perUser = false) {
  return rateLimit({
    windowMs,
    limit,
    // Per-user limits run after requireAuth, so one account can't spread its quota across IPs
    // and users behind one NAT don't share a bucket.
    ...(perUser ? { keyGenerator: (req: express.Request) => `u:${req.userId ?? req.ip}` } : {}),
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
  if (useLimits) app.use("/api", limiter(60_000, 300));

  // Large-body routes: authenticate first, then parse with a route-specific limit. The global 100 kB
  // parser below skips requests whose body was already parsed.
  const mediaLimits = useLimits ? [limiter(60_000, 20, true)] : [];
  app.use("/api/receipts", requireAuth, ...mediaLimits, express.json({ limit: "6mb" }), receiptsRouter);
  app.use("/api/transcribe", requireAuth, ...mediaLimits, express.json({ limit: "14mb" }), transcribeRouter);

  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", ...(useLimits ? [limiter(15 * 60_000, 30)] : []), authRouter);
  app.use("/api/expenses", requireAuth, expensesRouter);
  app.use("/api/income", requireAuth, incomeRouter);
  app.use("/api/budgets", requireAuth, budgetsRouter);
  app.use("/api/reminders", requireAuth, remindersRouter);
  app.use("/api/tasks", requireAuth, tasksRouter);
  app.use("/api/notes", requireAuth, notesRouter);
  app.use("/api/briefing", requireAuth, briefingRouter);
  app.use("/api/reports", requireAuth, reportsRouter);
  app.use("/api/speak", requireAuth, ...(useLimits ? [limiter(60_000, opts.speakPerMinute ?? config.tts.ratePerMinute, true)] : []), speakRouter);
  app.use("/api/agent", requireAuth, ...(useLimits ? [limiter(60_000, 20, true)] : []), agentRouter(opts.getLlm));

  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Route not found")));
  app.use(errorHandler);
  return app;
}

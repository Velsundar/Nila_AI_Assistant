# @nova/api

Backend for **Nova**, the voice-first expense tracker and personal assistant. Express + TypeScript (run with `tsx`), MongoDB via Mongoose 8, JWT auth, and an LLM tool-calling agent. Everything runs at ₹0: local MongoDB (or Atlas M0), and either the built-in offline "mock" brain or a free-tier LLM.

The contract (routes, request/response types) lives in `packages/shared` and `docs/API.md`.

## Quick start

```bash
# from the repo root
pnpm install
cp apps/api/.env.example apps/api/.env      # optional, defaults work locally

# MongoDB 7 on localhost:27017 (skip if one is already running)
mkdir -p apps/api/.data/db
mongod --dbpath apps/api/.data/db --port 27017 --fork --logpath apps/api/.data/mongod.log

pnpm --filter @nova/api seed        # demo@nova.app / password123 + ~2 months of INR expenses
pnpm --filter @nova/api dev         # http://localhost:4000 (tsx watch)
```

| Script | What it does |
|---|---|
| `dev` | `tsx watch src/server.ts`, port from `PORT` (default 4000) |
| `start` | Same, no watch |
| `typecheck` | `tsc --noEmit` (strict) |
| `test` | Vitest + supertest against the `nova_test` database (needs MongoDB running) |
| `seed` | Recreates the demo user and its data. Other users are untouched. |

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/nova` | Use a MongoDB Atlas M0 (free) URI when deploying |
| `JWT_SECRET` | dev-only fallback | **Required in production.** Long random string, e.g. `openssl rand -hex 32` |
| `PORT` | `4000` | |
| `LLM_PROVIDER` | `mock` if no key, else `groq` | `mock`, `groq`, `gemini`, `openrouter` or `ollama` |
| `LLM_API_KEY` | empty | Without a key the server always uses `mock`, except for `ollama` |
| `LLM_MODEL` | provider default | Overrides the model name |
| `LLM_BASE_URL` | provider default | Points at any OpenAI-compatible endpoint |
| `CORS_ORIGINS` | empty | Extra comma-separated origins. `http://localhost:3000` and `http://localhost:8081` are always allowed |

Tests use `MONGODB_TEST_URI` (default `mongodb://127.0.0.1:27017/nova_test`). The setup refuses to run against a database whose name doesn't contain "test".

## LLM providers

The agent speaks the OpenAI Chat Completions API with tool calling, using plain `fetch` (`src/agent/llm.ts`). That one implementation covers every hosted provider:

| `LLM_PROVIDER` | Base URL | Default model | Free? |
|---|---|---|---|
| `mock` | none (runs in-process) | rule-based parser | Always free, works offline. Default with no key, and used by all tests |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Free tier, very fast |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | Free tier |
| `openrouter` | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` | `:free` models cost nothing |
| `ollama` | `http://localhost:11434/v1` | `llama3.1` | Local, no key (`ollama pull llama3.1`) |

### Getting a free key

- **Groq (recommended):** sign in at <https://console.groq.com>, open **API Keys**, then **Create API Key**. Set `LLM_PROVIDER=groq` and `LLM_API_KEY=gsk_...`. No credit card is needed. Free-tier rate limits apply, and a 429 comes back to the user as a spoken "try again in a minute".
- **Google Gemini:** go to <https://aistudio.google.com/app/apikey> and click **Create API key**. Set `LLM_PROVIDER=gemini` and `LLM_API_KEY=AIza...`.
- **OpenRouter:** get a key at <https://openrouter.ai/keys> and use a model ending in `:free`.

Provider failures (429, auth, network, 5xx, timeouts) never surface as a 500. `/api/agent` still returns 200 with a short spoken explanation in `reply`.

### The mock provider

`src/agent/mock.ts` is a deterministic regex and keyword parser. It emits the same tool calls a real model would, then writes the reply from the tool results. It understands phrases like:

- "spent 250 on lunch at swiggy", "paid 1200 for uber yesterday", "2k on shoes at myntra 3 days ago"
- "how much did I spend on food this month", "how much did I spend last month", "total spending today"
- "set food budget to 5000", "what are my budgets"
- "delete my last expense", "remove the swiggy expense", "change my last expense to 300"
- "remind me to pay rent on the 5th", "remind me to call mom tomorrow at 6pm", "what are my reminders"
- "remember that I'm vegetarian", "what do you know about me", "show my recent expenses"

## How the agent works (`POST /api/agent`)

1. It loads the user, their memories and the last 10 conversation messages.
2. It builds a system prompt with:
   - the persona, named after `user.assistantName`
   - today's date and time in the request `timezone` (default `Asia/Kolkata`)
   - spoken-style rules: no markdown or emojis, amounts written like ₹250
   - a hard rule that the model never does arithmetic
3. It calls the LLM with these tool definitions: `addExpense`, `listRecentExpenses`, `getSpendingSummary`, `updateExpense`, `deleteExpense`, `setBudget`, `getBudgets`, `createReminder`, `listReminders` and `rememberFact`. The JSON Schemas are generated from Zod with `zod-to-json-schema`.
4. Each tool call's arguments are validated with Zod. Invalid arguments go back to the model as a `role: "tool"` error, and the loop continues for at most 5 iterations.
5. All totals and budget figures come from MongoDB aggregations. `addExpense` returns the category's budget status, so Nova can say things like "you've used 82% of your Food budget".
6. **Destructive tools (`deleteExpense`, `updateExpense`) are never run directly.** The server works out which expense is meant and stores `pendingAction` on the conversation. It then returns `pendingConfirmation: { summary }` with a reply like "Delete ₹250 at Swiggy from today? Say yes or no." The user's next message is handled as follows:
   - **affirmative** (yes, yeah, haan, ok, confirm, do it…): the action runs.
   - **negative** (no, nahi, cancel…): the action is cancelled.
   - **anything else:** the pending action is cleared and the message is handled as a new request.
7. The reply is cleaned up for TTS and the conversation is saved (capped at 20 messages). The response is `{ reply, conversationId, actions, pendingConfirmation? }`.

## Implementation notes

- Every query is scoped to the authenticated user's `userId`. Another user's ids return 404, and a test covers this.
- `GET /api/expenses/summary` and budget `spent` use aggregation pipelines (`$match` → `$facet`/`$group`), with `byDay` grouped in the user's timezone. The default range is the current calendar month.
- A date-only string like `"2026-10-30"` is stored as noon local time, so it always lands on the right calendar day.
- Not in the contract, but optional: an `X-Timezone` header or `?tz=` query param changes the timezone for REST range defaults. The default is `Asia/Kolkata`.
- Rate limits: 300 requests/min across `/api`, 30 per 15 minutes on `/api/auth`, and 20/min on `/api/agent`. They are disabled under tests.
- The package runs as CommonJS under `tsx`, because `@nova/shared` is TypeScript source with no `"type": "module"`.

## Deploying for free

- **Database:** MongoDB Atlas M0 (free forever, 512 MB). Create a cluster, add a database user, allow your host's IP, and set `MONGODB_URI=mongodb+srv://...`.
- **API host:** any free Node host (Render free web service, Koyeb, Fly.io free allowance). Use `pnpm --filter @nova/api start` as the start command, and set `JWT_SECRET`, `MONGODB_URI`, `LLM_PROVIDER`, `LLM_API_KEY` and `CORS_ORIGINS` (your web app's URL).

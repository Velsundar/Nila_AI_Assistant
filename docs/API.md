# Nila API contract (source of truth: packages/shared/src)

Base URL: `http://localhost:4000` (dev). All routes are under `/api`. JSON in/out.
Auth: `Authorization: Bearer <JWT>` on everything except register/login/health.
Errors: `{ "error": { "code": "VALIDATION_ERROR" | "UNAUTHORIZED" | "NOT_FOUND" | ..., "message": "...", "details"?: ... } }`

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/health | — | `{ ok: true }` |
| POST | /api/auth/register | RegisterInput | AuthResponse (201) |
| POST | /api/auth/login | LoginInput | AuthResponse |
| GET | /api/auth/me | — | `{ user }` |
| PATCH | /api/auth/me | UpdateMeInput | `{ user }` |
| POST | /api/auth/logout-all | — | 204. Revokes every token for this user (including the one used); log in again |
| GET | /api/expenses | ?from&to&category&limit | `{ expenses }` newest first |
| POST | /api/expenses | CreateExpenseInput | `{ expense }` (201) |
| PATCH | /api/expenses/:id | UpdateExpenseInput | `{ expense }` |
| DELETE | /api/expenses/:id | — | 204 |
| GET | /api/expenses/summary | ?from&to (default: current month) | SpendingSummary |
| GET | /api/budgets | — | `{ budgets: BudgetStatus[] }` |
| PUT | /api/budgets | UpsertBudgetInput | `{ budget }` |
| DELETE | /api/budgets/:category | — | 204 |
| GET | /api/reminders | — | `{ reminders }` upcoming first |
| POST | /api/reminders | CreateReminderInput | `{ reminder }` (201) |
| PATCH | /api/reminders/:id | `{ done }` | `{ reminder }` |
| DELETE | /api/reminders/:id | — | 204 |
| POST | /api/agent | AgentRequest | AgentResponse |

Clients should use `createApiClient()` from `@nova/shared` instead of raw fetch.

## v2: personal assistant (tasks, notes, briefing, reports, receipts, voice)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/tasks | ?list&done=true\|false | `{ tasks }`: open first, then by dueDate |
| POST | /api/tasks | CreateTaskInput | `{ task }` (201) |
| PATCH | /api/tasks/:id | UpdateTaskInput | `{ task }` (sets/clears completedAt with done) |
| DELETE | /api/tasks/:id | — | 204 |
| GET | /api/notes | ?q (text search) | `{ notes }` newest first |
| POST | /api/notes | CreateNoteInput | `{ note }` (201) |
| PATCH | /api/notes/:id | CreateNoteInput | `{ note }` |
| DELETE | /api/notes/:id | — | 204 |
| GET | /api/briefing | ?tz | DailyBriefing |
| GET | /api/reports/weekly | ?weekStart=YYYY-MM-DD&tz (default: the last completed Mon–Sun week) | WeeklyReport |
| POST | /api/receipts/scan | ScanReceiptInput (JSON, up to ~6 MB body) | ReceiptScanResult |
| POST | /api/transcribe | TranscribeInput (JSON, up to ~14 MB body) | `{ text }` |

`PATCH /api/auth/me` also accepts `city`; `User` includes `city`.

## v3: natural voice (Groq Orpheus)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/speak/voices | — | NaturalVoicesResult (always 200; `available:false` + `reason` when unusable) |
| POST | /api/speak | SpeakInput (≤ 400 chars, one sentence or two) | SpeakResult (`data:audio/wav;base64,...`) |

Errors on POST /api/speak: 503 `TTS_UNAVAILABLE` (no key / terms not accepted: clients fall back to the device voice), 429 `TTS_RATE_LIMITED`, 429 `DAILY_LIMIT`, 400 `VALIDATION_ERROR` (unknown voice).

## v4: income (money received)

Income lives in its own collection (`incomes`), so `/api/expenses/summary`, budgets, the briefing and the weekly report never count money coming in. Categories: `INCOME_CATEGORIES` = Salary, Business, Refund, Gift, Transfer, Interest, Other (default Other).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/income | ?from&to&category&limit | `{ income: Income[] }` newest first |
| POST | /api/income | CreateIncomeInput `{ amount, category?, payer?, note?, date?, source? }` | `{ income }` (201) |
| PATCH | /api/income/:id | UpdateIncomeInput | `{ income }` |
| DELETE | /api/income/:id | — | 204 |
| GET | /api/income/summary | ?from&to (default: current month) | IncomeSummary `{ from, to, total, count, byCategory }` |

Client: `api.income.{list, create, update, remove, summary}`.

Agent: the `manageIncome` tool (`add` / `list` / `summary` / `delete`, where delete is confirmed). The prompt routes "received / credited / salary / X gave me" to it, never to `addExpense`. Clients should refresh when `actions` contains `manageIncome`.

## v5: categories + subcategories, ledger (balance), trends, reminder delete

**Categories** (`CATEGORIES`): Food, Groceries, Shopping, Housing, Rent, Transportation, Vehicle, Bills, Life & Entertainment, Health, Education, Travel, Investments, Savings & Insurance, Other.
- Renamed: Transport → Transportation, Entertainment → Life & Entertainment (`LEGACY_CATEGORIES`). The server migrates stored expenses and budgets at startup (idempotent) and accepts the old names on input.
- `SUBCATEGORIES[category]` lists the suggested subcategories. `Expense.subcategory` is optional free text (≤ 40 chars). The server infers it from merchant/note when it's omitted (swiggy → Food/Swiggy, rapido → Transportation/Rapido, netflix → Life & Entertainment/OTT, petrol → Vehicle/Fuel, "sent to dad" → Investments/Sent to Dad, term insurance → Savings & Insurance/Term insurance) and snaps near-matches to the listed spelling.
- `categoryGroup(c)`: Investments and Savings & Insurance are **"saving"** (reported as *invested*), everything else is **"spending"**.
- `GET /api/expenses/summary?category=X` also returns `bySubcategory`.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | /api/ledger | `?period=cycle` (default) or `?period=month&month=YYYY-MM` | `Ledger` |
| GET | /api/insights/trends | `?months=6` (2–12) | `TrendsResult` |

**Ledger:** income and expenses merged oldest first, with a running `balance` per entry. Totals are `{ received, spent, invested, balance = received − spent − invested }`. `period=cycle` starts at the latest **Salary** income (within 45 days), otherwise the calendar month; the balance resets there, with no carry-over. Response `period` is `"salary-cycle"`, `"month"` or `"custom"`.

**Trends:** per month `{ received, spent, invested, saved = received − spent, savingsRate, topCategories }`, plus `spentChangePercent` (this month vs last), `categoryChanges` and `averageMonthlySpent` (complete months only).

**Client:** `api.ledger(query)`, `api.trends(query)`, `api.reminders.remove(id)` (already existed), `api.tasks.update` / `remove` (already existed).

**Agent tools (new):**
- `deleteReminder`: matched by text or the next upcoming one. Destructive, confirmed.
- `getMoneyOverview` `{ view: "balance" | "trends", months? }`: balance for the cycle, or the trends analysis. Use it for "what's my balance", "how much did I save", "compare with last month", "spending trend".
- "Last month" spending keeps using `getSpendingSummary` with from/to.
- `addExpense` accepts `subcategory`.

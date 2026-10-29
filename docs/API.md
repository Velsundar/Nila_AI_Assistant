# Nova API contract (source of truth: packages/shared/src)

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

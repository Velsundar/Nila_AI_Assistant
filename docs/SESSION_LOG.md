# Nova: session log

The full record of how Nova was built: what was decided, what was built, how it was verified, what went wrong, and what's still open.
Newest session at the bottom. When adding a session, add a dated `## Session N` section and update **Current state** and **Backlog**.

- **Project:** Nova, a voice-first expense tracker and personal AI assistant ("Jarvis"-style) for web and mobile, built to cost ₹0.
- **Owner:** sundaravel@neokred.tech
- **Repo:** `/Users/sundaravel/Documents/POCss/TESTTTTTT`. Local git with no remote yet.
- **Assistant name:** "Nova" is a placeholder. Change `ASSISTANT_NAME` in `packages/shared/src/schemas.ts`; each user can also rename it in Settings.

---

## Current state (as of 2026-10-30)

| Area | Status |
|---|---|
| API (`apps/api`) | ✅ Express + Mongoose + Groq. 205/205 tests. Running locally on :4000 against **MongoDB Atlas** |
| Web (`apps/web`) | ✅ Next.js 15. Typecheck and production build pass; verified in headless Chrome |
| Mobile (`apps/mobile`) | ✅ Expo SDK 58. Typecheck, expo-doctor 18/18 and the Android/iOS bundles pass. **Never run on a real device** |
| Database | ✅ MongoDB Atlas (cluster `chat`, db `nova`), demo account seeded. Tests use local `nova_test` and never touch Atlas |
| AI | ✅ Groq free tier: `openai/gpt-oss-120b`, falling back to `gpt-oss-20b` then `qwen/qwen3.8-27b`; Whisper STT; Orpheus TTS |
| Deployed | ❌ Not yet. See **Next steps → Deployment** |

**Demo login:** `demo@nova.app` / `password123`. Reset with `pnpm --filter @nova/api seed`, which only touches the demo user.

### How to run
```bash
cd /Users/sundaravel/Documents/POCss/TESTTTTTT
pnpm install
pnpm dev:api      # http://localhost:4000  (needs apps/api/.env)
pnpm dev:web      # http://localhost:3000  (Chrome/Edge for voice)
pnpm dev:mobile   # Expo. Voice works in Expo Go through server STT; wake word / voice barge-in need `npx expo run:android`
pnpm typecheck && pnpm --filter @nova/api test
```

### Secrets and config (values are never in git)
- `apps/api/.env` (gitignored) holds:
  - `MONGODB_URI`: Atlas
  - `JWT_SECRET`: random, at least 32 chars. The server refuses to start without it
  - `LLM_PROVIDER=groq`, `LLM_API_KEY`, `LLM_MODEL=openai/gpt-oss-120b`
  - optional: `LLM_FALLBACK_MODELS`, `TTS_VOICE`, `TTS_MODEL`, `LLM_DAILY_CALL_LIMIT` (200), `TTS_DAILY_CALL_LIMIT` (300), `AGENT_DEADLINE_MS` (45000), `CORS_ORIGINS`, `NODE_ENV`
- `apps/api/.env.example` is committed and contains **placeholders only**. Real values were put there twice by mistake (a JWT secret, then the Atlas URI). Both were moved out before any commit, and the git history is clean.
- ⚠️ **Rotate the Groq API key.** It was pasted into the chat during session 1. Create a new one at console.groq.com and put it in `apps/api/.env`.
- **Web:** `NEXT_PUBLIC_API_URL` is required for production builds, which fail without it.
- **Mobile:** `EXPO_PUBLIC_API_URL`. `eas.json` has placeholders `http://YOUR-LAN-IP:4000` (preview) and `https://YOUR-API.onrender.com` (production).

---

## Architecture

```
apps/web (Next.js)     apps/mobile (Expo)
   │  on-device STT/TTS, orb UI, Today/Dashboard/Settings
   └──────────┬──────────┘   typed client: packages/shared (zod schemas + createApiClient)
              ▼   HTTPS + JWT + X-Timezone header
        apps/api (Express)
   REST: auth, expenses, budgets, reminders, tasks, notes, briefing, reports,
         receipts/scan, transcribe, speak, speak/voices
   POST /api/agent → LLM tool loop (15 tools) → MongoDB
              ▼
   MongoDB Atlas  ·  Groq (LLM, Whisper, Orpheus, vision)  ·  Open-Meteo (weather, no key)
```

**Design rules that hold everywhere**
- `packages/shared` is the single contract. Only the coordinator edits it; app agents put change requests in their progress files.
- The LLM never does arithmetic. Totals come from MongoDB aggregation.
- Destructive actions need a server-issued yes/no confirmation:
  - only an exact whole-utterance yes or no counts;
  - a pending action expires after 2 minutes;
  - it is claimed atomically, so two "yes" requests can't both run it.
- Every query is scoped to the logged-in user, and this is tested.
- Speech-to-text and text-to-speech happen on the device where possible, and the server sees only text. Server STT (Whisper) and TTS (Orpheus) are fallbacks or opt-in.

---

## Session 1: 2026-10-29 → 2026-10-30

### 1. Idea and feasibility
- The user asked whether a voice-based expense tracker plus personal assistant could be built at ₹0 with MERN, React Native and Next.js. **Yes.**
- I explained the stack, architecture and costs:
  - Play Store $25 one-time, App Store $99/yr, sideloading an APK is free;
  - free AI tiers have limits;
  - iOS does not allow always-on background listening.

### 2. v1: foundation, then 3 parallel agents (commits `f19257a`, `d006045`)
- I (the coordinator) built the pnpm monorepo, `packages/shared` (zod schemas and a typed API client) and `docs/API.md` first, so the parallel agents shared one contract.
- **API agent:** auth (JWT/bcryptjs), expenses, budgets, reminders, memories, conversations, and an LLM agent with tool calling, a provider abstraction and a rule-based `mock` provider. 68 tests.
- **Web agent:** Next.js dashboard (recharts) and the `/assistant` canvas orb with four states (idle, listening, thinking, speaking) using the Web Speech API.
- **Mobile agent:** Expo SDK 58 app with a reanimated orb, expo-speech-recognition and expo-speech.
- **Problem:** pnpm 11 wrote an `allowBuilds` placeholder into `pnpm-workspace.yaml`, which broke every install and made pnpm run installs outside the agents' lock. Fixed by setting `allowBuilds: esbuild: true`.

### 3. Real Groq key (commit `afef032`)
- **Bug 1:** the default model `llama-3.3-70b-versatile` had been retired (404). Switched to `openai/gpt-oss-120b`.
- **Bug 2:** the tool schemas used OpenAPI-3.0 boolean `exclusiveMinimum`, which Groq rejects. Switched `zod-to-json-schema` to `jsonSchema7`. The faked-fetch tests could not catch this.
- **Limit found:** the free tier allows **8,000 tokens/min per model**, so the second message in a minute hit a 429.

### 4. v2: personal assistant, plus review (commit `d71e26c`). Four parallel agents
- **API:**
  - fallback chain across 3 models with retry-after handling;
  - smaller prompts (about 1.8k down to 1.1–1.3k prompt tokens per call);
  - tasks and lists, notes, weather (Open-Meteo), daily briefing, weekly report (no tokens used), receipt scan (Groq vision with tesseract.js fallback), Whisper transcription.
- **Web:** `/today` page, "Brief me", the "Hey Nova" wake word, MediaRecorder STT fallback, receipt upload, weekly report card, home city.
- **Mobile:** Today tab, **voice in Expo Go via server STT**, receipt camera, wake word (dev build), local notification every Sunday at 9am.
- **Read-only review agent:** 16 findings. Two were high severity:
  - an "ok…" prefix counted as yes;
  - the JWT secret fell back to a public default.

  All were fixed: strict yes/no, expiry, atomic claim, mandatory secret, HS256, `tokenVersion` plus `POST /auth/logout-all`, memories marked as data, tz canonicalisation, per-user limits and a daily LLM budget, a 45s deadline, CSP on web, safe deploy defaults. The coordinator added an `X-Timezone` header, strict ISO dates and trimmed agent messages in shared.
- **Coordinator mistake:** I first sent the review fixes to the wrong agents (API ↔ web). It was caught when the API agent reported skipping web items and corrected by re-sending. **Lesson:** record agent IDs per role when spawning.
- **Live checks:** "ok what is the weather" during a pending delete did **not** delete; a token forged with the old secret got 401.

### 5. Female voice (commit `2ed1a9b`)
- Browsers and phones don't report a voice's gender, so `packages/shared/src/voices.ts` guesses it from well-known voice names (Apple, Microsoft, Google, Android), prefers Indian English, and skips novelty and "Eloquence" voices.
- Testing against the 184 voices on this Mac caught two problems: Flo had been chosen, and Tara wasn't recognised. Now: Mac → Tara (en-IN), Edge → Neerja, Chrome → Veena, Android → `en-in-x-ahp`.
- Settings: Female / Male / Default on both apps, plus an exact voice picker (web) or "Next voice" (mobile).

### 6. Natural voice and interruptions (commits `a2acb90`, `e58dab5`). Three parallel agents
- The user accepted the Groq Orpheus terms. Voices: **autumn, diana, hannah** (female) and **austin, daniel, troy** (male). Default **autumn**.
- **Limit:** the free tier allows **100 Orpheus requests/day for the whole account**, and about 1,200 characters/min. So:
  - one request per reply of up to 400 chars;
  - a server LRU cache;
  - "ack" clips cached once on each client, with leading silence trimmed;
  - fall back to the device voice on any error or 429.
- Measured: 107 chars took 1.4s (7.8s of audio); a cache hit takes 6ms; acks take about 0.45s.
- **Interruptions (barge-in):**
  - tap the mic or orb, or press Space, to stop, hear "Mm-hmm / Okay / Ah, got it / Sure", and start listening;
  - the interrupted reply stays as text marked "Stopped speaking";
  - questions asked while Nova is thinking are queued and answered in order, and the superseded answer is shown but not spoken;
  - interrupting by voice uses an echo filter (fewer than 2 words, or at least 60% overlap with what Nova is saying, is ignored).
    - Web: Chrome/Edge, on by default.
    - Mobile: dev build only, opt-in; iOS uses Apple's echo cancellation.
- Verified with scripted headless Chrome, 65 mobile logic checks and 11 echo cases. **Not yet tried with a real mic, speakers or a phone.**

### 7. MongoDB Atlas (no code commit; config only)
- The user created an Atlas cluster but had put the URI in `.env.example`. I moved it to `.env` and restored the placeholders.
- Connection test: 640ms, MongoDB 8.0.34, db `nova` empty. Seeded the demo account (165 expenses, 6 budgets, 4 reminders, 3 memories, 9 tasks, 4 notes).
- Indexes created automatically: `expenses userId+date`, `conversations updatedAt` (TTL, 30 days), `users email` (unique).
- Verified on Atlas: login, summary, briefing, and a real agent answer.

---

## Known issues / caveats
- **Untested on real hardware:** real microphone and speakers (web), anything on a physical phone, the wake word, voice barge-in, the Sunday notification, receipt photos from a real camera.
- The echo filter can ignore a real question that repeats most of Nova's words. Tapping the mic always works.
- The wake word sometimes matches "hey now" as "Hey Nova".
- One weather reply was missing a space between sentences ("…18 °C.That's…"). Cosmetic; not fixed.
- Expired confirmation prompts are hidden from the model, but a model can still occasionally phrase things oddly. The server-side confirmation is the real safeguard.
- Web keeps the JWT in localStorage, which a strict nonce CSP mitigates. An httpOnly cookie would be stronger.
- Atlas M0 has no automated backups.
- pnpm 11: if `ERR_PNPM_IGNORED_BUILDS` comes back after adding a package with build scripts, add it under `allowBuilds` in `pnpm-workspace.yaml`.
- `apps/mobile` typecheck depends on expo-router's generated types; on a fresh clone run `npx expo start` once.

## Backlog: decided later ("we can see these later")

**Automations proposed in session 1, not started.** The user will choose.

| Priority | Idea | Free approach |
|---|---|---|
| ⭐ 1 | **UPI/bank SMS auto-capture** | Android: read SMS in the sideloaded APK (Play Store restricts it). iPhone: Shortcuts "message received" automation POSTing to the API. Regex first, LLM only as a fallback |
| ⭐ 2 | **Scheduler:** 7:30 briefing push, 9pm "log today's spending?", overdue-task follow-ups, rain nudge | GitHub Actions cron or cron-job.org calling a protected endpoint (Render free sleeps) plus Expo push (free) |
| ⭐ 3 | **Telegram bot** with voice notes | Telegram Bot API (free) plus Whisper. WhatsApp's API has costs |
| 4 | Recurring bills and subscription detection with renewal reminders | Aggregation on history, no LLM |
| 5 | Unusual spending alerts ("3× usual on food") | Aggregation |
| 6 | Email receipts (Swiggy/Zomato/Amazon/Uber) | Gmail API |
| 7 | Bill splitting ("who owes me") | New model and tools |
| 8 | Habits and medicine reminders with streaks | Tasks plus a scheduler |
| 9 | Google Calendar | Google Calendar API |
| 10 | Location reminders ("near a supermarket") | expo-location geofencing |
| 11 | Monthly export to CSV / Google Sheets | Scheduler |
| 12 | Birthdays, home-screen widget, Siri Shortcut | — |

**Contract requests from agents, not yet done:**
- an `AbortSignal` option on `api.voice.speak()`, so cancelled speech doesn't spend Orpheus quota;
- document `details.retryAfter`, `TTS_TIMEOUT` (504) and `TTS_FAILED` (502) in `docs/API.md` and the shared types;
- trim Orpheus leading silence on the server;
- extra error codes from v2 (`STT_*`, `PAYLOAD_TOO_LARGE`, `GEOCODING_UNAVAILABLE`, `DAILY_LIMIT`) should go into the shared types.

## Next steps: deployment (₹0)
1. **GitHub:** create a repo and push. Render and Vercel deploy from GitHub.
2. **Atlas → Network Access:** allow `0.0.0.0/0`, because Render's free tier has no fixed IP. Use a database user with only `readWrite` on `nova`.
3. **Render (API):**
   - root `apps/api`, start with `tsx src/server.ts` (or build first);
   - env: `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET` (new, random), `LLM_*`, `CORS_ORIGINS=https://<vercel-app>`;
   - the free instance sleeps after 15 minutes, so the first request takes about 30–50s.
4. **Vercel (web):** root `apps/web`, `NEXT_PUBLIC_API_URL=https://<render-api>`.
5. **EAS (mobile):** set `EXPO_PUBLIC_API_URL` in `eas.json` production and preview, then `eas build -p android --profile preview` for an APK (free tier).
6. **Rotate the Groq key**, and use a fresh `JWT_SECRET` in production.
7. Optional: a GitHub Action running `mongodump` weekly for backups.

---

## Process notes (how this was built)
- **Pattern:** the coordinator writes the shared contract and commits it, then parallel agents each own one folder (`apps/api`, `apps/web`, `apps/mobile`), then the coordinator re-verifies and commits.
- Agents used an install mutex: `until mkdir .install.lock …; pnpm install; rmdir .install.lock`.
- Agents logged live progress to `docs/progress/{api,web,mobile}.md`.
- Screenshots: `docs/screenshots/` (`v2-*`, `v3-*`).
- The coordinator always re-ran typecheck and tests before each commit, scanned for the Groq key, and kept `.env.example` placeholder-only.

## 2026-10-30 — Fix: "Sorry, my language service had a problem"

- **Symptom:** "how did my spending go last week" often answered with the generic language-service error.
- **Cause:** the model calls `getWeeklyReport` with `{"weekStart": null}`. Groq validates tool calls against the JSON schema server-side; optional args were typed `string` only, so Groq returned 400 `tool_use_failed`. The one built-in retry usually failed the same way, and `friendlyLlmError` mapped `bad_request` to the generic message. Reproduced live: 2 of 3 calls failed.
- **Fix:** `jsonSchemaFor` (`apps/api/src/agent/tools.ts`) now marks every optional top-level arg as nullable (`["string","null"]`, with `null` added to enums). `stripNulls` already removes nulls before Zod, so tool behaviour is unchanged. This applies to every tool, not just the weekly report.
- Tool JSON grew from ~4.9k to ~5.2k chars (~70 tokens per call); the token-diet test budget was raised to 5500. A new test covers nullable optionals.
- Verified: 206/206 tests pass, typecheck clean, live Groq rerun 5/5 OK.

## 2026-10-30 — Fix: Nova hears her own voice on web (barge-in echo)

- **Symptom (first real-speaker test):** while Nova spoke, the mic picked up her voice. Nova stopped herself ("Stopped speaking") and answered the garbled echo, e.g. "you didn't login", "you love now EX", "help with your money task nurse reminders which show".
- **Causes in the web echo filter (`apps/web/src/lib/echoFilter.ts`):**
  1. LLM replies use curly apostrophes ("didn’t"). `normalize` turned them into `didn t` while Chrome's transcript gave `didnt`, so they never matched.
  2. Exact word matching. The recognizer garbles speaker audio ("log any" → "login", "no" → "now", "expenses" → "ex").
  3. It compared only the current and previous TTS chunk, but recognition lags playback.
- **Fix:**
  - `normalize` (`hooks/wakeMatch.ts`) maps curly apostrophes to `'`.
  - A heard word now counts as echo if it is a prefix of, or within one edit of, a word Nova is saying.
  - The barge-in matcher compares against the whole reply plus the current chunk.
- Checked with a scratch script: the 4 real echo transcripts are now ignored, and 7 genuine interruptions still go through. Web typecheck is clean.
- Not changed: mobile `lib/echo.ts` already handles curly apostrophes; fuzzy matching there is a possible follow-up.
- **Still true:** speakers plus voice barge-in is inherently leaky. Headphones avoid it entirely, and Settings → interrupt by voice can be turned off (tapping the mic always works).

## 2026-11-05 — Renamed Nova → Nila; Render deploy blocked on GitHub access

- **Rename (user commits `234c680`, `e1b5f20`; fix in the commit adding this entry):**
  - Every user-facing "Nova" is now "Nila": web title/header, mobile app name and permission prompts, UI and error strings, the default `ASSISTANT_NAME` (`packages/shared/src/schemas.ts`), README/API docs, test fixtures.
  - Wake word "Hey Nila": `apps/web/src/hooks/wakeMatch.ts` and `apps/mobile/src/lib/wake.ts` accept common mishearings (neela, nela, nilla, neila, nyla, nilah, "nee la", …). Web keeps the old Nova aliases for accounts still named Nova. Spot check: 10/10 (including "hey villa" / "vanilla latte" rejected). The API's confirmation filler and the memory-injection filter also know "nila".
  - Atlas: the one user with `assistantName: "Nova"` (the demo) was updated to "Nila". Custom names are untouched.
  - **Kept on purpose (renaming would break things or lose data):** the `@nova/*` workspace package names, the Atlas/local database name `nova`, `nova.*` storage keys (renaming logs users out and resets prefs), cache names, the Expo slug/scheme/bundle id `app.nova.mobile` (linked to the EAS project), and the `demo@nova.app` demo login.
  - Bug: `e1b5f20` was committed mid-edit and had a stray line at the top of mobile `wake.ts` (mobile typecheck failed). Fixed. All green after: typecheck all 4 packages, API 206/206, mobile voice logic 65/65.
  - `npx expo lint` installs ESLint on first run (package.json + lockfile + `eslint.config.js`). I backed that out. It reports 28 pre-existing errors (refs during render, setState in effects, unescaped quotes), so it's a backlog item.
- **Render:** repo `Velsundar/Nila_AI_Assistant` is **private**, so "Public Git Repository" clones fail (`could not read Username`). Render's GitHub connection shows "No repositories found" even after granting All repositories on GitHub. Next: uninstall the Render app on GitHub, reinstall it via Render's GitHub button (popups allowed), or check Account Settings → Git Providers. There is no `render.yaml`, so use New → Web Service, not Blueprint.

## 2026-11-05 — Deployed to Render; income (money received)

- **Render:** live at https://nila-ai-assistant.onrender.com (`/api/health` ok; demo login and a Groq reply verified against Atlas). The repo was made public (full-history scan first: no Groq key, Atlas password or real JWT secret ever committed). Settings: build `npm install -g pnpm@11.3.0 && pnpm install --frozen-lockfile`, start `pnpm --filter @nova/api start`, health `/api/health`, env `NODE_ENV=production NODE_VERSION=22 MONGODB_URI JWT_SECRET LLM_PROVIDER=groq LLM_API_KEY LLM_MODEL CORS_ORIGINS` (no PORT). Public-URL services don't auto-deploy: use Manual Deploy, or a deploy hook + GitHub Action (offered, not done).
- **Fixes for the deploy (`0c96b83`):** `tsx` moved to API dependencies (production installs skip devDependencies), and `packageManager: pnpm@11.3.0`. `eas.json` now points at the live URL (`ed0331e`).
- **Bug:** "75k incoming salary credited" was saved as a ₹75,000 *expense*, because the assistant only had `addExpense`.
- **Income (`2e3ed49` API/shared, `4e71027` mobile, `5525da5` web).** Two parallel agents built the UI (web-income, mobile-income).
  - Separate `incomes` collection, `/api/income` CRUD + `/summary`, and `api.income.*`. Categories: Salary, Business, Refund, Gift, Transfer, Interest, Other.
  - The `manageIncome` agent tool (add/list/summary/delete, with delete confirmed). The prompt sends money received to it, and the mock brain parses "received / credited / X gave me".
  - Spending totals, budgets, the briefing and reports are unchanged.
  - Real Groq check on a local scratch DB: salary → income, "Ravi gave me 500" → income (payer ends up in the note), "spent 200 on auto" → expense, "how much did I receive and spend" → both totals.
  - The tool-schema size cap went from 5,500 to 6,000 chars (~150 tokens per call).
  - Web: Received / Net tiles, Money in list, Add income form. Income requests fail soft. Mobile: the same on the Expenses tab, plus AddIncomeSheet. Neither UI has been viewed on a real screen yet.
  - The misrecorded ₹75,000 had already been deleted from Atlas before the fix, so there was nothing to migrate.
  - Tests: API 216/216, mobile voice 65/65, typecheck clean.
- **Git:** the working tree had a blanket `git rm -r --cached .` staged. Re-adding was verified to produce an identical tree, then it was unstaged with `git reset` (no file changes).
- **Open:** Vercel deploy for web (`NEXT_PUBLIC_API_URL=https://nila-ai-assistant.onrender.com`, then add the Vercel URL to Render `CORS_ORIGINS`); EAS APK; income in the daily briefing / weekly report; date field on mobile add-income; 28 pre-existing mobile lint errors.

## 2026-11-05 — v5: categories + subcategories, balance (salary cycle), trends, reminder delete, task details

Three parallel agents (api, web, mobile) worked from a contract the coordinator wrote in `packages/shared` + `docs/API.md` "v5".
- **Categories:**
  - The list is now Food, Groceries, Shopping, Housing, Rent, Transportation, Vehicle, Bills, Life & Entertainment, Health, Education, Travel, Investments, Savings & Insurance, Other. Transport → Transportation and Entertainment → Life & Entertainment, migrated idempotently at API startup. The migration already ran on Atlas through the local dev server: 34 + 7 expenses and the budgets renamed, no legacy names left.
  - `SUBCATEGORIES` gives suggested values; `Expense.subcategory` is free text, inferred from merchant/note (`apps/api/src/services/categories.ts`).
  - Investments and Savings & Insurance count as *invested/saved*, not spent.
- **Ledger** `GET /api/ledger`: income + expenses oldest first with a running balance. It resets at the latest Salary income (within 45 days), otherwise the calendar month.
- **Trends** `GET /api/insights/trends?months=6`: received/spent/invested/saved, savings rate, change vs last month, category movers.
- **Agent:**
  - New tools `deleteReminder` (confirmed) and `getMoneyOverview` (balance | trends); `addExpense` takes a subcategory.
  - The category enum was removed from all tool schemas: Groq rejected the whole call when the model sent "Insurance". Unknown categories now become Other, then get inferred. `addExpense.category` is no longer required.
  - Tool schemas total 6,324 chars, with the cap raised to 6,600.
- **Web:**
  - Pie chart fix: delete only filtered the list. The summary now updates in the same frame, refetches are independent, colours are fixed per category, and the page refreshes when the tab becomes visible.
  - Slice → subcategory drill-down.
  - Balance card (passbook) and Trends card.
  - Reminder delete in the briefing card.
  - Task row opens details (edit/delete); only the checkbox toggles done.
- **Mobile:** the same features on the Expenses/Today tabs (BalanceSection, TrendsSection, TaskDetailsSheet, subcategory chips, reminder delete).
- **Real Groq check (scratch DB):** at realistic pacing (~20 s apart) all phrases routed correctly (salary, Swiggy, sent to Dad, term insurance, reminder delete with confirm, balance ₹63,500, trends). A rapid-fire run (4 s apart) hit the 8k TPM limit and fell back to gpt-oss-20b/qwen, which produced garbled or hallucinated replies. **The free-tier rate limit is the main quality risk.**
- **Tests:** API 282/282, mobile voice 65/65, all 4 packages typecheck, web production build passes, Android export builds.
- **Leftover:** the web agent's e2e run created the Atlas user `web-v5-e2e-…@example.test`; its data was removed, but there's no endpoint to delete the user itself.
- **Open:**
  - no full reminders list (only today's, in the briefing);
  - the "Spent this month" tile still includes Investments;
  - receipts don't prefill a subcategory;
  - no user-delete endpoint;
  - mitigate rate limits (shorter history, a lighter fallback, or a paid tier).

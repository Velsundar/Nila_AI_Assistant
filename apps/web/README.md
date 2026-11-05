# @nova/web

The Nila web app: a voice-first expense tracker with a talking "robot orb" assistant.
Built with Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4 and recharts.
It's a client-side app that talks to the Express API (`apps/api`) with a JWT, using the typed
`createApiClient()` from `@nova/shared`.

## Run

```bash
# from the repo root
pnpm install
cp apps/web/.env.example apps/web/.env.local   # optional; defaults to http://localhost:4000
pnpm dev:api                                    # API on :4000 (see apps/api)
pnpm dev:web                                    # web on http://localhost:3000
```

Sign in with the seeded demo user `demo@nova.app` / `password123`, or register a new account.

| Script | What it does |
|---|---|
| `pnpm --filter @nova/web dev` | Next dev server on port 3000 |
| `pnpm --filter @nova/web build` | Production build |
| `pnpm --filter @nova/web start` | Serve the production build on port 3000 |
| `pnpm --filter @nova/web typecheck` | `tsc --noEmit` |

`NEXT_PUBLIC_API_URL` sets the API base URL (no trailing slash). It's inlined at build time, so
rebuild after changing it. **A production build fails if it's unset** (so a deploy never silently points at
`http://localhost:4000`); in dev it defaults to `http://localhost:4000`. Local production check:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @nova/web build && pnpm --filter @nova/web start
```

The API must allow the web origin in CORS (`http://localhost:3000` is allowed by default) and the `X-Timezone` header.

### Security headers

The JWT is kept in localStorage, so `src/middleware.ts` sends a strict, per-request-nonce
Content-Security-Policy: `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in dev only),
`connect-src 'self'` + the API origin, `img-src 'self' data: blob:`, `media-src 'self' blob:`,
`object-src 'none'`, `frame-ancestors 'none'`. Styles allow `'unsafe-inline'` (React/recharts style attributes).
Pages render per request so Next can stamp the nonce on its scripts. `next.config.ts` adds `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy`, COOP, HSTS and a `Permissions-Policy` that allows only the mic and camera.
User text is always rendered as text (no `dangerouslySetInnerHTML`).

## Pages

- `/today` (home after sign-in): the daily briefing (weather for your home city, tasks due or overdue, today's reminders, spent yesterday and this month, budget alerts, "Read aloud"), tasks grouped by list (Inbox, Shopping, …) with add (title, list, due date, priority), check off, delete and Open/Done/All plus per-list filters, and notes with quick-add (⌘/Ctrl+Enter), debounced search, inline edit and delete. Every card refetches when the assistant changes data.

- `/login`, `/register`: client-side validation with the shared zod schemas, plus inline field errors from the API's `VALIDATION_ERROR` details.
- `/dashboard`: **weekly report** card (last completed Mon–Sun week: total, % change vs the week before, top categories and merchants, "Read it to me"), **receipt scanning** in the Add-expense card (drop/upload, or the camera on phones: the image is downscaled in a canvas to ≤1600 px JPEG under ~3.5 MB, sent to `POST /receipts/scan`, and the form is prefilled with a confidence badge; nothing saves until you press Save), month picker, month total and count, spend by category (donut), spend by day (bars), budgets with progress bars (red above 90%), recent expenses with delete, an "Add expense" form, and a "Set budget" form. It refetches on mount, on window focus, and whenever the assistant reports a successful action, including from other tabs.
- `/assistant`: **Brief me** (fetches `/briefing` and speaks it, no LLM call), optional **auto-briefing** on the first open each day (Settings; the date is remembered in localStorage), **wake word** "Hey <assistant name>" (Settings, off by default), a camera button for receipt scanning (opens a confirm dialog), action chips for every agent tool (`manageTask`, `manageNote`, `getWeather`, `getDailyBriefing`, `getWeeklyReport`, expenses, budgets, reminders, memory, with a readable fallback for unknown tools), and suggestion chips for the personal-assistant range. The full-screen orb: Hold the mic button or **Space** to talk. A quick tap starts hands-free mode, which stops after about 1.8 s of silence or when you tap again. You can also type. Live interim transcript, a caption log (`aria-live`), action chips for `response.actions`, and a Yes/No card when the API sets `pendingConfirmation`. The `conversationId` lives for the browser session, and the **+** button starts a new conversation. Use `?orb=listening|thinking|speaking` to preview a state.
- `/settings`: home city for weather (`PATCH /auth/me` `city`; the API's "Unknown city" / geocoding errors are shown inline), wake-word and auto-briefing toggles, rename the assistant (`PATCH /auth/me`), pick the TTS voice, set the speaking speed, mute spoken replies, and choose the recognition language. Voice prefs are stored in localStorage.

## Voice and browser support (₹0: in the browser, plus the free server STT fallback)

| Feature | API used | Works in |
|---|---|---|
| Speech-to-text | Web Speech API `SpeechRecognition` / `webkitSpeechRecognition`, `lang` `en-IN` by default, interim results | Chrome and Edge (desktop and Android), Safari 14.1+ (macOS and iOS). **Not Firefox.** |
| Text-to-speech | `window.speechSynthesis` | All modern browsers. Voices vary by OS. |
| Live mic level (orb reacts to your voice) | `getUserMedia` + Web Audio `AnalyserNode` | All modern browsers |
| Wake word "Hey Nila" | Continuous `SpeechRecognition` while the assistant page is open **and visible** | Chrome and Edge only |
| Server speech-to-text fallback | `MediaRecorder` (webm/opus or mp4) → base64 → `POST /transcribe` | Any browser without `SpeechRecognition` (e.g. Firefox) |
| Receipt photos | `<input type=file accept=image/* capture>` + canvas downscale | All modern browsers (HEIC only where the browser can decode it) |

Notes:
- **Wake word:** a second recognizer listens continuously and fuzzy-matches "hey/hi/ok + <name>" (edit distance, plus common mishearings such as "hey Noah"). "Hey Nila" alone starts a normal listening turn; "Hey Nila, what's the weather" sends the command directly. It pauses while the assistant speaks, while a turn is in progress, while the tab is hidden and while the receipt dialog is open, and it restarts on `onend` (Chrome ends continuous sessions on its own) with exponential backoff on errors. Speech goes to the browser's speech service.
- **Server STT fallback:** hold the mic to record (or tap to start and tap again to send, 60 s cap). `STT_UNAVAILABLE` (503) switches the page to typing with a notice; `STT_RATE_LIMITED`, `STT_BAD_AUDIO`, `STT_FAILED` and `PAYLOAD_TOO_LARGE` show a notice and keep the mic available.
- Recognizers, recorders, audio contexts and timers are released on unmount and when the tab is hidden.
- Chrome's recognition streams audio to Google's speech service, so it needs an internet connection. It's free and needs no key. If that service is unreachable, the app shows a `network` notice and you can type instead.
- If recognition isn't available (Firefox), the mic switches to server STT (above); the mic is disabled only if neither works, and the text input always works.
- Mic permission is required. If it's denied, the app shows how to re-enable it and keeps the text input working.
- Speech recognition requires a secure context: `http://localhost` or HTTPS. A LAN IP over plain HTTP won't get mic access.
- TTS is cancelled the moment you start talking, so the assistant never talks over you. Long replies are split into sentences to work around Chrome's ~15 s utterance cutoff.
- All browser APIs are touched only inside client effects and event handlers, so SSR and `next build` are safe.

## Structure

```
src/
  app/                 routes (login, register, (app)/today|dashboard|assistant|settings)
  components/          AuthProvider, AppShell (auth guard + nav), ui primitives
  components/assistant Orb (canvas, 4 states), action-chip labels
  components/today     BriefingCard, TasksCard, NotesCard
  components/expenses  AddExpenseForm (shared, accepts a receipt draft), ReceiptScanner
  components/dashboard recharts donut + daily bars
  hooks/               useSpeechRecognition, useSpeechSynthesis, useMicLevel, useWakeWord (+ wakeMatch), useAudioRecorder
  lib/                 api client instance, formatting, voice prefs, data-changed events, image downscale
  middleware.ts        per-request CSP nonce
```

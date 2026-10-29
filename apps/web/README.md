# @nova/web

The Nova web app: a voice-first expense tracker with a talking "robot orb" assistant.
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
rebuild after changing it. The API must allow the web origin in CORS (`http://localhost:3000` is allowed by default).

## Pages

- `/login`, `/register`: client-side validation with the shared zod schemas, plus inline field errors from the API's `VALIDATION_ERROR` details.
- `/dashboard`: month picker, month total and count, spend by category (donut), spend by day (bars), budgets with progress bars (red above 90%), recent expenses with delete, an "Add expense" form, and a "Set budget" form. It refetches on mount, on window focus, and whenever the assistant reports a successful action, including from other tabs.
- `/assistant`: the full-screen orb. Hold the mic button or **Space** to talk. A quick tap starts hands-free mode, which stops after about 1.8 s of silence or when you tap again. You can also type. Live interim transcript, a caption log (`aria-live`), action chips for `response.actions`, and a Yes/No card when the API sets `pendingConfirmation`. The `conversationId` lives for the browser session, and the **+** button starts a new conversation. Use `?orb=listening|thinking|speaking` to preview a state.
- `/settings`: rename the assistant (`PATCH /auth/me`), pick the TTS voice, set the speaking speed, mute spoken replies, and choose the recognition language. Voice prefs are stored in localStorage.

## Voice and browser support (₹0: everything runs in the browser)

| Feature | API used | Works in |
|---|---|---|
| Speech-to-text | Web Speech API `SpeechRecognition` / `webkitSpeechRecognition`, `lang` `en-IN` by default, interim results | Chrome and Edge (desktop and Android), Safari 14.1+ (macOS and iOS). **Not Firefox.** |
| Text-to-speech | `window.speechSynthesis` | All modern browsers. Voices vary by OS. |
| Live mic level (orb reacts to your voice) | `getUserMedia` + Web Audio `AnalyserNode` | All modern browsers |

Notes:
- Chrome's recognition streams audio to Google's speech service, so it needs an internet connection. It's free and needs no key. If that service is unreachable, the app shows a `network` notice and you can type instead.
- If recognition isn't available (Firefox), the mic button is disabled, a notice explains why, and the text input still works.
- Mic permission is required. If it's denied, the app shows how to re-enable it and keeps the text input working.
- Speech recognition requires a secure context: `http://localhost` or HTTPS. A LAN IP over plain HTTP won't get mic access.
- TTS is cancelled the moment you start talking, so the assistant never talks over you. Long replies are split into sentences to work around Chrome's ~15 s utterance cutoff.
- All browser APIs are touched only inside client effects and event handlers, so SSR and `next build` are safe.

## Structure

```
src/
  app/                 routes (login, register, (app)/dashboard|assistant|settings)
  components/          AuthProvider, AppShell (auth guard + nav), ui primitives
  components/assistant Orb (canvas, 4 states), action-chip labels
  components/dashboard recharts donut + daily bars
  hooks/               useSpeechRecognition, useSpeechSynthesis, useMicLevel
  lib/                 api client instance, formatting, voice prefs, data-changed events
```

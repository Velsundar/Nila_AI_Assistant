# Mobile agent progress

- [00:08] 🚀 Started: read shared contract + API docs, scaffolding apps/mobile (Expo + expo-router)
- [00:09] 📦 Scaffolded apps/mobile (Expo SDK 58, RN 0.88, expo-router); package renamed @nova/mobile, deps pinned to SDK-58 versions; waiting on install mutex
- [00:14] ✅ Deps installed (mutex). Note: pnpm 11 exits 1 with ERR_PNPM_IGNORED_BUILDS for esbuild (api/web dep, not mobile) and auto-wrote allowBuilds/minimumReleaseAgeExclude into pnpm-workspace.yaml
- [00:14] ✅ API client wiring (LAN-IP base URL), AuthProvider + SecureStore JWT, useVoice hook (STT feature-detected for Expo Go, TTS via expo-speech)
- [00:18] ✅ Screens written: login/register, Assistant (robot orb w/ 4 states, mic hold/tap, captions, chips, Yes/No confirm), Expenses (totals, category bars, budgets, recent + long-press delete, add sheet), Settings. Typecheck passing
- [00:20] ✅ Verified: tsc clean, expo-doctor 18/18 passed, `expo export` android + ios bundles build (dist removed). Metro needed no custom config for the monorepo
- [00:21] 📝 README written (Expo Go text mode vs dev build voice, LAN IP setup, honest costs); eas.json preview APK profile added. Waiting for API at :4000 to sanity-check client calls
- [00:25] ✅ API live: curl-verified login, /auth/me, /expenses/summary, /budgets, /expenses, /agent (addExpense action + pendingConfirmation yes/no flow), LAN IP 192.168.1.13:4000 reachable, 401 without token. Mobile DONE
- [00:25] ⚠️ Note for coordinator: pnpm 11 `verifyDepsBeforeRun` auto-runs `pnpm install` before `pnpm --filter … <script>` and fails on ERR_PNPM_IGNORED_BUILDS (esbuild). Set `allowBuilds: { esbuild: true }` in pnpm-workspace.yaml (placeholder written by pnpm). Workaround: `pnpm --config.verify-deps-before-run=false --filter @nova/mobile typecheck`

## v2: personal assistant

- [00:56] 🚀 Started v2: read v2 contract (tasks, notes, briefing, weekly report, receipts, transcribe, User.city). Adding expo-audio / file-system / image-picker / image-manipulator / notifications (SDK-58 versions)
- [01:08] ✅ Deps installed (expo-audio 58.0.10, expo-file-system 58.0.13, expo-image-picker 58.0.10, expo-image-manipulator 58.0.16, expo-notifications 58.1.7); app.json permission strings + plugins; app.config.ts (cleartext only for non-production); eas.json placeholders
- [01:08] ✅ useVoice reworked: native STT → server STT (expo-audio m4a → base64 → /api/transcribe, metering drives orb, 503 → text fallback) + wake-word loop; fuzzy wake matcher (src/lib/wake.ts) tested. Today tab written (briefing card, tasks by list, notes w/ search+edit)
- [01:12] ✅ Assistant: Brief me (REST /briefing, spoken), auto-briefing (1×/day, off by default), notification → weekly report read-out, chips for manageTask/manageNote/getWeather/getDailyBriefing/getWeeklyReport + generic fallback, suggestion chips, busyRef double-send guard. Expenses: weekly report card + receipt scan → prefilled sheet w/ confidence badge. Settings: city, wake word (dev build only), morning briefing, weekly notification (Sun 9:00 local)
- [01:12] ✅ curl-verified live v2: tasks CRUD (+400 on '10/30/2026'), notes CRUD + ?q search, /briefing (weather Bengaluru), /reports/weekly, PATCH city (unknown → 400 'Unknown city'), /transcribe with say→afconvert m4a (13 KB) → 'Add milk and eggs to my shopping list.' in 1.0s → /agent → manageTask add ✅ (2 agent calls used)
- [01:14] ✅ Review fixes: busyRef double-send guard; useVoice cleanup resets session/listening state (all recognizer + recorder paths); eas.json placeholders (preview LAN, production https); release build w/o API URL → config error on login; cleartext only for non-production via app.config.ts
- [01:14] 🏁 v2 DONE: typecheck clean, expo-doctor 18/18, expo export android + ios OK (dist removed), README 'What works where' (Expo Go vs dev build). Not live-tested: receipt scan with a real photo (route + validation verified), on-device wake word (needs a device), notification delivery (needs a device)

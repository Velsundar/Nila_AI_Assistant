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

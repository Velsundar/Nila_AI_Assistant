# @nova/mobile — Nova for Android & iOS

Expo (SDK 58, React Native 0.88) + expo-router + TypeScript. Talks to `apps/api` through the typed
client in `@nova/shared`. No paid services: speech is on-device where possible, and otherwise uses
the API's free server-side speech-to-text (`POST /api/transcribe`).

| Screen | What's there |
|---|---|
| Login / Register | JWT stored in `expo-secure-store`; "Use demo account" button (`demo@nova.app` / `password123`) |
| **Assistant** (home) | Animated robot orb (idle / listening / thinking / speaking), tap-or-hold mic, live transcript, captions, action chips (tasks, notes, weather, briefing, report, expenses… with a generic fallback; tap → the related tab), suggestion chips, **Brief me** (reads `/briefing` aloud, no AI), optional once-a-day auto-briefing, optional wake word, Yes/No confirmation, text input |
| **Today** | Daily briefing card (weather, reminders today, tasks due/overdue, spent yesterday / this month, budget alerts, "Read it to me"); tasks grouped by list (Inbox, Shopping, …) with add (list / due / priority), check-off with haptics, long-press delete, completed toggle; notes with quick-add, server search, edit, delete; pull-to-refresh + refetch on focus |
| Expenses | Month total, **weekly report card** (vs previous week, top categories/merchants, read aloud), **Scan receipt** (camera or library → prefilled add-expense sheet with a confidence badge; you confirm, never auto-saved), category bars, budgets, recent list (long-press → delete), add-expense sheet, pull-to-refresh |
| Settings | Rename assistant, home city (weather; unknown cities show the server's error), Speak replies, Morning briefing, Weekly report notification (Sundays 9:00), wake word (dev build only), voice/API diagnostics, log out |

## What works where

| Feature | Expo Go (SDK 58) | Dev / release build |
|---|---|---|
| Everything except voice-specific rows below | ✅ | ✅ |
| Voice input | ✅ **server STT**: hold the mic → `expo-audio` records mono AAC `.m4a` → base64 data URL → `POST /api/transcribe` → text → agent. Orb reacts to the recorder's metering level. | ✅ **on-device** `expo-speech-recognition` (live interim text). Falls back to server STT if the phone has no recognizer. |
| If the API has no STT key (`503 STT_UNAVAILABLE`) | Voice switches off with a notice; type instead | On-device STT unaffected |
| Spoken replies (`expo-speech`) | ✅ | ✅ |
| Wake word "Hey <name>" | ❌ hidden, Settings explains why (needs the native recognizer) | ✅ opt-in |
| Receipt scanning (`expo-image-picker` + `expo-image-manipulator`) | ✅ | ✅ |
| Weekly report notification (local, `expo-notifications`) | ✅ local scheduled notifications work in Expo Go on iOS and Android. Remote *push* is not in Expo Go on Android since SDK 53, but Nova doesn't use push. Expect a one-time "expo-notifications is not fully supported in Expo Go" console warning. | ✅ |

**Server STT details.** Recording uses 16 kHz mono AAC at 64 kbps (~8 KB/s; a 5 s command is ~40 KB,
far under the 10 MB limit). It stops when you release, when you tap again, or after 30 s. Recordings
shorter than about 0.45 s are dropped with a hint. The temp file is deleted after upload. Verified
end to end against the live API: a macOS `say` + `afconvert` m4a came back as
"Add milk and eggs to my shopping list." in about 1 s.

**Wake word details (dev build).** When it's on, the assistant runs short back-to-back on-device
recognition sessions, but only while the Assistant tab is focused, the app is in the foreground
(AppState) and Nova isn't talking or thinking. It stops on blur or background and restarts after TTS
ends. Matching is fuzzy: a greeting ("hey", "hi", "ok", "hello"…) plus your assistant's name within
a small edit distance, so "hey noah" or "hey no va" match "Nova". If the command is in the same
breath ("Hey Nova, add bread to my shopping list") it's sent straight away; "Hey Nova" alone starts
a normal listening turn. On Android each session may play the system "listening" chime, and it uses
more battery, which is why it's off by default.

**Weekly report notification.** Toggling it on asks for notification permission, creates an Android
channel and schedules one repeating local notification (`WEEKLY`, weekday 1 = Sunday, 9:00 local
time, fixed identifier so it's never duplicated). Tapping it, even from a cold start, opens the
Assistant, which fetches `GET /api/reports/weekly` and reads it aloud.

**After pulling this version:** the new native modules (`expo-audio`, `expo-file-system`,
`expo-image-picker`, `expo-image-manipulator`, `expo-notifications`) are all in Expo Go. A dev
build made *before* this version must be rebuilt (`npx expo run:android|ios`).

## Run it

From the repo root: `pnpm install` (once), then start the API (`pnpm dev:api`, port 4000).

### Option A — Expo Go (fastest; voice via server STT)

```bash
cd apps/mobile
pnpm start            # or: npx expo start
```

Scan the QR code with **Expo Go** (Android) or the Camera app (iOS). `expo-speech-recognition` isn't
in Expo Go, so the app detects that at runtime and records audio for the API to transcribe instead
(hold the mic). That needs the API's free STT to be configured; otherwise you type. The wake word is
the only feature that needs a dev build.

### Option B — Development build (on-device voice + wake word)

On-device recognition and the wake word need a build that includes the native speech module. Both ways are free:

- **Local build (free, needs Android Studio / Xcode):**
  ```bash
  cd apps/mobile
  npx expo run:android      # builds + installs a debug APK on an emulator or USB-connected phone
  npx expo run:ios          # macOS + Xcode only
  ```
  This generates `android/` / `ios/` (git-ignored, Continuous Native Generation — don't edit them; change `app.json` instead).
  After that, `pnpm start` serves JS to the installed app.
- **EAS Build free tier (cloud, no Android Studio):**
  ```bash
  npx eas-cli@latest login
  npx eas-cli@latest build --profile preview --platform android   # produces an installable APK
  ```
  Replace the placeholders in `eas.json` first: `build.preview.env.EXPO_PUBLIC_API_URL`
  (`http://YOUR-LAN-IP:4000`) and `build.production.env.EXPO_PUBLIC_API_URL`
  (`https://YOUR-API.onrender.com`). A standalone build has no Metro server to derive the address
  from. A release build without the variable shows a configuration error on the login screen
  rather than silently trying `localhost`. (For an EAS *development* client
  you'd add `expo-dev-client` and a `development` profile.)

The first time you tap the mic, the phone asks for microphone + speech-recognition permission.
Recognition language is `en-IN`. On Android it uses the Google speech service on the phone.

## Pointing a real phone at the API

1. Phone and computer on the **same Wi-Fi** (no guest/isolated network).
2. Run the API so it listens on all interfaces (port 4000) and allow it through the macOS firewall if prompted.
3. In development, the app automatically uses the host Metro is served from, i.e.
   `http://<your-LAN-IP>:4000` (derived from `Constants.expoConfig.hostUri`). Check the address in
   **Settings → Diagnostics** or at the bottom of the login screen.
4. To override it (tunnels, emulators, standalone builds), set `EXPO_PUBLIC_API_URL`:
   ```bash
   EXPO_PUBLIC_API_URL=http://192.168.1.13:4000 pnpm start
   ```
   (find your IP with `ipconfig getifaddr en0` on macOS). Android emulator → `http://10.0.2.2:4000`.
   Fallback when nothing else applies: `http://localhost:4000`.

Plain `http://` to a LAN address is allowed: iOS via `NSAllowsLocalNetworking`, Android via
`expo-build-properties` → `usesCleartextTraffic`. That Android flag is set in `app.config.ts` and is
**on for every build except `APP_VARIANT=production`** (the EAS production profile sets it), so
release builds can only reach an `https://` API.

## Scripts

| Command | |
|---|---|
| `pnpm start` | Metro dev server (Expo Go / dev build) |
| `pnpm android` / `pnpm ios` | Start and open on a device/emulator |
| `pnpm run:android` / `pnpm run:ios` | Local native dev build (voice) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm doctor` | `expo-doctor` |
| `npx expo export --platform android` | Verify the production JS bundle builds |

## Code map

```
src/app/_layout.tsx          providers + auth gate (Stack.Protected)
src/app/(auth)/              login, register
src/app/(tabs)/              index (Assistant), today, expenses, settings; _layout mounts notification-tap handling
src/components/Orb.tsx       reanimated + react-native-svg robot orb
src/components/MicButton.tsx tap-to-toggle / hold-to-talk mic
src/components/BriefingCard.tsx, TasksSection.tsx, NotesSection.tsx   Today tab
src/components/WeeklyReportCard.tsx, AddExpenseSheet.tsx (receipt prefill + confidence)   Expenses tab
src/hooks/useVoice.ts        STT: native → server (expo-audio + /transcribe) → text; wake-word loop; TTS
src/hooks/useSpeaker.ts      read-aloud toggle for cards
src/lib/wake.ts              fuzzy "Hey <name>" matcher
src/lib/actions.ts           agent tool → chip label/icon/tab
src/lib/receipt.ts           pick/photograph + downscale (≤1600 px, < ~3.5 MB) → JPEG data URL
src/lib/notifications.ts     weekly local notification + tap → assistant intent
src/lib/api.ts               base URL resolution (+ release-build config error) + shared createApiClient()
src/lib/auth.tsx             AuthProvider (SecureStore JWT, 401 → logout)
src/lib/app-state.tsx        persisted toggles, data-version for cross-tab refetch, pending assistant intent
app.config.ts                variant-dependent config (cleartext off for production)
src/constants/theme.ts       colors, spacing, category colors/icons
```

## Honest costs

| | Cost |
|---|---|
| Expo Go, local dev builds (`expo run:*`), on-device speech, TTS, local notifications | **₹0** |
| Server STT / receipt scanning | ₹0 on the API's free AI tier (rate-limited) |
| EAS Build free tier | ₹0 (limited monthly builds, queue waits) |
| Sideloading the APK onto Android phones | **Free** |
| Google Play Store listing | **$25 one-time** developer fee |
| Apple App Store / TestFlight | **$99 / year** Apple Developer Program |
| Running on *your own* iPhone without paying | Possible with Xcode + a free Apple ID, but the build expires after 7 days |

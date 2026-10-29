# @nova/mobile — Nova for Android & iOS

Expo (SDK 58, React Native 0.88) + expo-router + TypeScript. Talks to `apps/api` through the typed
client in `@nova/shared`. All speech happens **on the device** (no paid speech APIs).

| Screen | What's there |
|---|---|
| Login / Register | JWT stored in `expo-secure-store`; "Use demo account" button (`demo@nova.app` / `password123`) |
| **Assistant** (home) | Animated robot orb (idle / listening / thinking / speaking), tap-or-hold mic, live transcript, captions, action chips, Yes/No confirmation, text input |
| Expenses | Month total, category bars, budgets with progress, recent list (long-press → delete), add-expense sheet, pull-to-refresh, auto-refetch after the assistant changes data |
| Settings | Rename assistant, "Speak replies" toggle, voice/API diagnostics, log out |

## Run it

From the repo root: `pnpm install` (once), then start the API (`pnpm dev:api`, port 4000).

### Option A — Expo Go (fastest, text mode)

```bash
cd apps/mobile
pnpm start            # or: npx expo start
```

Scan the QR code with **Expo Go** (Android) or the Camera app (iOS). Everything works **except voice
input**: `expo-speech-recognition` is a native module that isn't in Expo Go. The app detects that at
runtime, shows a notice, and you type to the assistant instead. Spoken replies (`expo-speech`) still work.

### Option B — Development build (full voice)

Voice input needs a build that includes the native speech module. Both ways are free:

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
  Set `EXPO_PUBLIC_API_URL` in `eas.json` → `build.preview.env` to your machine's LAN IP first:
  a standalone APK has no Metro server to derive the address from. (For an EAS *development* client
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
`expo-build-properties` → `usesCleartextTraffic`. Use HTTPS for anything public.

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
src/app/(tabs)/              index (Assistant), expenses, settings
src/components/Orb.tsx       reanimated + react-native-svg robot orb
src/components/MicButton.tsx tap-to-toggle / hold-to-talk mic
src/hooks/useVoice.ts        STT (expo-speech-recognition, feature-detected) + TTS (expo-speech)
src/lib/api.ts               base URL resolution + shared createApiClient()
src/lib/auth.tsx             AuthProvider (SecureStore JWT, 401 → logout)
src/lib/app-state.tsx        speak-replies setting + data-version for cross-tab refetch
src/constants/theme.ts       colors, spacing, category colors/icons
```

## Honest costs

| | Cost |
|---|---|
| Expo Go, local dev builds (`expo run:*`), on-device speech, TTS | **₹0** |
| EAS Build free tier | ₹0 (limited monthly builds, queue waits) |
| Sideloading the APK onto Android phones | **Free** |
| Google Play Store listing | **$25 one-time** developer fee |
| Apple App Store / TestFlight | **$99 / year** Apple Developer Program |
| Running on *your own* iPhone without paying | Possible with Xcode + a free Apple ID, but the build expires after 7 days |

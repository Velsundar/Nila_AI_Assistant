import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Static config lives in app.json; this file only adds what depends on the build variant.
 *
 * APP_VARIANT=production (set by the EAS "production" profile) turns OFF plain-http traffic on
 * Android, so release builds can only talk to an https API. Every other build (Expo Go, local
 * `expo run:*`, the EAS "preview" APK) keeps `usesCleartextTraffic` so it can reach the API on
 * your LAN at http://<ip>:4000.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const production = process.env.APP_VARIANT === "production";
  return {
    ...(config as ExpoConfig),
    plugins: [
      ...(config.plugins ?? []),
      ["expo-build-properties", { android: { usesCleartextTraffic: !production } }],
    ],
  };
};

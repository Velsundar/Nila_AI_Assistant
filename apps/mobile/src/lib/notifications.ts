import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useAppState } from "./app-state";

/**
 * Local notifications only — no push server, no cost.
 *
 * Expo Go (SDK 58): local scheduled notifications work on iOS and Android. Remote *push* was
 * removed from Expo Go on Android in SDK 53 — we never use push, but `expo-notifications` still
 * prints a one-time "not fully supported in Expo Go" warning when imported. Harmless.
 */

export const WEEKLY_REPORT_ID = "nova-weekly-report";
const CHANNEL_ID = "weekly-report";

// Show the banner even if the app is in the foreground when it fires.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const req = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return req.granted;
}

/**
 * Schedules "Your weekly spending report is ready" for every Sunday at 9:00 local time.
 * Idempotent (fixed identifier). Throws with a user-facing message on failure.
 */
export async function scheduleWeeklyReport(assistantName: string): Promise<void> {
  if (!(await ensurePermission())) {
    throw new Error("Notifications are turned off for this app. Enable them in your phone's Settings to get the weekly report.");
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Weekly spending report",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#38BDF8",
    });
  }
  await Notifications.cancelScheduledNotificationAsync(WEEKLY_REPORT_ID).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: WEEKLY_REPORT_ID,
    content: {
      title: assistantName,
      body: "Your weekly spending report is ready",
      data: { intent: "weeklyReport" },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: 1, // 1 = Sunday
      hour: 9,
      minute: 0,
      channelId: CHANNEL_ID,
    },
  });
}

export async function cancelWeeklyReport(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(WEEKLY_REPORT_ID).catch(() => {});
}

/** Next fire time, for display in Settings. */
export async function nextWeeklyReportDate(): Promise<Date | null> {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    if (!all.some((n) => n.identifier === WEEKLY_REPORT_ID)) return null;
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    next.setDate(now.getDate() + ((7 - now.getDay()) % 7));
    if (next <= now) next.setDate(next.getDate() + 7);
    return next;
  } catch {
    return null;
  }
}

/**
 * Mount once inside the signed-in area. When the user taps the weekly-report notification
 * (including a cold start from it), opens the assistant and queues "read the weekly report".
 */
export function useNotificationIntents() {
  const response = Notifications.useLastNotificationResponse();
  const { setPendingIntent } = useAppState();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const req = response.notification.request;
    const key = `${req.identifier}:${response.notification.date}`;
    if (handled.current === key) return;
    handled.current = key;
    if ((req.content.data as { intent?: string } | undefined)?.intent !== "weeklyReport") return;
    setPendingIntent({ kind: "weeklyReport", id: key });
    router.navigate("/");
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }, [response, setPendingIntent]);
}

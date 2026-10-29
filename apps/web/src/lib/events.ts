/** Fired (same tab) whenever expenses/budgets/reminders change, e.g. after an assistant action. */
export const DATA_CHANGED_EVENT = "nova:data-changed";
/** Bumped in localStorage so other open tabs refetch too. */
export const DATA_VERSION_KEY = "nova.dataVersion";

export function notifyDataChanged() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DATA_VERSION_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
}

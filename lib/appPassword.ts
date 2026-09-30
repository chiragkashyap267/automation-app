"use client";

/**
 * The app password, kept in this browser and sent with every request that
 * spends API quota. It is never in the bundle — the user types it once.
 */
const KEY = "jdmailer.apppassword.v1";
export const PASSWORD_HEADER = "x-app-password";

export function loadPassword(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePassword(value: string) {
  try {
    if (value) window.localStorage.setItem(KEY, value);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private mode — it will just be asked for again */
  }
}

/** Adds the password header to a fetch init. */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const password = loadPassword();
  return password ? { ...extra, [PASSWORD_HEADER]: password } : extra;
}

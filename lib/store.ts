"use client";

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "./appPassword";
import { SEED_PROFILE } from "./seed";
import { EMPTY_PROFILE, type Draft, type Profile } from "./types";

const PROFILE_KEY = "jdmailer.profile.v1";
const DRAFTS_KEY = "jdmailer.drafts.v1";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadProfile(): Profile {
  if (typeof window === "undefined") return EMPTY_PROFILE;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    // Nothing saved yet — start from the seed rather than a blank form.
    if (!raw) return { ...EMPTY_PROFILE, ...SEED_PROFILE };
    return { ...EMPTY_PROFILE, ...(JSON.parse(raw) as Partial<Profile>) };
  } catch {
    return { ...EMPTY_PROFILE, ...SEED_PROFILE };
  }
}

export function saveProfile(profile: Profile) {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* private mode, quota — the app still works for this session */
  }
}

export function loadDrafts(): Draft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as Draft[]) : [];
  } catch {
    return [];
  }
}

export function saveDrafts(drafts: Draft[]) {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* ignore */
  }
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Pushes the profile to the server so the Telegram bot writes from the same
 * details. Debounced, because this runs on every keystroke in the Details
 * form. Credentials are stripped server-side before anything is stored.
 */
function queueMirror(profile: Profile) {
  if (typeof window === "undefined") return;
  if (mirrorTimer) clearTimeout(mirrorTimer);

  mirrorTimer = setTimeout(() => {
    void fetch("/api/profile", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ profile }),
      // Failing to mirror is not worth interrupting anyone over.
    }).catch(() => {});
  }, 2000);
}

/** Profile state that hydrates from localStorage after mount, to keep SSR stable. */
export function useProfile() {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<Profile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      saveProfile(next);
      queueMirror(next);
      return next;
    });
  }, []);

  return { profile, update, ready };
}

/** The profile is complete enough to write an email from. */
export function profileIsUsable(p: Profile): boolean {
  return Boolean(p.fullName.trim() && (p.resumeText.trim() || p.skills.trim()));
}

export function canSend(p: Profile): boolean {
  return Boolean(p.gmailUser.trim() && p.gmailAppPassword.trim());
}

/**
 * Which half of the Gmail setup is missing, named exactly.
 *
 * Both halves are needed and they fail identically, so a message that only
 * ever mentions the password sends people to re-type the one thing that was
 * already right. These credentials live in this browser and nowhere else —
 * setting them on the server configures the Telegram bot, not this page.
 */
export function missingSendField(p: Profile): "address" | "password" | "both" | null {
  const hasUser = Boolean(p.gmailUser.trim());
  const hasPass = Boolean(p.gmailAppPassword.trim());
  if (hasUser && hasPass) return null;
  if (!hasUser && !hasPass) return "both";
  return hasUser ? "password" : "address";
}

export function missingSendLabel(p: Profile): string {
  switch (missingSendField(p)) {
    case "both":
      return "your Gmail address and App Password";
    case "address":
      return "your Gmail address (the App Password is saved)";
    case "password":
      return "your Gmail App Password";
    default:
      return "";
  }
}

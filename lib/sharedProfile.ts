import { kvConfigured, kvGet, kvSet } from "./kv";
import { SEED_PROFILE } from "./seed";
import { EMPTY_PROFILE, type Profile } from "./types";

/**
 * One profile, readable by both halves of the app.
 *
 * The web app keeps the authoritative copy in the browser, because that is
 * where the Gmail password belongs. It mirrors the rest here so the Telegram
 * bot — which has no browser — writes emails from the same details. Without
 * this the bot is frozen at whatever was hardcoded at deploy time.
 */

const KEY = "profile:v1";
const TTL = 365 * 24 * 60 * 60;

/** Credentials are deliberately not mirrored; the bot gets its own from env. */
const SECRET_FIELDS = ["gmailAppPassword", "resumeFileData"] as const;

export type SharedProfile = Omit<Profile, (typeof SECRET_FIELDS)[number]>;

export function stripSecrets(profile: Profile): SharedProfile {
  const copy = { ...profile } as Partial<Profile>;
  for (const field of SECRET_FIELDS) delete copy[field];
  return copy as SharedProfile;
}

export async function saveSharedProfile(profile: SharedProfile): Promise<boolean> {
  if (!kvConfigured()) return false;
  return kvSet(KEY, profile, TTL);
}

/**
 * The bot's profile: whatever the web app last mirrored, falling back to the
 * seed. Gmail credentials always come from the environment, never from the
 * shared copy.
 */
export async function loadBotProfile(): Promise<Profile> {
  const shared = kvConfigured() ? await kvGet<SharedProfile>(KEY) : null;

  return {
    ...EMPTY_PROFILE,
    ...SEED_PROFILE,
    ...(shared ?? {}),
    gmailUser: (process.env.GMAIL_USER ?? "").trim(),
    gmailAppPassword: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
    resumeFileData: "",
  };
}

export function sharedProfileAvailable(): boolean {
  return kvConfigured();
}

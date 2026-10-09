import type { Profile } from "./types";

/**
 * The defaults a brand-new install starts from.
 *
 * Deliberately impersonal. This file used to hold a real profile — name,
 * phone, skills and a full resume with employers and dates — as a
 * convenience for the first run. It was also the fallback the bot wrote
 * from whenever the shared store came back empty, which made it a quiet
 * hazard: the day the real resume changed, that fallback became a set of
 * claims the resume no longer supported, and the only symptom would have
 * been an email describing the wrong job history.
 *
 * So nothing identifying lives here now. An empty profile is obvious —
 * the bot says it has nothing to write from, and /status says the same.
 * A wrong profile is not obvious at all.
 *
 * Only settings with a sensible universal default remain. Everything else
 * comes from Details in the web app, which mirrors to the store the bot
 * reads.
 */
export const SEED_PROFILE: Partial<Profile> = {
  tone: "warm",
  signOff: "Best regards",
};

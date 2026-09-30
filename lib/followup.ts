import type { Outbound, StateMap } from "./outbox";
import { buildSignature } from "./signature";
import type { Profile } from "./types";

/**
 * Deciding which applications have gone quiet, and what to say to them.
 *
 * Most replies come from the second email rather than the first, so this is
 * worth having — but a follow-up is also the easiest way to turn a polite
 * applicant into a nuisance. The rules below are deliberately conservative:
 * one nudge per application ever, only in a sensible window, and never to
 * someone who already answered.
 */

/** Under a week is pestering; recruiters routinely take five working days. */
export const QUIET_DAYS = 7;

/** Past a month the thread is cold and a nudge reads as desperate. */
export const STALE_DAYS = 30;

/** A day's worth of nudges. Small on purpose — these all look alike. */
export const MAX_PER_RUN = 10;

const DAY = 24 * 60 * 60 * 1000;

export type FollowUpReason =
  | "ready"
  | "too-soon"
  | "too-old"
  | "replied"
  | "bounced"
  | "already-nudged"
  | "no-recipient";

export function assessFollowUp(
  entry: Outbound,
  state: StateMap,
  now = Date.now(),
): { ready: boolean; reason: FollowUpReason; daysAgo: number } {
  const daysAgo = Math.floor((now - entry.sentAt) / DAY);
  const current = state[entry.id] ?? {};

  const reason: FollowUpReason = !entry.to?.length
    ? "no-recipient"
    : current.bounced
      ? "bounced"
      : current.repliedAt
        ? "replied"
        : current.followedUpAt
          ? "already-nudged"
          : daysAgo < QUIET_DAYS
            ? "too-soon"
            : daysAgo > STALE_DAYS
              ? "too-old"
              : "ready";

  return { ready: reason === "ready", reason, daysAgo };
}

/**
 * The applications worth nudging, oldest first — those have waited longest and
 * are closest to falling out of the window entirely.
 */
export function selectFollowUps(
  entries: Outbound[],
  state: StateMap,
  now = Date.now(),
  max = MAX_PER_RUN,
): { entry: Outbound; daysAgo: number }[] {
  const ready: { entry: Outbound; daysAgo: number }[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const verdict = assessFollowUp(entry, state, now);
    if (!verdict.ready) continue;

    // Two applications to one address get one nudge between them.
    const key = entry.to.map((t) => t.toLowerCase()).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    ready.push({ entry, daysAgo: verdict.daysAgo });
  }

  return ready.sort((a, b) => a.entry.sentAt - b.entry.sentAt).slice(0, max);
}

/** Recruiters read mail on weekdays; a Sunday nudge just ages badly. */
export function isWorkday(now = new Date()): boolean {
  const day = now.getDay();
  return day >= 1 && day <= 5;
}

function greeting(entry: Outbound): string {
  const name = entry.contactName?.trim();
  return name ? `Hi ${name.split(/\s+/)[0]},` : "Hello,";
}

/** "Re: x" must not become "Re: Re: x" if the original already had one. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Three sentences: what it is about, that interest stands, an easy out.
 *
 * No apology for writing and no guilt about the silence — both read badly,
 * and the recipient owes nothing here.
 */
export function buildFollowUp(
  entry: Outbound,
  profile: Profile,
  daysAgo: number,
): { subject: string; body: string } {
  const role = entry.role?.trim();
  const company = entry.company?.trim();
  const about = role
    ? `the ${role} role${company ? ` at ${company}` : ""}`
    : company
      ? `the opening at ${company}`
      : "the role I wrote to you about";

  const when = daysAgo >= 14 ? "a couple of weeks ago" : `${daysAgo} days ago`;

  const lines = [
    greeting(entry),
    "",
    `I applied for ${about} ${when} and wanted to check my email had reached the right person.`,
    "",
    "I am still keen, and happy to send anything else that would help. If the position is filled, do let me know and I will stop watching for it.",
    "",
    buildSignature(profile),
  ];

  return { subject: replySubject(entry.subject), body: lines.join("\n") };
}

/** The chat message offering the nudges, with nothing sent yet. */
export function describeCandidates(
  candidates: { entry: Outbound; daysAgo: number }[],
): string {
  const nl = String.fromCharCode(10);
  const lines = candidates.map(
    ({ entry, daysAgo }) =>
      `• ${entry.company || entry.to[0] || "Unknown"} — ${entry.role || "role"} (${daysAgo}d)`,
  );

  return [
    `🔔 ${candidates.length} application${candidates.length === 1 ? " has" : "s have"} gone quiet`,
    "",
    lines.join(nl),
    "",
    "I can reply once in each original thread — three short lines, nothing pushy. Nothing goes out until you tap.",
  ].join(nl);
}

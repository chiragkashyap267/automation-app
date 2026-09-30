import { countSends, DAILY_HARD_LIMIT, sendsToday } from "./batch";
import {
  buildFollowUp,
  MAX_PER_RUN,
  QUIET_DAYS,
  selectFollowUps,
  STALE_DAYS,
} from "./followup";
import { scanInbox, type ScanResult, type SentItem } from "./inboxScan";
import { preflight, sendMail, type MailRequest } from "./mailer";
import {
  claimFollowUp,
  loadOutbox,
  loadState,
  mergeState,
  outboxAvailable,
  type Outbound,
  type StateMap,
} from "./outbox";
import type { Profile } from "./types";

/**
 * Finding the applications that have gone quiet, and nudging them once.
 *
 * Shared by the daily scheduled job and the bot's own button, which matters
 * more than it sounds: the button re-runs the whole check rather than trusting
 * the list the job posted hours earlier. A reply that arrived in between must
 * cancel the nudge, and the only way to be sure is to look again.
 */

const DAY = 24 * 60 * 60 * 1000;

/** A pause between sends; a burst of near-identical mail is the thing to avoid. */
const GAP_MS = 1200;

export type Candidate = { entry: Outbound; daysAgo: number };

/** How far back an unanswered application is still worth asking Gmail about. */
const REVIEW_DAYS = 45;

export type InboxReview = {
  outbox: Outbound[];
  state: StateMap;
  /** What this scan newly discovered, for the digest. */
  fresh: ScanResult[];
  /** null when the inbox could not be read at all. */
  scanned: number | null;
};

/**
 * One pass over the inbox, shared by everything that runs in the morning.
 *
 * The follow-up offer and the digest both need to know what has been
 * answered, and opening two IMAP connections to ask the same question would
 * be wasteful as well as slower.
 */
export async function reviewInbox(profile: Profile, now = Date.now()): Promise<InboxReview> {
  const empty: InboxReview = { outbox: [], state: {}, fresh: [], scanned: null };
  if (!outboxAvailable()) return empty;

  const outbox = await loadOutbox();
  const state = await loadState();
  if (!outbox.length) return { outbox, state, fresh: [], scanned: 0 };

  const unresolved = outbox.filter((e) => {
    const s = state[e.id];
    return !s?.repliedAt && !s?.bounced && now - e.sentAt <= REVIEW_DAYS * DAY;
  });
  if (!unresolved.length) return { outbox, state, fresh: [], scanned: 0 };

  const user = profile.gmailUser?.trim() ?? "";
  const pass = profile.gmailAppPassword?.replace(/\s+/g, "") ?? "";
  if (!user || !pass) return { ...empty, outbox, state };

  try {
    const items: SentItem[] = unresolved.map((e) => ({
      id: e.id,
      messageId: e.messageId,
      to: e.to,
      sentAt: e.sentAt,
    }));
    const found = await scanInbox({ user, pass }, items);

    const patch: StateMap = {};
    for (const row of found.results) {
      patch[row.id] =
        row.reply === "bounced" ? { bounced: true } : { repliedAt: row.at, kind: row.kind };
    }

    const merged: StateMap = { ...state };
    if (Object.keys(patch).length) {
      await mergeState(patch);
      for (const [id, change] of Object.entries(patch)) merged[id] = { ...merged[id], ...change };
    }

    return { outbox, state: merged, fresh: found.results, scanned: found.scanned };
  } catch (err) {
    console.error("[followup] inbox scan", err instanceof Error ? err.message : err);
    return { ...empty, outbox, state };
  }
}

/**
 * Everything eligible for a nudge right now, after re-checking the inbox.
 *
 * `scanned` is null when the inbox could not be read — in which case nothing
 * is offered, because a nudge to someone who already answered is worse than
 * no nudge at all.
 */
export async function findQuiet(
  profile: Profile,
  now = Date.now(),
  review?: InboxReview,
): Promise<{ candidates: Candidate[]; scanned: number | null; total: number }> {
  const seen = review ?? (await reviewInbox(profile, now));
  if (seen.scanned === null) {
    return { candidates: [], scanned: null, total: seen.outbox.length };
  }

  const window = seen.outbox.filter((e) => {
    const age = now - e.sentAt;
    return age >= QUIET_DAYS * DAY && age <= STALE_DAYS * DAY;
  });

  return {
    candidates: selectFollowUps(window, seen.state, now, MAX_PER_RUN),
    scanned: seen.scanned,
    total: seen.outbox.length,
  };
}

export type SendFollowUpsDeps = {
  attachment?: () => Promise<MailRequest["attachment"]>;
  send?: (req: MailRequest) => Promise<string>;
  /** Which chat's daily counter this draws from. */
  chatId: number;
};

export type FollowUpOutcome = { label: string; ok: boolean; detail: string };

/**
 * Sends the nudges, one at a time.
 *
 * Each is claimed before it goes out, so a retried webhook or an overlapping
 * cron run cannot produce a second copy — the claim is taken even if the send
 * then fails, because "we tried once" is the safer thing to remember.
 */
export async function sendFollowUps(
  candidates: Candidate[],
  profile: Profile,
  deps: SendFollowUpsDeps,
): Promise<{ sent: number; outcomes: FollowUpOutcome[] }> {
  const { send = sendMail, attachment, chatId } = deps;
  const outcomes: FollowUpOutcome[] = [];

  if (!profile.gmailUser || !profile.gmailAppPassword) {
    return { sent: 0, outcomes: [{ label: "Gmail", ok: false, detail: "credentials not set" }] };
  }

  const already = await sendsToday(chatId);
  const room = Math.max(0, DAILY_HARD_LIMIT - already);
  const queue = candidates.slice(0, room);

  if (candidates.length > queue.length) {
    outcomes.push({
      label: "Daily limit",
      ok: false,
      detail: `${candidates.length - queue.length} held back — ${already} already sent today`,
    });
  }

  // The resume went with the original; attaching it again is optional and off
  // by default, because the thread already has it.
  const file = attachment ? await attachment() : undefined;
  const done: StateMap = {};
  let sent = 0;

  for (let i = 0; i < queue.length; i++) {
    const { entry, daysAgo } = queue[i];
    const label = `${entry.company || entry.to[0] || "Unknown"} — ${entry.role || "role"}`;

    if (!(await claimFollowUp(entry.id))) {
      outcomes.push({ label, ok: false, detail: "already nudged" });
      continue;
    }

    const { subject, body } = buildFollowUp(entry, profile, daysAgo);
    const problem = preflight({ to: entry.to, subject, text: body });
    if (problem) {
      outcomes.push({ label, ok: false, detail: problem });
      continue;
    }

    try {
      await send({
        user: profile.gmailUser,
        pass: profile.gmailAppPassword,
        fromName: profile.fullName,
        to: entry.to,
        cc: profile.ccSelf ? profile.gmailUser : undefined,
        replyTo: profile.email || undefined,
        subject,
        text: body,
        // Both headers, so it lands inside the original thread rather than
        // arriving as an unrelated second email.
        inReplyTo: entry.messageId || undefined,
        references: entry.messageId || undefined,
        attachment: file,
      });
      sent += 1;
      done[entry.id] = { followedUpAt: Date.now() };
      outcomes.push({ label, ok: true, detail: `${daysAgo} days` });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[followup] send", raw);
      outcomes.push({ label, ok: false, detail: raw.slice(0, 80) });
    }

    if (i < queue.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }

  if (sent) {
    await mergeState(done);
    await countSends(chatId, sent);
  }

  return { sent, outcomes };
}

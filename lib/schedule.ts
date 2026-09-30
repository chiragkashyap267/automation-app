import type { BatchDraft } from "./batch";
import { deliverDrafts, type Delivery, type DeliverDeps } from "./deliver";
import { kvAppend, kvConfigured, kvDelete, kvRange } from "./kv";
import type { Profile } from "./types";

/**
 * Holding drafts back until a weekday morning.
 *
 * Mail written at midnight and sent at midnight reads as automated, and
 * rightly so. Queuing it for the next working morning costs nothing and puts
 * it at the top of an inbox at the moment someone is actually reading.
 *
 * Nothing is queued without an explicit tap, and the queue is flushed by the
 * same scheduled job that offers follow-ups.
 */

const QUEUE_KEY = (chatId: number) => `queue:${chatId}`;
const TTL = 7 * 24 * 60 * 60;
const MAX_QUEUED = 50;

/** 04:00 UTC, which the cron is set to and which is 09:30 in India. */
export const SEND_HOUR_UTC = 4;

export const schedulingAvailable = kvConfigured;

export async function queueDrafts(chatId: number, drafts: BatchDraft[]): Promise<number> {
  if (!kvConfigured() || !drafts.length) return 0;

  let total = 0;
  for (const draft of drafts) {
    const length = await kvAppend(QUEUE_KEY(chatId), draft, MAX_QUEUED, TTL);
    if (length !== null) total = length;
  }
  return total;
}

export async function loadQueue(chatId: number): Promise<BatchDraft[]> {
  if (!kvConfigured()) return [];

  const stored = await kvRange<BatchDraft>(QUEUE_KEY(chatId), MAX_QUEUED);

  // The same posting queued twice goes out once.
  const seen = new Set<string>();
  return stored.filter((d) => {
    const key = `${d.subject}|${d.to.join()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function clearQueue(chatId: number): Promise<void> {
  await kvDelete(QUEUE_KEY(chatId));
}

/**
 * The next weekday 04:00 UTC strictly after `now`.
 *
 * Friday evening's queue waits for Monday rather than going out on a Saturday
 * when nobody is reading and a burst looks most like a machine.
 */
export function nextWindow(now = new Date()): Date {
  const at = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SEND_HOUR_UTC, 0, 0, 0),
  );
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** How the wait is described in chat, in the user's own timezone. */
export function describeWindow(now = new Date(), offsetMinutes = 330): string {
  const at = nextWindow(now);
  const local = (d: Date) => new Date(d.getTime() + offsetMinutes * 60_000);
  const there = local(at);
  const here = local(now);

  const clock = `${there.getUTCHours()}:${String(there.getUTCMinutes()).padStart(2, "0")}am`;
  const daysApart = Math.round(
    (Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate()) -
      Date.UTC(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate())) /
      86_400_000,
  );

  if (daysApart === 0) return `today at about ${clock}`;
  if (daysApart === 1) return `tomorrow at about ${clock}`;
  return `${DAY_NAMES[there.getUTCDay()]} at about ${clock}`;
}

/**
 * Empties the queue into the morning's send.
 *
 * The queue is cleared whether or not every message got through: a draft that
 * failed at 9:30 will fail again, and silently retrying mail to a stranger
 * every morning is exactly the pattern that gets an account flagged. Failures
 * are reported instead.
 */
export async function sendQueued(
  chatId: number,
  profile: Profile,
  deps: DeliverDeps = {},
): Promise<Delivery & { queued: number }> {
  const queued = await loadQueue(chatId);
  if (!queued.length) return { sent: 0, attempted: 0, results: [], queued: 0 };

  const delivery = await deliverDrafts(chatId, queued, profile, deps);
  if (!delivery.refused) await clearQueue(chatId);

  return { ...delivery, queued: queued.length };
}

import { kvClaim, kvConfigured, kvGet, kvList, kvPush, kvSet } from "./kv";

/**
 * A server-side record of everything this app has actually sent.
 *
 * The browser already keeps a history in localStorage, but a scheduled job has
 * no browser — and neither does the Telegram bot. Anything that wants to look
 * at past sends without a tab being open has to read them from here.
 *
 * The log itself is append-only. Whether an application was answered, or has
 * already been nudged, changes over time, so that lives in a separate map —
 * and the "already nudged" decision is additionally protected by an atomic
 * claim, because sending a second follow-up is the one mistake that is visible
 * to the recipient.
 */

const LOG_KEY = "outbox:v1";
const STATE_KEY = "outbox:state:v1";
const KEEP = 500;
const STATE_TTL = 180 * 24 * 60 * 60;
const CLAIM_TTL = 180 * 24 * 60 * 60;

export type Outbound = {
  id: string;
  /** SMTP Message-ID — what threads a follow-up onto the original. */
  messageId: string;
  to: string[];
  company: string;
  role: string;
  contactName: string;
  subject: string;
  sentAt: number;
  /** Where it was sent from, and which chat to report back to. */
  via: "web" | "bot";
  chatId: number | null;
};

export type OutboundState = {
  /** When a reply was seen, if one was. */
  repliedAt?: number;
  /** interview / rejection / auto / recruiter / other */
  kind?: string;
  /** When a follow-up went out, if one did. */
  followedUpAt?: number;
  /** The original could not be delivered — never nudge these. */
  bounced?: boolean;
};

export type StateMap = Record<string, OutboundState>;

export const outboxAvailable = kvConfigured;

export async function recordOutbound(entry: Outbound): Promise<void> {
  if (!kvConfigured()) return;
  await kvPush(LOG_KEY, entry, KEEP);
}

export async function loadOutbox(limit = KEEP): Promise<Outbound[]> {
  if (!kvConfigured()) return [];
  return kvList<Outbound>(LOG_KEY, limit);
}

export async function loadState(): Promise<StateMap> {
  if (!kvConfigured()) return {};
  return (await kvGet<StateMap>(STATE_KEY)) ?? {};
}

/** Merges patches into the state map. Last writer wins per field. */
export async function mergeState(patch: StateMap): Promise<void> {
  if (!kvConfigured() || !Object.keys(patch).length) return;

  const current = await loadState();
  for (const [id, change] of Object.entries(patch)) {
    current[id] = { ...current[id], ...change };
  }
  await kvSet(STATE_KEY, current, STATE_TTL);
}

/**
 * Takes the exclusive right to follow up on one application.
 *
 * Returns false if it was already taken, which is the answer whether the
 * earlier claim came from a cron run, a second tap on the same button, or a
 * retried webhook delivery.
 */
export async function claimFollowUp(id: string): Promise<boolean> {
  if (!kvConfigured()) return false;
  return kvClaim(`outbox:fu:${id}`, CLAIM_TTL);
}

import { kvConfigured, kvDelete, kvGet, kvIncrement, kvSet } from "./kv";

/**
 * A batch is the set of drafts built up from screenshots sent one after
 * another, so they can go out behind a single Send-all button.
 *
 * It lives for half an hour. Long enough to work through a folder of
 * screenshots; short enough that yesterday's leftovers never get sent by
 * accident.
 */

export type BatchDraft = {
  company: string;
  role: string;
  to: string[];
  subject: string;
  /** Already composed, signature included — exactly what will be sent. */
  body: string;
};

export type Batch = {
  drafts: BatchDraft[];
  /** The summary message carrying the Send-all button, so it can be updated. */
  summaryMessageId: number | null;
  startedAt: number;
};

const TTL = 30 * 60;
const MAX_DRAFTS = 25;

const batchKey = (chatId: number) => `batch:${chatId}`;
const sentTodayKey = (chatId: number) => `sent:${chatId}:${new Date().toISOString().slice(0, 10)}`;

export const batchingAvailable = kvConfigured;

export async function loadBatch(chatId: number): Promise<Batch | null> {
  return kvGet<Batch>(batchKey(chatId));
}

export async function addToBatch(chatId: number, draft: BatchDraft): Promise<Batch | null> {
  const existing = (await loadBatch(chatId)) ?? {
    drafts: [],
    summaryMessageId: null,
    startedAt: Date.now(),
  };

  // Never send the same posting twice because a screenshot was shared twice.
  const duplicate = existing.drafts.some(
    (d) => d.subject === draft.subject && d.to.join() === draft.to.join(),
  );
  if (!duplicate && existing.drafts.length < MAX_DRAFTS) existing.drafts.push(draft);

  const saved = await kvSet(batchKey(chatId), existing, TTL);
  return saved ? existing : null;
}

export async function setSummaryMessage(chatId: number, messageId: number): Promise<void> {
  const batch = await loadBatch(chatId);
  if (!batch) return;
  batch.summaryMessageId = messageId;
  await kvSet(batchKey(chatId), batch, TTL);
}

export async function clearBatch(chatId: number): Promise<void> {
  await kvDelete(batchKey(chatId));
}

/* ───────────────────────── daily sending limits ───────────────────────── */

export const DAILY_SOFT_LIMIT = 40;
export const DAILY_HARD_LIMIT = 80;

/**
 * The web app counts a day's sending from its own history; the bot has no
 * browser, so it keeps the same count here. Without a store it cannot count,
 * and a batch is capped at 25 regardless — so a single burst stays sane.
 */
export async function countSends(chatId: number, howMany: number): Promise<number | null> {
  let total: number | null = null;
  for (let i = 0; i < howMany; i++) {
    total = await kvIncrement(sentTodayKey(chatId), 24 * 60 * 60);
  }
  return total;
}

export async function sendsToday(chatId: number): Promise<number> {
  const raw = await kvGet<number>(sentTodayKey(chatId));
  return typeof raw === "number" ? raw : 0;
}

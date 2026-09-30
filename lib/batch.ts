import {
  kvAppend,
  kvConfigured,
  kvDelete,
  kvGet,
  kvIncrement,
  kvRange,
  kvSet,
} from "./kv";

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
  contactName?: string;
  /** Message-ID this is a reply to, when it answers mail we received. */
  inReplyTo?: string;
  /** A pitch carries no resume and gets a different follow-up. */
  kind?: "application" | "pitch";
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

/**
 * The drafts live in a list and everything else in a small companion key.
 *
 * They are split because the drafts are written concurrently — an album of
 * ten screenshots is ten simultaneous webhook calls — and only a list append
 * survives that. The summary message id is written by one caller at a time,
 * so an ordinary read-modify-write is fine for it.
 */
const draftsKey = (chatId: number) => `batch:${chatId}:drafts`;
const metaKey = (chatId: number) => `batch:${chatId}:meta`;
const seqKey = (chatId: number) => `batch:${chatId}:seq`;
const sentTodayKey = (chatId: number) => `sent:${chatId}:${new Date().toISOString().slice(0, 10)}`;

type BatchMeta = { summaryMessageId: number | null; startedAt: number };

export const batchingAvailable = kvConfigured;

export async function loadBatch(chatId: number): Promise<Batch | null> {
  if (!kvConfigured()) return null;

  const [stored, meta] = await Promise.all([
    kvRange<BatchDraft>(draftsKey(chatId), MAX_DRAFTS),
    kvGet<BatchMeta>(metaKey(chatId)),
  ]);
  if (!stored.length && !meta) return null;

  // Two screenshots of one posting arrive as two drafts. The duplicate check
  // has to happen here rather than on write: concurrent appends cannot see
  // each other, which is the whole point of appending.
  const seen = new Set<string>();
  const drafts = stored.filter((d) => {
    const key = `${d.subject}|${d.to.join()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    drafts,
    summaryMessageId: meta?.summaryMessageId ?? null,
    startedAt: meta?.startedAt ?? Date.now(),
  };
}

export async function addToBatch(chatId: number, draft: BatchDraft): Promise<Batch | null> {
  if (!kvConfigured()) return null;

  const length = await kvAppend(draftsKey(chatId), draft, MAX_DRAFTS, TTL);
  if (length === null) return null;

  // First one in starts the batch; the rest only refresh its lifetime.
  if (length === 1) {
    await kvSet(metaKey(chatId), { summaryMessageId: null, startedAt: Date.now() }, TTL);
  }

  return loadBatch(chatId);
}

/**
 * Whether this invocation is the last of a burst, and so the one that should
 * post the summary.
 *
 * Each caller takes a ticket, waits out the gap between album photos, and
 * then checks whether anything came after it. Ten photos produce ten tickets
 * and exactly one winner — the one that can see all ten drafts.
 */
export async function isLastOfBurst(chatId: number, settleMs = 2500): Promise<boolean> {
  if (!kvConfigured()) return true;

  const mine = await kvIncrement(seqKey(chatId), 60);
  if (mine === null) return true;

  await new Promise((r) => setTimeout(r, settleMs));

  const latest = await kvGet<number>(seqKey(chatId));
  return latest === null || Number(latest) === mine;
}

export async function setSummaryMessage(chatId: number, messageId: number): Promise<void> {
  const meta = (await kvGet<BatchMeta>(metaKey(chatId))) ?? {
    summaryMessageId: null,
    startedAt: Date.now(),
  };
  meta.summaryMessageId = messageId;
  await kvSet(metaKey(chatId), meta, TTL);
}

export async function clearBatch(chatId: number): Promise<void> {
  await Promise.all([
    kvDelete(draftsKey(chatId)),
    kvDelete(metaKey(chatId)),
    kvDelete(seqKey(chatId)),
  ]);
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

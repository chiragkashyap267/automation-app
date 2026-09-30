"use client";

import {
  findPriorApplication,
  type PriorApplication,
} from "./priorApplication";
import type { Draft } from "./types";

/**
 * A durable log of everything that was actually sent.
 *
 * Drafts get cleared; this does not. It is what the insights are computed from,
 * and what reply checking matches incoming mail against.
 */

export type ReplyState = "awaiting" | "replied" | "auto" | "bounced";

export type SentEmail = {
  id: string;
  /** SMTP Message-ID, used to match a threaded reply. */
  messageId: string;
  to: string[];
  company: string;
  role: string;
  seniority: string;
  subject: string;
  /** Which recipe family this came from, for per-recipe reply rates. */
  recipeKey: string;
  /** Model-written, recipe-rendered, or local. */
  source: Draft["source"];
  /** Whether the user edited it before sending. */
  edited: boolean;
  sentAt: number;
  reply: ReplyState;
  replyAt: number;
  replyFrom: string;
  replySubject: string;
  /** interview / rejection / recruiter / other, from replyKind.ts */
  replyKind: string;
  lastCheckedAt: number;
};

const KEY = "jdmailer.history.v1";
const MAX = 800;

function read(): SentEmail[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SentEmail[]) : [];
  } catch {
    return [];
  }
}

function write(rows: SentEmail[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX)));
  } catch {
    /* quota — the log simply stops growing */
  }
}

export function loadHistory(): SentEmail[] {
  return read();
}

export function recordSent(draft: Draft, messageId: string, edited: boolean) {
  const rows = read();
  rows.unshift({
    id: draft.id,
    messageId,
    to: draft.recipients,
    company: draft.company,
    role: draft.role,
    seniority: draft.seniority,
    subject: draft.subject,
    recipeKey: draft.recipeKey,
    source: draft.source,
    edited,
    sentAt: Date.now(),
    reply: "awaiting",
    replyAt: 0,
    replyFrom: "",
    replySubject: "",
    replyKind: "",
    lastCheckedAt: 0,
  });
  write(rows);
}

export function applyReplyResults(
  results: {
    id: string;
    reply: ReplyState;
    at: number;
    from: string;
    subject: string;
    kind?: string;
  }[],
) {
  const rows = read();
  const byId = new Map(results.map((r) => [r.id, r]));
  const now = Date.now();

  for (const row of rows) {
    row.lastCheckedAt = now;
    const hit = byId.get(row.id);
    // A real reply is never downgraded by a later, quieter check.
    if (!hit || row.reply === "replied") continue;
    row.reply = hit.reply;
    row.replyAt = hit.at;
    row.replyFrom = hit.from;
    row.replySubject = hit.subject;
    row.replyKind = hit.kind ?? "";
  }

  write(rows);
  return rows;
}

/**
 * Gmail allows roughly 500 recipients a day on a free account, but the number
 * that matters is far lower: a sudden burst of near-identical mail to
 * strangers is what gets an account flagged, not the raw count. These limits
 * keep a day's sending inside what a person plausibly types by hand.
 */
export const DAILY_SOFT_LIMIT = 40;
export const DAILY_HARD_LIMIT = 80;

export type SendGuard = {
  sentToday: number;
  remaining: number;
  /** Past the soft limit: warn, but let it through. */
  warn: boolean;
  /** Past the hard limit: refuse for today. */
  block: boolean;
  message: string;
};

export function checkSendGuard(extra = 0): SendGuard {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const sentToday = loadHistory().filter((r) => r.sentAt > dayAgo).length;
  const projected = sentToday + extra;

  const block = projected > DAILY_HARD_LIMIT;
  const warn = !block && projected > DAILY_SOFT_LIMIT;

  let message = "";
  if (block) {
    message =
      `That would put you at ${projected} emails in 24 hours. Gmail treats bursts of similar ` +
      `mail to strangers as spam, and the account is worth more than the extra applications. ` +
      `Send the rest tomorrow.`;
  } else if (warn) {
    message =
      `${projected} emails in 24 hours. Still within Gmail's limits, but keep an eye on it — ` +
      `volume plus similarity is what gets accounts flagged.`;
  }

  return {
    sentToday,
    remaining: Math.max(0, DAILY_HARD_LIMIT - sentToday),
    warn,
    block,
    message,
  };
}

/** Bounces hurt sender reputation, so a run of them is worth stopping for. */
export function recentBounceRate(): { bounced: number; sent: number; high: boolean } {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = loadHistory().filter((r) => r.sentAt > weekAgo);
  const bounced = recent.filter((r) => r.reply === "bounced").length;
  return { bounced, sent: recent.length, high: recent.length >= 10 && bounced / recent.length > 0.2 };
}

/** The browser's own view of it, over the localStorage history. */
export function priorApplication(company: string, recipients: string[]): PriorApplication | null {
  return findPriorApplication(loadHistory(), company, recipients);
}

export function clearHistory() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export type Insights = ReturnType<typeof computeInsights>;

export function computeInsights(rows: SentEmail[]) {
  const sent = rows.length;
  const replied = rows.filter((r) => r.reply === "replied");
  const bounced = rows.filter((r) => r.reply === "bounced").length;
  const auto = rows.filter((r) => r.reply === "auto").length;

  // Mail sent in the last two days has not had a fair chance to be answered,
  // so the headline rate excludes it.
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const mature = rows.filter((r) => r.sentAt < cutoff);
  const matureReplied = mature.filter((r) => r.reply === "replied").length;

  const times = replied
    .filter((r) => r.replyAt > r.sentAt)
    .map((r) => r.replyAt - r.sentAt)
    .sort((a, b) => a - b);
  const medianHours = times.length
    ? Math.round(times[Math.floor(times.length / 2)] / 3_600_000)
    : 0;

  function rateOf(subset: SentEmail[]) {
    const ready = subset.filter((r) => r.sentAt < cutoff);
    if (!ready.length) return null;
    return Math.round((ready.filter((r) => r.reply === "replied").length / ready.length) * 100);
  }

  const byGroup = (pick: (r: SentEmail) => string) => {
    const groups = new Map<string, SentEmail[]>();
    for (const row of rows) {
      const key = pick(row) || "—";
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    return [...groups.entries()]
      .map(([key, list]) => ({
        key,
        sent: list.length,
        replied: list.filter((r) => r.reply === "replied").length,
        rate: rateOf(list),
      }))
      .sort((a, b) => b.sent - a.sent);
  };

  const interviews = rows.filter((r) => r.replyKind === "interview").length;
  const rejections = rows.filter((r) => r.replyKind === "rejection").length;

  return {
    interviews,
    rejections,
    sent,
    replied: replied.length,
    bounced,
    auto,
    awaiting: rows.filter((r) => r.reply === "awaiting").length,
    replyRate: mature.length ? Math.round((matureReplied / mature.length) * 100) : null,
    matureCount: mature.length,
    medianHours,
    byRecipe: byGroup((r) => r.recipeKey),
    bySource: byGroup((r) => r.source),
    byEdited: byGroup((r) => (r.edited ? "You edited it" : "Sent as generated")),
    recentReplies: replied.sort((a, b) => b.replyAt - a.replyAt).slice(0, 8),
  };
}

/**
 * Folds the server's record of sends into the browser's own.
 *
 * The browser knows more about the mail it sent itself — which recipe, what
 * was edited — so a local row always wins. The server's rows are what make
 * the Telegram bot's sends countable at all; without this the insights
 * describe only half of what was sent.
 */
export function mergeServerRows(
  local: SentEmail[],
  entries: {
    id: string;
    messageId: string;
    to: string[];
    company: string;
    role: string;
    subject: string;
    sentAt: number;
    via: "web" | "bot";
  }[],
  state: Record<
    string,
    { repliedAt?: number; kind?: string; followedUpAt?: number; bounced?: boolean }
  >,
): SentEmail[] {
  const known = new Set<string>();
  for (const row of local) {
    known.add(row.id);
    if (row.messageId) known.add(row.messageId);
  }

  const extra: SentEmail[] = [];
  for (const entry of entries) {
    if (known.has(entry.id) || (entry.messageId && known.has(entry.messageId))) continue;
    known.add(entry.id);

    const s = state[entry.id] ?? {};
    const reply: ReplyState = s.bounced
      ? "bounced"
      : s.repliedAt
        ? s.kind === "auto"
          ? "auto"
          : "replied"
        : "awaiting";

    extra.push({
      id: entry.id,
      messageId: entry.messageId,
      to: entry.to,
      company: entry.company,
      role: entry.role,
      seniority: "",
      subject: entry.subject,
      recipeKey: "",
      // Nothing local recorded how it was written; the bot always uses a model.
      source: "ai",
      edited: false,
      sentAt: entry.sentAt,
      reply,
      replyAt: s.repliedAt ?? 0,
      replyFrom: "",
      replySubject: "",
      replyKind: s.kind ?? "",
      lastCheckedAt: 0,
    });
  }

  return [...local, ...extra].sort((a, b) => b.sentAt - a.sentAt);
}

/** How many of these have already been nudged once. */
export function countFollowedUp(
  state: Record<string, { followedUpAt?: number }>,
): number {
  return Object.values(state).filter((s) => s.followedUpAt).length;
}

export type { PriorApplication };

"use client";

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
    lastCheckedAt: 0,
  });
  write(rows);
}

export function applyReplyResults(
  results: { id: string; reply: ReplyState; at: number; from: string; subject: string }[],
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
  }

  write(rows);
  return rows;
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

  return {
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

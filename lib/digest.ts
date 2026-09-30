import type { ScanResult } from "./inboxScan";
import type { Outbound, StateMap } from "./outbox";
import { KIND_LABEL, type ReplyKind } from "./replyKind";

/**
 * The morning summary.
 *
 * Written to be skippable: if nothing happened it produces nothing at all,
 * because a daily "no news" message trains you to stop reading the ones that
 * matter. Interviews lead, because that is the only line worth interrupting
 * anyone for.
 */

const DAY = 24 * 60 * 60 * 1000;
const NL = String.fromCharCode(10);

export type DigestInput = {
  outbox: Outbound[];
  state: StateMap;
  /** What the morning's scan newly found. */
  fresh: ScanResult[];
  /** How many queued emails went out just now. */
  justSent: number;
  /** How many have gone quiet and are being offered as nudges. */
  quiet: number;
  now?: number;
};

function label(kind: string): string {
  return KIND_LABEL[kind as ReplyKind] ?? KIND_LABEL.other;
}

export function buildDigest({
  outbox,
  state,
  fresh,
  justSent,
  quiet,
  now = Date.now(),
}: DigestInput): string | null {
  // An autoresponder is not news.
  const notable = fresh.filter((r) => r.reply === "replied");
  const bounced = fresh.filter((r) => r.reply === "bounced");

  if (!notable.length && !bounced.length && !justSent) return null;

  const byId = new Map(outbox.map((e) => [e.id, e]));
  const describe = (r: ScanResult) => {
    const entry = byId.get(r.id);
    const who = entry?.company || r.from || "someone";
    const role = entry?.role ? ` (${entry.role})` : "";
    return `  ${label(r.kind)} — ${who}${role}`;
  };

  const interviews = notable.filter((r) => r.kind === "interview");
  const rest = notable.filter((r) => r.kind !== "interview");

  const lines: string[] = ["☀️ This morning"];

  if (interviews.length) {
    lines.push(
      "",
      `🎉 ${interviews.length} interview request${interviews.length === 1 ? "" : "s"}`,
      ...interviews.map(describe),
    );
  }

  if (rest.length) {
    lines.push("", `${rest.length} other repl${rest.length === 1 ? "y" : "ies"}`, ...rest.map(describe));
  }

  if (bounced.length) {
    lines.push(
      "",
      `⚠️ ${bounced.length} could not be delivered — check the address before reusing it`,
      ...bounced.map(describe),
    );
  }

  if (justSent) {
    lines.push("", `📤 ${justSent} queued email${justSent === 1 ? "" : "s"} went out just now`);
  }

  // Context, only where there is something to be in context of.
  const awaiting = outbox.filter((e) => {
    const s = state[e.id];
    return !s?.repliedAt && !s?.bounced && now - e.sentAt <= 45 * DAY;
  }).length;

  const tail: string[] = [];
  if (awaiting) tail.push(`${awaiting} still waiting`);
  if (quiet) tail.push(`${quiet} gone quiet`);
  if (tail.length) lines.push("", tail.join(" · "));

  return lines.join(NL);
}

/** How many went out in the last 24 hours, for the status line. */
export function sentInLastDay(outbox: Outbound[], now = Date.now()): number {
  return outbox.filter((e) => now - e.sentAt <= DAY).length;
}

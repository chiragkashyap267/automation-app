/**
 * Have we written to these people already, and recently?
 *
 * Kept free of any storage so both halves of the app can ask it: the browser
 * from its localStorage history, the bot from the server-side outbox. The
 * bot had no version of this at all, so it would happily write to the same
 * company twice in a week without a word.
 */

/** Applications inside this window are almost always a mistake. */
export const REAPPLY_DAYS = 21;

export type PastSend = {
  company: string;
  role: string;
  to: string[];
  sentAt: number;
  /** Optional: the browser tracks this, the outbox tracks it separately. */
  reply?: string;
};

export type PriorApplication = {
  company: string;
  role: string;
  daysAgo: number;
  reply: string;
};

export function findPriorApplication(
  rows: PastSend[],
  company: string,
  recipients: string[],
  now = Date.now(),
): PriorApplication | null {
  const normalised = company.trim().toLowerCase();
  const addresses = new Set(recipients.map((r) => r.toLowerCase().trim()));
  const cutoff = now - REAPPLY_DAYS * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    if (row.sentAt < cutoff) continue;

    const sameCompany = Boolean(normalised) && row.company.trim().toLowerCase() === normalised;
    const sameAddress = (row.to ?? []).some((t) => addresses.has(t.toLowerCase().trim()));
    if (!sameCompany && !sameAddress) continue;

    return {
      company: row.company || row.to?.[0] || "them",
      role: row.role,
      daysAgo: Math.max(0, Math.round((now - row.sentAt) / 86_400_000)),
      reply: row.reply ?? "awaiting",
    };
  }

  return null;
}

/** The sentence both surfaces show. */
export function describePriorApplication(prior: PriorApplication): string {
  const when = prior.daysAgo === 0 ? "today" : `${prior.daysAgo} day${prior.daysAgo === 1 ? "" : "s"} ago`;
  return (
    `You wrote to ${prior.company} ${when}` +
    `${prior.role ? ` about ${prior.role}` : ""}` +
    `${prior.reply === "replied" ? " and they replied" : ""}. Sending again may read as spam.`
  );
}

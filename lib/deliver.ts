import { countSends, DAILY_HARD_LIMIT, sendsToday, type BatchDraft } from "./batch";
import { explainSmtpError, preflight, sendMail, type MailRequest } from "./mailer";
import { recordOutbound } from "./outbox";
import type { Profile } from "./types";

/**
 * Actually putting a set of drafts on the wire.
 *
 * Shared by Send-all and by the scheduled queue, because the rules that keep
 * the account safe — the daily ceiling, the gap between messages, refusing a
 * malformed draft — must not be able to drift apart between the two paths.
 */

/** A short pause between sends; Gmail treats a burst as a sending pattern. */
export const GAP_MS = 900;

export type DeliverDeps = {
  attachment?: () => Promise<MailRequest["attachment"]>;
  /**
   * Injected so tests can exercise the whole loop without a bundler alias —
   * and so a test can never open a real SMTP connection by accident.
   */
  send?: (req: MailRequest) => Promise<string>;
  gapMs?: number;
};

export type Delivery = {
  sent: number;
  attempted: number;
  /** One line per draft, in order, ready to show in chat. */
  results: string[];
  /** Set when nothing was attempted at all. */
  refused?: string;
};

export async function deliverDrafts(
  chatId: number,
  drafts: BatchDraft[],
  profile: Profile,
  deps: DeliverDeps = {},
): Promise<Delivery> {
  const { send = sendMail, attachment, gapMs = GAP_MS } = deps;
  const queue = drafts.filter((d) => d.to.length);

  if (!profile.gmailUser || !profile.gmailAppPassword) {
    return {
      sent: 0,
      attempted: 0,
      results: [],
      refused: "GMAIL_USER and GMAIL_APP_PASSWORD are not set on the server.",
    };
  }

  const already = await sendsToday(chatId);
  if (already + queue.length > DAILY_HARD_LIMIT) {
    return {
      sent: 0,
      attempted: 0,
      results: [],
      refused:
        `That would be ${already + queue.length} emails today. Stopping at ${DAILY_HARD_LIMIT} ` +
        `to keep the account safe.`,
    };
  }

  const file = attachment ? await attachment() : undefined;
  const results: string[] = [];
  let sent = 0;

  for (let i = 0; i < queue.length; i++) {
    const draft = queue[i];
    const label = `${draft.company || "Unknown"} — ${draft.role || "role"}`;

    const problem = preflight({ to: draft.to, subject: draft.subject, text: draft.body });
    if (problem) {
      results.push(`✕ ${label} — ${problem}`);
      continue;
    }

    try {
      const messageId = await send({
        user: profile.gmailUser,
        pass: profile.gmailAppPassword,
        fromName: profile.fullName,
        to: draft.to,
        cc: profile.ccSelf ? profile.gmailUser : undefined,
        replyTo: profile.email || undefined,
        subject: draft.subject,
        text: draft.body,
        attachment: file,
      });
      sent += 1;
      results.push(`✓ ${label}`);

      // The same log the web app writes to, so this can be followed up on and
      // shows up in the insights.
      await recordOutbound({
        id: messageId || `${chatId}:${Date.now()}:${i}`,
        messageId,
        to: draft.to,
        company: draft.company,
        role: draft.role,
        contactName: draft.contactName ?? "",
        subject: draft.subject,
        sentAt: Date.now(),
        via: "bot",
        chatId,
      }).catch((err) => console.error("[deliver] outbox", err));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[deliver]", raw);
      results.push(`✕ ${label} — ${explainSmtpError(raw).slice(0, 90)}`);
    }

    if (i < queue.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }

  if (sent) await countSends(chatId, sent);

  return { sent, attempted: queue.length, results };
}

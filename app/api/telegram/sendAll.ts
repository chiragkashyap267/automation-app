import {
  DAILY_HARD_LIMIT,
  DAILY_SOFT_LIMIT,
  clearBatch,
  countSends,
  loadBatch,
  sendsToday,
} from "@/lib/batch";
import { explainSmtpError, preflight, sendMail, type MailRequest } from "@/lib/mailer";
import type { Profile } from "@/lib/types";

/** A short pause between sends; Gmail treats a burst as a sending pattern. */
const GAP_MS = 900;

export type SendAllDeps = {
  profile: Profile;
  attachment: () => Promise<{ filename: string; content: Buffer; contentType: string } | undefined>;
  edit: (messageId: number, text: string) => Promise<unknown>;
  answer: (text: string) => Promise<unknown>;
  /**
   * Injected so tests can exercise the whole loop without a bundler alias —
   * and so a test can never open a real SMTP connection by accident.
   */
  send?: (req: MailRequest) => Promise<string>;
};

/**
 * Sends everything in the batch, one at a time, reporting per email.
 *
 * A failure part-way never stops the rest — the successes are still worth
 * having — and every outcome is listed at the end so nothing fails silently.
 */
export async function sendAllInBatch(chatId: number, summaryMessageId: number, deps: SendAllDeps) {
  const { profile, attachment, edit, answer, send = sendMail } = deps;

  const batch = await loadBatch(chatId);
  const queue = (batch?.drafts ?? []).filter((d) => d.to.length);

  if (!queue.length) {
    await answer("Nothing left in this batch.");
    return;
  }

  if (!profile.gmailUser || !profile.gmailAppPassword) {
    await answer("GMAIL_USER and GMAIL_APP_PASSWORD are not set on the server.");
    return;
  }

  // Same ceiling the web app enforces, counted server-side for the bot.
  const already = await sendsToday(chatId);
  if (already + queue.length > DAILY_HARD_LIMIT) {
    await answer(
      `That would be ${already + queue.length} emails today. Stopping at ${DAILY_HARD_LIMIT} to keep the account safe.`,
    );
    return;
  }

  await answer(`Sending ${queue.length}…`);
  await edit(summaryMessageId, `📤 Sending ${queue.length} emails…`);

  const file = await attachment();
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
      await send({
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
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[sendall]", raw);
      results.push(`✕ ${label} — ${explainSmtpError(raw).slice(0, 90)}`);
    }

    if (i < queue.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }

  if (sent) await countSends(chatId, sent);
  await clearBatch(chatId);

  const total = await sendsToday(chatId);
  const warning =
    total > DAILY_SOFT_LIMIT
      ? `${String.fromCharCode(10)}${String.fromCharCode(10)}⚠️ ${total} sent today. Worth easing off.`
      : "";

  const nl = String.fromCharCode(10);
  await edit(
    summaryMessageId,
    `${sent === queue.length ? "✅" : "⚠️"} Sent ${sent} of ${queue.length}${nl}${nl}${results.join(nl)}${warning}`,
  );
}

import { DAILY_SOFT_LIMIT, clearBatch, loadBatch, sendsToday } from "@/lib/batch";
import { deliverDrafts, type DeliverDeps } from "@/lib/deliver";
import type { MailRequest } from "@/lib/mailer";
import type { Profile } from "@/lib/types";

export type SendAllDeps = {
  profile: Profile;
  attachment: (draft: {
    role: string;
  }) => Promise<{ filename: string; content: Buffer; contentType: string } | undefined>;
  edit: (messageId: number, text: string) => Promise<unknown>;
  answer: (text: string) => Promise<unknown>;
  send?: (req: MailRequest) => Promise<string>;
};

/**
 * Sends everything in the batch, one at a time, reporting per email.
 *
 * A failure part-way never stops the rest — the successes are still worth
 * having — and every outcome is listed at the end so nothing fails silently.
 * The sending itself lives in lib/deliver, shared with the scheduled queue.
 */
export async function sendAllInBatch(chatId: number, summaryMessageId: number, deps: SendAllDeps) {
  const { profile, attachment, edit, answer, send } = deps;

  const batch = await loadBatch(chatId);
  const queue = (batch?.drafts ?? []).filter((d) => d.to.length);

  if (!queue.length) {
    await answer("Nothing left in this batch.");
    return;
  }

  await answer(`Sending ${queue.length}…`);
  await edit(summaryMessageId, `📤 Sending ${queue.length} emails…`);

  const options: DeliverDeps = { attachment, send };
  const { sent, results, refused } = await deliverDrafts(chatId, queue, profile, options);

  if (refused) {
    await answer(refused.slice(0, 190));
    await edit(summaryMessageId, `⚠️ ${refused}`);
    return;
  }

  await clearBatch(chatId);

  const total = await sendsToday(chatId);
  const nl = String.fromCharCode(10);
  const warning =
    total > DAILY_SOFT_LIMIT ? `${nl}${nl}⚠️ ${total} sent today. Worth easing off.` : "";

  await edit(
    summaryMessageId,
    `${sent === queue.length ? "✅" : "⚠️"} Sent ${sent} of ${queue.length}${nl}${nl}` +
      `${results.join(nl)}${warning}`,
  );
}

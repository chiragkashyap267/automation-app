import { NextResponse } from "next/server";
import { buildDigest } from "@/lib/digest";
import { describeCandidates, isWorkday } from "@/lib/followup";
import { findQuiet, reviewInbox } from "@/lib/followupRun";
import { fetchResume } from "@/lib/resumeFetch";
import { sendQueued } from "@/lib/schedule";
import { loadBotProfile } from "@/lib/sharedProfile";
import { botConfigured, primaryChatId, say } from "@/lib/telegramApi";

export const runtime = "nodejs";
export const maxDuration = 60;
// A cron target must never be served from cache.
export const dynamic = "force-dynamic";

/**
 * The weekday morning job. Three things, in this order:
 *
 *   1. send anything that was queued for a working-hours send
 *   2. report what came back overnight
 *   3. offer to nudge whatever has gone quiet
 *
 * Only the first of those sends mail, and only drafts that were explicitly
 * queued by a tap. The nudges are offered and wait for an answer: mail that
 * goes out while nobody is watching is how an account gets flagged, and a
 * follow-up to someone who already replied is visible to the recipient.
 */

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // Vercel sends this header on scheduled invocations when CRON_SECRET is set.
  if (secret) return request.headers.get("authorization") === `Bearer ${secret}`;

  // Without a secret the endpoint is only safe because it cannot send.
  console.warn("[cron] CRON_SECRET is not set — the morning check is open");
  return true;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  if (!isWorkday()) return NextResponse.json({ skipped: "weekend" });

  const chatId = primaryChatId();
  if (!botConfigured() || chatId === null) {
    return NextResponse.json({ skipped: "telegram not configured" });
  }

  const profile = await loadBotProfile();
  const nl = String.fromCharCode(10);

  // 1. Anything held back for working hours goes now.
  //    Only reachable when CRON_SECRET is set, since that is what proves the
  //    request came from Vercel rather than from whoever found the URL.
  let justSent = 0;
  if (process.env.CRON_SECRET?.trim()) {
    const flushed = await sendQueued(chatId, profile, {
      attachment: async (draft) => {
        const resume = await fetchResume(draft.role, profile.fullName);
        return resume?.ok ? resume.attachment : undefined;
      },
    });
    justSent = flushed.sent;

    if (flushed.refused) {
      await say(chatId, `⚠️ Queued mail not sent — ${flushed.refused}`);
    } else if (flushed.queued) {
      await say(
        chatId,
        [`📤 Sent ${flushed.sent} of ${flushed.queued} queued`, "", flushed.results.join(nl)].join(nl),
      );
    }
  }

  // 2 and 3 share one pass over the inbox.
  const review = await reviewInbox(profile);
  const { candidates, scanned, total } = await findQuiet(profile, Date.now(), review);

  const digest = buildDigest({
    outbox: review.outbox,
    state: review.state,
    fresh: review.fresh,
    justSent,
    quiet: candidates.length,
  });
  if (digest) await say(chatId, digest);

  if (candidates.length) {
    await say(chatId, describeCandidates(candidates), {
      reply_markup: {
        inline_keyboard: [
          [{ text: `✉️ Nudge all ${candidates.length}`, callback_data: "followup" }],
          [{ text: "🔕 Not now", callback_data: "followup:skip" }],
        ],
      },
    });
  }

  return NextResponse.json({
    queuedSent: justSent,
    digest: Boolean(digest),
    offered: candidates.length,
    scanned,
    total,
  });
}

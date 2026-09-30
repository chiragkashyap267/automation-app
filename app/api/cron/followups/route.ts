import { NextResponse } from "next/server";
import { describeCandidates, isWorkday } from "@/lib/followup";
import { findQuiet } from "@/lib/followupRun";
import { loadBotProfile } from "@/lib/sharedProfile";
import { botConfigured, primaryChatId, say } from "@/lib/telegramApi";

export const runtime = "nodejs";
export const maxDuration = 60;
// A cron target must never be served from cache.
export const dynamic = "force-dynamic";

/**
 * The daily check for applications that have gone quiet.
 *
 * It does not send anything. It looks, and if there is something worth
 * nudging it asks in Telegram and waits for a tap. Mail that goes out while
 * nobody is watching is exactly how an account gets flagged, and a follow-up
 * to someone who already replied is the kind of mistake that is visible to
 * the recipient — so a person stays in the loop.
 */

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // Vercel sends this header on scheduled invocations when CRON_SECRET is set.
  if (secret) return request.headers.get("authorization") === `Bearer ${secret}`;

  // Without a secret the endpoint is only safe because it cannot send.
  console.warn("[cron] CRON_SECRET is not set — the follow-up check is open");
  return true;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  if (!isWorkday()) {
    return NextResponse.json({ skipped: "weekend" });
  }

  const chatId = primaryChatId();
  if (!botConfigured() || chatId === null) {
    return NextResponse.json({ skipped: "telegram not configured" });
  }

  const profile = await loadBotProfile();
  const { candidates, scanned, total } = await findQuiet(profile);

  if (scanned === null) {
    // Could not read the inbox, so we cannot tell who has already replied.
    return NextResponse.json({ skipped: "inbox unreadable", total });
  }
  if (!candidates.length) {
    return NextResponse.json({ offered: 0, scanned, total });
  }

  await say(chatId, describeCandidates(candidates), {
    reply_markup: {
      inline_keyboard: [
        [{ text: `✉️ Nudge all ${candidates.length}`, callback_data: "followup" }],
        [{ text: "🔕 Not now", callback_data: "followup:skip" }],
      ],
    },
  });

  return NextResponse.json({ offered: candidates.length, scanned, total });
}

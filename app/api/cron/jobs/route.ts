import { NextResponse } from "next/server";
import { digestHeader, jobCard, jobKeyboard, runWatch } from "@/lib/jobs/watch";
import { loadBotProfile } from "@/lib/sharedProfile";
import { botConfigured, primaryChatId, say } from "@/lib/telegramApi";

export const runtime = "nodejs";
export const maxDuration = 60;
// A cron target must never be served from cache.
export const dynamic = "force-dynamic";

/**
 * The morning sweep of company career boards.
 *
 * Kept apart from the follow-up cron because the two have nothing in
 * common: that one can send mail and is fenced accordingly, this one only
 * reads public career pages and can do nothing but show you a link. Being
 * separate also means a board going down cannot delay a follow-up.
 *
 * Quiet by design. A digest with nothing in it is not worth a notification,
 * so on a morning with no new matches it says nothing at all.
 */

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) return request.headers.get("authorization") === `Bearer ${secret}`;
  console.warn("[cron] CRON_SECRET is not set — the job sweep is open");
  return true;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  const chatId = primaryChatId();
  if (!botConfigured() || chatId === null) {
    return NextResponse.json({ ok: false, reason: "no bot or chat configured" });
  }

  const profile = await loadBotProfile();
  const result = await runWatch(profile);

  // Nothing new is the common case, and it is not news.
  if (!result.fresh.length) {
    return NextResponse.json({ ok: true, sent: 0, scanned: result.scanned });
  }

  await say(chatId, digestHeader(result));

  const total = result.fresh.length;
  for (let i = 0; i < total; i += 1) {
    await say(chatId, jobCard(result.fresh[i], i + 1, total), {
      reply_markup: jobKeyboard(result.fresh[i]),
    });
  }

  return NextResponse.json({
    ok: true,
    sent: total,
    scanned: result.scanned,
    matched: result.matched,
  });
}

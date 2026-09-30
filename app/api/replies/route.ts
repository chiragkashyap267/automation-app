import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { explainImapError, scanInbox, type SentItem } from "@/lib/inboxScan";
import { mergeState, type StateMap } from "@/lib/outbox";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * "Check for replies" from the browser.
 *
 * The matching itself lives in lib/inboxScan so the scheduled follow-up job
 * uses exactly the same rules — a nudge must never go to someone this route
 * would have counted as having replied.
 */

export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let body: { profile?: { gmailUser?: string; gmailAppPassword?: string }; items?: SentItem[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const user = body.profile?.gmailUser?.trim() ?? "";
  const pass = body.profile?.gmailAppPassword?.replace(/\s+/g, "") ?? "";
  const items = (body.items ?? []).filter((i) => i.messageId || i.to?.length);

  if (!user || !pass) {
    return NextResponse.json(
      { error: "Add your Gmail address and App Password in Details first." },
      { status: 400 },
    );
  }
  if (!items.length) return NextResponse.json({ results: [], scanned: 0 });

  try {
    const { results, scanned } = await scanInbox({ user, pass }, items);

    // Mirror what was found, so the follow-up job knows not to nudge these.
    const patch: StateMap = {};
    for (const row of results) {
      patch[row.id] =
        row.reply === "bounced"
          ? { bounced: true }
          : { repliedAt: row.at, kind: row.kind };
    }
    await mergeState(patch);

    return NextResponse.json({ results, scanned });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[replies]", raw);
    return NextResponse.json({ error: explainImapError(raw) }, { status: 502 });
  }
}

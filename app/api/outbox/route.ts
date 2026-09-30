import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { loadOutbox, loadState, outboxAvailable } from "@/lib/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the server has seen sent, from either half of the app.
 *
 * The browser keeps a richer history of its own sends — which recipe, whether
 * it was edited — so this exists mainly to make the bot's sends visible. They
 * were previously invisible to the insights entirely.
 */
export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  if (!outboxAvailable()) return NextResponse.json({ entries: [], state: {}, available: false });

  const [entries, state] = await Promise.all([loadOutbox(), loadState()]);
  return NextResponse.json({ entries, state, available: true });
}

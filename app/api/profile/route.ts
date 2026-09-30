import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { saveSharedProfile, sharedProfileAvailable, stripSecrets } from "@/lib/sharedProfile";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mirrors the browser's profile so the Telegram bot writes from the same
 * details. Credentials are stripped before anything is stored.
 */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  if (!sharedProfileAvailable()) {
    return NextResponse.json({ ok: false, reason: "no-store" });
  }

  let body: { profile?: Partial<Profile> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const profile: Profile = { ...EMPTY_PROFILE, ...(body.profile ?? {}) };
  if (!profile.fullName.trim()) {
    return NextResponse.json({ error: "Nothing to save yet." }, { status: 400 });
  }

  const saved = await saveSharedProfile(stripSecrets(profile));
  return NextResponse.json({ ok: saved });
}

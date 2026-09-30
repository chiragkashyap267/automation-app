import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { loadSharedServices, saveSharedServices, sharedServicesAvailable } from "@/lib/sharedServices";
import { EMPTY_SERVICES, type ServicesProfile } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors the freelance services profile so the bot can pitch from it. */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  if (!sharedServicesAvailable()) return NextResponse.json({ ok: false, reason: "no-store" });

  let body: { profile?: Partial<ServicesProfile> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const profile: ServicesProfile = { ...EMPTY_SERVICES, ...(body.profile ?? {}) };
  if (!profile.fullName.trim()) return NextResponse.json({ error: "Nothing to save yet." }, { status: 400 });

  return NextResponse.json({ ok: await saveSharedServices(profile) });
}

export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  return NextResponse.json({ profile: await loadSharedServices() });
}

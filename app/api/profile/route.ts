import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import {
  loadBotProfile,
  saveSharedProfile,
  sharedProfileAvailable,
  stripSecrets,
} from "@/lib/sharedProfile";
import { resolveResumeUrl, resumeFilename } from "@/lib/resumeFetch";
import { loadSharedResume, saveSharedResume, type SaveResult } from "@/lib/sharedResume";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hands the stored profile back out, for the browser extension that fills
 * application forms.
 *
 * Read-only and already stripped of credentials: the Gmail password never
 * leaves the browser that typed it, and the extension has no use for one.
 * The resume is named rather than inlined, so the extension fetches the
 * file itself and this response stays small.
 */
export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const profile = stripSecrets(await loadBotProfile());
  const resumeUrl = resolveResumeUrl(process.env.RESUME_URL ?? "");

  return NextResponse.json({
    profile,
    resume: resumeUrl ? { url: resumeUrl, filename: resumeFilename() } : null,
  });
}

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

  // The uploaded PDF travels separately. It is stripped out of the profile
  // along with the credentials, and without this the bot would keep
  // attaching whatever RESUME_URL points at long after a new one was
  // uploaded here.
  let resume: SaveResult | null = null;
  if (profile.resumeFileData) {
    resume = await saveSharedResume(
      profile.resumeFileData,
      profile.resumeFileName,
      profile.resumeFileType,
    );
  }

  return NextResponse.json({
    ok: saved,
    resume: resume ? (resume.ok ? "saved" : resume.reason) : "none uploaded",
  });
}

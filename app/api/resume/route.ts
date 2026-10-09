import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import {
  loadSharedResume,
  saveSharedResume,
  sharedResumeLimit,
  sharedResumeStore,
} from "@/lib/sharedResume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The resume file, on its own.
 *
 * It used to travel inside the profile, which was wrong twice over. The
 * profile is mirrored on a debounce while someone types, so a few hundred
 * kilobytes of base64 went up again on every pause; and /api/profile
 * strips the file out before storing it anyway, so the bytes were being
 * sent to something that had no use for them. A request large enough to
 * be refused took the profile save down with it.
 *
 * One file, one request, nothing else in it.
 */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let body: { data?: string; filename?: string; contentType?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const data = (body.data ?? "").trim();
  if (!data) return NextResponse.json({ error: "No file was sent." }, { status: 400 });

  const saved = await saveSharedResume(
    data,
    body.filename ?? "resume.pdf",
    body.contentType ?? "application/pdf",
  );

  if (!saved.ok) {
    return NextResponse.json({ ok: false, reason: saved.reason }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}

/** What the bot currently holds, so the form can say so. */
export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const held = await loadSharedResume();
  return NextResponse.json({
    resume: held
      ? {
          filename: held.filename,
          savedAt: held.savedAt,
          bytes: held.bytes ?? null,
          // Where it lives, never the URL itself: a raw Cloudinary link is
          // readable by anyone who has it, and this response is one fetch
          // away from anything running in the page.
          hosted: Boolean(held.url),
        }
      : null,
    store: sharedResumeStore(),
    limitBytes: sharedResumeLimit(),
  });
}

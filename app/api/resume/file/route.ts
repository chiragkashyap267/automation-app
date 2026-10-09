import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { resolveResumeUrl, resumeFilename } from "@/lib/resumeFetch";
import { loadSharedResume, sharedResumeBytes } from "@/lib/sharedResume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The resume itself, as a download.
 *
 * For a phone. A portal's file picker can only offer files that are
 * already on the device, so applying from a phone starts with getting
 * the resume onto it — and the copy that matters is the one the app
 * holds, not whatever is in the downloads folder from six weeks ago.
 *
 * Falls back to RESUME_URL when nothing has been uploaded, so this works
 * on a setup that never used the upload form.
 */
export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const held = await loadSharedResume();

  if (held) {
    const bytes = await sharedResumeBytes(held);
    if (!bytes.ok) return NextResponse.json({ error: bytes.reason }, { status: 502 });

    return new NextResponse(new Uint8Array(bytes.content), {
      headers: {
        "content-type": held.contentType || "application/pdf",
        "content-disposition": `attachment; filename="${held.filename || "resume.pdf"}"`,
        "content-length": String(bytes.content.length),
        "cache-control": "no-store",
      },
    });
  }

  const configured = process.env.RESUME_URL?.trim();
  if (!configured) {
    return NextResponse.json(
      { error: "No resume has been uploaded yet. Add one on the Details page." },
      { status: 404 },
    );
  }

  try {
    const res = await fetch(resolveResumeUrl(configured), { redirect: "follow" });
    if (!res.ok) {
      return NextResponse.json({ error: `The resume URL returned ${res.status}.` }, { status: 502 });
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${resumeFilename()}"`,
        "content-length": String(buffer.length),
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "The resume URL could not be reached." }, { status: 502 });
  }
}

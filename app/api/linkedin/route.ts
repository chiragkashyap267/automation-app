import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { asPostingText, fetchLinkedInJob, linkedInJobId, isShortLink } from "@/lib/linkedin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reads a public LinkedIn job listing on the browser's behalf.
 *
 * The page cannot do this itself: linkedin.com sends no CORS headers, so a
 * fetch from the app's own origin is blocked before it starts. Nothing here
 * signs in or sends a cookie — it asks for the same public listing a search
 * engine would.
 *
 * Guarded despite spending no tokens, so it cannot be used as an open proxy
 * by anyone who finds the URL.
 */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let body: { url?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  if (!url || (!linkedInJobId(url) && !isShortLink(url))) {
    return NextResponse.json({ error: "That is not a LinkedIn job link." }, { status: 400 });
  }

  const job = await fetchLinkedInJob(url);
  if (!job) {
    return NextResponse.json(
      { error: "That job could not be read — it may have been taken down." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    text: asPostingText(job),
    title: job.title,
    company: job.company,
    location: job.location,
    emails: job.emails,
  });
}

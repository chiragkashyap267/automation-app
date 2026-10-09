import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { readResumeWithGemini } from "@/lib/llm/gemini";
import { describeParse, filledFields } from "@/lib/resumeParse";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** A resume much past this is not a resume, and the model has to read it all. */
const MAX_BASE64 = 6_000_000; // about 4.5 MB, matching the upload form

/**
 * Reads an uploaded resume into profile fields.
 *
 * Gemini takes the PDF directly, so the file never has to be parsed here.
 * Only Gemini: this is one call on a file the person just chose, and the
 * other providers either cannot take a PDF or would need it converted
 * first. If no Gemini key is configured the upload still works — it simply
 * does not offer to fill the form in.
 */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let body: { data?: string; mimeType?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const data = (body.data ?? "").trim();
  if (!data) return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  if (data.length > MAX_BASE64) {
    return NextResponse.json({ error: "That file is too large to read." }, { status: 413 });
  }

  try {
    const parsed = await readResumeWithGemini(data, body.mimeType ?? "application/pdf");
    const found = filledFields(parsed);

    if (!found.length) {
      return NextResponse.json(
        { error: "Nothing could be read from that file. It may be a scan with no text in it." },
        { status: 422 },
      );
    }

    return NextResponse.json({ parsed, found, summary: describeParse(parsed) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The resume could not be read.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

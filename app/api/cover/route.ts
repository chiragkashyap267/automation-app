import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { coverWritersAvailable, writeCoverLetter } from "@/lib/coverLetter";
import { coverLetterFilename, textToPdf } from "@/lib/pdf";
import { loadBotProfile } from "@/lib/sharedProfile";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Writes the cover letter, and hands back a PDF of it when one is wanted.
 *
 * The letter comes back as text by default because that is what most
 * forms want — a textarea, not an upload. The PDF is for the forms with a
 * second file box, and for a phone, where the only way into a file picker
 * is to have the file on the device first.
 */

const Body = z.object({
  company: z.string().default(""),
  role: z.string().default(""),
  jd: z.string().default(""),
  /** The browser's profile, when it has one newer than the stored copy. */
  profile: z.record(z.string(), z.unknown()).optional(),
  /** true returns application/pdf instead of JSON. */
  pdf: z.boolean().default(false),
  /** An already-written letter, for turning one into a PDF unchanged. */
  letter: z.string().default(""),
});

const MAX_JD = 20_000;

export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const body = Body.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "Unexpected request shape." }, { status: 400 });

  const { company, role, pdf } = body.data;
  const jd = body.data.jd.slice(0, MAX_JD);

  // The browser's own profile wins when it sends one: it is being edited
  // right now, and the mirrored copy can be a couple of seconds behind.
  const stored = await loadBotProfile();
  const profile: Profile = {
    ...EMPTY_PROFILE,
    ...stored,
    ...((body.data.profile ?? {}) as Partial<Profile>),
  };

  if (!profile.fullName.trim() || !profile.resumeText.trim()) {
    return NextResponse.json(
      { error: "Fill in your details and resume text first — there is nothing to write from." },
      { status: 400 },
    );
  }

  // A letter supplied by the caller is turned into a PDF as it stands,
  // so an edit made by hand is not quietly overwritten by a fresh draft.
  let letter = body.data.letter.trim();
  let writer = "yours";
  let problems: string[] = [];

  if (!letter) {
    if (!coverWritersAvailable()) {
      return NextResponse.json({ error: "No key that can write a cover letter is set." }, { status: 503 });
    }
    try {
      const written = await writeCoverLetter(profile, { company, role, jd });
      letter = written.letter;
      writer = written.writer;
      problems = written.problems;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (!pdf) return NextResponse.json({ letter, writer, problems });

  const filename = coverLetterFilename(profile.fullName, company);
  const bytes = textToPdf(`${profile.fullName}\n${profile.email}  ${profile.phone}\n\n${letter}`);

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    },
  });
}

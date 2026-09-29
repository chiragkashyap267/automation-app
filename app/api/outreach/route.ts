import { NextResponse } from "next/server";
import { writeOutreach } from "@/lib/llm";
import { companyFromEmail } from "@/lib/llm/prompt";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: { profile?: Partial<Profile>; email?: string; role?: string; company?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const email = (body.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Give a valid email address to write to." }, { status: 400 });
  }

  const profile: Profile = { ...EMPTY_PROFILE, ...(body.profile ?? {}) };
  if (!profile.fullName.trim()) {
    return NextResponse.json(
      { error: "Add your details first — the email needs a name to sign." },
      { status: 400 },
    );
  }

  const role = (body.role ?? "").trim() || profile.headline.trim() || "Software Engineer";
  const company = (body.company ?? "").trim() || companyFromEmail(email);

  try {
    const { written, writer } = await writeOutreach(profile, { email, role, company });
    return NextResponse.json({ ...written, writer, company, role });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not write this email.";
    console.error("[outreach]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

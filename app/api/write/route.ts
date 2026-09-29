import { NextResponse } from "next/server";
import { writeEmail } from "@/lib/llm";
import { FactsSchema } from "@/lib/llm/prompt";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { profile?: Partial<Profile>; facts?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const parsed = FactsSchema.safeParse(body.facts);
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing or malformed job facts." }, { status: 400 });
  }

  const profile: Profile = { ...EMPTY_PROFILE, ...(body.profile ?? {}) };
  if (!profile.fullName.trim()) {
    return NextResponse.json(
      { error: "Add your details first — the email needs a name to sign." },
      { status: 400 },
    );
  }

  try {
    const { written, writer, revised } = await writeEmail(profile, parsed.data);
    return NextResponse.json({ ...written, writer, revised });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not write this email.";
    console.error("[write]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

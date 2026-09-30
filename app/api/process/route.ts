import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { readJobs, type LlmImage, type ReadMode } from "@/lib/llm";
import { buildTaskText } from "@/lib/llm/prompt";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  profile?: Partial<Profile>;
  images?: LlmImage[];
  texts?: string[];
  mode?: ReadMode;
};

export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) {
    return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const profile: Profile = { ...EMPTY_PROFILE, ...(body.profile ?? {}) };
  const images = body.images ?? [];
  const texts = (body.texts ?? []).filter((t) => t.trim());
  const mode: ReadMode = body.mode === "extract" ? "extract" : "full";

  if (!images.length && !texts.length) {
    return NextResponse.json({ error: "Nothing to read." }, { status: 400 });
  }
  if (!profile.fullName.trim()) {
    return NextResponse.json(
      { error: "Add your details first — the email needs a name to sign." },
      { status: 400 },
    );
  }

  try {
    const { result, reader } = await readJobs(
      { text: buildTaskText(profile, texts), images },
      mode,
    );
    return NextResponse.json({ jobs: result.jobs, reader, mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read these job descriptions.";
    console.error("[process]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

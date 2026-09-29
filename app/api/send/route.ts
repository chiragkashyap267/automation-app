import { NextResponse } from "next/server";
import { explainSmtpError, preflight, sendMail } from "@/lib/mailer";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  profile?: Partial<Profile>;
  to?: string[];
  subject?: string;
  body?: string;
  attachResume?: boolean;
};

export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const profile: Profile = { ...EMPTY_PROFILE, ...(payload.profile ?? {}) };
  const to = (payload.to ?? []).map((t) => t.trim()).filter(Boolean);
  const subject = (payload.subject ?? "").trim();
  const text = (payload.body ?? "").trim();

  const user = profile.gmailUser.trim();
  const pass = profile.gmailAppPassword.replace(/\s+/g, "");

  if (!user || !pass) {
    return NextResponse.json(
      { error: "Add your Gmail address and App Password in Settings first." },
      { status: 400 },
    );
  }

  const problem = preflight({ to, subject, text });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const messageId = await sendMail({
      user,
      pass,
      fromName: profile.fullName,
      to,
      cc: profile.ccSelf ? user : undefined,
      replyTo: profile.email?.trim() || undefined,
      subject,
      text,
      attachment:
        payload.attachResume && profile.resumeFileData
          ? {
              filename: profile.resumeFileName || "resume.pdf",
              content: Buffer.from(profile.resumeFileData, "base64"),
              contentType: profile.resumeFileType || "application/pdf",
            }
          : undefined,
    });
    return NextResponse.json({ ok: true, messageId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[send]", raw);
    return NextResponse.json({ error: explainSmtpError(raw) }, { status: 502 });
  }
}

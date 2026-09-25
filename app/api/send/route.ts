import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!to.length) return NextResponse.json({ error: "No recipient address." }, { status: 400 });

  const bad = to.filter((t) => !EMAIL_RE.test(t));
  if (bad.length) {
    return NextResponse.json({ error: `Not a valid email address: ${bad[0]}` }, { status: 400 });
  }
  if (!subject) return NextResponse.json({ error: "Subject is empty." }, { status: 400 });
  if (!text) return NextResponse.json({ error: "Email body is empty." }, { status: 400 });

  const leftover = text.match(/\[(?:your|company|role|name|position)[^\]]*\]/i);
  if (leftover) {
    return NextResponse.json(
      { error: `The draft still has a placeholder (${leftover[0]}). Edit it before sending.` },
      { status: 400 },
    );
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const attachments =
    payload.attachResume && profile.resumeFileData
      ? [
          {
            filename: profile.resumeFileName || "resume.pdf",
            content: Buffer.from(profile.resumeFileData, "base64"),
            contentType: profile.resumeFileType || "application/pdf",
          },
        ]
      : [];

  try {
    const info = await transporter.sendMail({
      from: profile.fullName ? `"${profile.fullName}" <${user}>` : user,
      to,
      cc: profile.ccSelf ? user : undefined,
      replyTo: profile.email?.trim() || undefined,
      subject,
      text,
      attachments,
    });
    return NextResponse.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[send]", raw);

    let message = raw;
    if (/Invalid login|Username and Password not accepted|535/i.test(raw)) {
      message =
        "Gmail rejected the login. Use a 16-character App Password (not your normal Gmail password), and make sure 2-Step Verification is on.";
    } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
      message = "Could not reach Gmail's server. Check the connection and retry.";
    } else if (/Daily user sending (quota|limit)|550-5\.4\.5/i.test(raw)) {
      message = "Gmail's daily sending limit was hit (about 500/day). Try again tomorrow.";
    }
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    transporter.close();
  }
}

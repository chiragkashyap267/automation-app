import nodemailer from "nodemailer";

/** Shared by the web app's send route and the Telegram bot. */
export type MailRequest = {
  user: string;
  pass: string;
  fromName?: string;
  to: string[];
  cc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachment?: { filename: string; content: Buffer; contentType: string };
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Things that must never reach a recruiter, checked at the last moment. */
export function preflight(req: Pick<MailRequest, "to" | "subject" | "text">): string | null {
  const bad = req.to.find((t) => !EMAIL_RE.test(t));
  if (!req.to.length) return "No recipient address.";
  if (bad) return `Not a valid email address: ${bad}`;
  if (!req.subject.trim()) return "Subject is empty.";
  if (!req.text.trim()) return "Email body is empty.";

  const leftover = req.text.match(/\[(?:your|company|role|name|position)[^\]]*\]|\{\{\s*\w+\s*\}\}/i);
  if (leftover) return `The draft still has a placeholder (${leftover[0]}). Edit it before sending.`;

  return null;
}

/** Turns an SMTP failure into something a human can act on. */
export function explainSmtpError(raw: string): string {
  if (/Invalid login|Username and Password not accepted|535/i.test(raw)) {
    return "Gmail rejected the login. Use a 16-character App Password (not your normal Gmail password), and make sure 2-Step Verification is on.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
    return "Could not reach Gmail's server. Check the connection and retry.";
  }
  if (/Daily user sending (quota|limit)|550-5\.4\.5/i.test(raw)) {
    return "Gmail's daily sending limit was hit (about 500/day). Try again tomorrow.";
  }
  return raw;
}

export async function sendMail(req: MailRequest): Promise<string> {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: req.user, pass: req.pass },
  });

  try {
    const info = await transporter.sendMail({
      from: req.fromName ? `"${req.fromName}" <${req.user}>` : req.user,
      to: req.to,
      cc: req.cc,
      replyTo: req.replyTo,
      subject: req.subject,
      text: req.text,
      attachments: req.attachment ? [req.attachment] : [],
    });
    return info.messageId;
  } finally {
    transporter.close();
  }
}

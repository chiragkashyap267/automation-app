import { NextResponse } from "next/server";
import { readJobs, writeOutreach } from "@/lib/llm";
import { buildTaskText, companyFromEmail } from "@/lib/llm/prompt";
import { explainSmtpError, preflight, sendMail } from "@/lib/mailer";
import { SEED_PROFILE } from "@/lib/seed";
import { cleanRecipients } from "@/lib/email";
import { composeEmail, normalizePlainText } from "@/lib/signature";
import { EMPTY_PROFILE, type Profile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Telegram bot: forward a job description to the bot and it replies with a
 * finished email and a Send button.
 *
 * The bot is stateless. Everything needed to send lives in the text of the
 * message the button is attached to, and Telegram hands that whole message back
 * in the callback — so no database, no session, and a cold start loses nothing.
 */

const API = "https://api.telegram.org/bot";

type TgUser = { id: number };
type TgChat = { id: number };
type TgPhoto = { file_id: string; file_size?: number; width: number };
type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: { file_id: string; mime_type?: string; file_size?: number };
};
type TgUpdate = {
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
};

function token(): string {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  return value;
}

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${API}${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[telegram] ${method} ${res.status}`, (await res.text()).slice(0, 200));
  return res;
}

const say = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, disable_web_page_preview: true, ...extra });

/** Only the owner may use the bot — it spends API quota and sends as them. */
function allowed(chatId: number): boolean {
  const list = (process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 && list.includes(String(chatId));
}

function profile(): Profile {
  return {
    ...EMPTY_PROFILE,
    ...SEED_PROFILE,
    // Trim: a stray space or newline in an env var reads as a wrong account.
    gmailUser: (process.env.GMAIL_USER ?? "").trim(),
    gmailAppPassword: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
    // The browser holds the resume file; the bot fetches one from a URL instead.
    resumeFileName: process.env.RESUME_URL?.trim() ? resumeFilename() : "",
  };
}

async function fetchImage(fileId: string): Promise<{ mediaType: string; data: string } | null> {
  const info = await fetch(`${API}${token()}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!info.ok) return null;

  const meta = (await info.json()) as { ok: boolean; result?: { file_path?: string } };
  const path = meta.result?.file_path;
  if (!path) return null;

  const file = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`);
  if (!file.ok) return null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const mediaType = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  return { mediaType, data: buffer.toString("base64") };
}

/**
 * Share links point at a viewer page, not the file. Google Drive's "/view" URL
 * returns 86 KB of HTML that, attached as resume.pdf, simply will not open.
 * Rewrite the common ones to their direct-download form.
 */
export function resolveResumeUrl(url: string): string {
  const drive = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;

  const driveOpen = url.match(/drive\.google\.com\/open\?id=([\w-]+)/);
  if (driveOpen) return `https://drive.google.com/uc?export=download&id=${driveOpen[1]}`;

  const docs = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (docs) return `https://docs.google.com/document/d/${docs[1]}/export?format=pdf`;

  if (/dropbox\.com/.test(url)) {
    const stripped = url.replace(/[?&]dl=[01]/g, "");
    return `${stripped}${stripped.includes("?") ? "&" : "?"}dl=1`;
  }

  return url;
}

/** A name a mail client will open without arguing. */
export function resumeFilename(): string {
  const raw = (process.env.RESUME_FILENAME || "resume").trim();
  return /\.pdf$/i.test(raw) ? raw : `${raw}.pdf`;
}

type ResumeResult =
  | { ok: true; attachment: { filename: string; content: Buffer; contentType: string } }
  | { ok: false; reason: string };

async function fetchResume(): Promise<ResumeResult | null> {
  const configured = process.env.RESUME_URL?.trim();
  if (!configured) return null;

  const url = resolveResumeUrl(configured);

  let buffer: Buffer;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return { ok: false, reason: `the resume URL returned ${res.status}` };
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: "the resume URL could not be reached" };
  }

  // Trust the bytes, not the URL or the content-type header.
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return {
      ok: false,
      reason:
        "that link returns a web page, not a PDF. Use the file's direct-download link, and make sure it is shared with 'Anyone with the link'",
    };
  }

  return {
    ok: true,
    attachment: {
      filename: resumeFilename(),
      content: buffer,
      contentType: "application/pdf",
    },
  };
}

/** The reply doubles as the store, so its shape has to be parseable. */
function renderDraft(company: string, role: string, to: string[], subject: string, body: string) {
  const header = [company, role].filter(Boolean).join(" — ") || "Job application";
  return `📬 ${header}\n\nTo: ${to.join(", ")}\nSubject: ${subject}\n\n${body}`;
}

function parseDraft(text: string) {
  const to = text.match(/^To:\s*(.+)$/m)?.[1] ?? "";
  const subject = text.match(/^Subject:\s*(.+)$/m)?.[1] ?? "";
  const subjectAt = text.indexOf("\nSubject:");
  if (subjectAt === -1) return null;

  const afterSubject = text.indexOf("\n", subjectAt + 1);
  const blank = text.indexOf("\n\n", afterSubject);
  if (blank === -1) return null;

  return {
    to: to.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean),
    subject: subject.trim(),
    body: text.slice(blank + 2),
  };
}

const HELP = `Two things I can do.

1. JOB DESCRIPTION — paste the text or send a screenshot. I read it, write the application email from your profile, and reply with a Send button.
   Several postings in one message become several drafts.
   Screenshots are read one message at a time, so send one per posting. For a posting split across several screenshots, use the web app and Merge them.

2. COLD ENQUIRY — no posting, just ask:
   /ask hr@company.com Software Engineer
   Or send a bare email address and I will use your usual title.
   This writes a short "do you have openings?" email instead.`;

const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BARE_URL = /^\s*https?:\/\/\S+\s*$/i;

/** "/ask hr@co.com Backend Engineer" or just a bare address. */
function parseAsk(text: string): { email: string; role: string } | null {
  const stripped = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  const asked = /^\/ask\b/i.test(text);

  const [first, ...rest] = stripped.split(/\s+/);
  if (!first || !EMAIL_ONLY.test(first)) return null;
  // A bare address with no command is treated as an enquiry too.
  if (!asked && rest.length) return null;

  return { email: first.toLowerCase(), role: rest.join(" ").trim() };
}

async function handleAsk(chatId: number, ask: { email: string; role: string }) {
  const me = profile();
  const role = ask.role || me.headline.trim() || "Software Engineer";
  const company = companyFromEmail(ask.email);

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  let written;
  try {
    ({ written } = await writeOutreach(me, { email: ask.email, role, company }));
  } catch (err) {
    await say(chatId, `⚠️ ${err instanceof Error ? err.message : "Could not write that."}`);
    return;
  }

  const body = composeEmail(normalizePlainText(written.body), me);
  const draft = renderDraft(
    company || "Cold enquiry",
    role,
    [ask.email],
    normalizePlainText(written.subject),
    body,
  );

  await say(chatId, draft, {
    reply_markup: { inline_keyboard: [[{ text: "✉️ Send it", callback_data: "send" }]] },
  });
}

async function handleMessage(message: TgMessage) {
  const chatId = message.chat.id;

  const text = (message.text ?? message.caption ?? "").trim();
  if (/^\/(start|help)\b/.test(text)) {
    await say(chatId, HELP);
    return;
  }

  // A link on its own has nothing to read. LinkedIn in particular serves job
  // pages to logged-out visitors with the description stripped out, so there
  // is no posting text and no address behind the link — say so rather than
  // feeding a URL to the model and returning nonsense.
  if (!message.photo?.length && BARE_URL.test(text)) {
    await say(
      chatId,
      /linkedin\.com|nkd\.in|lnkd\.in/i.test(text)
        ? "I cannot read a LinkedIn link — the page hides the job text and the contact address from anyone not logged in.\n\nScreenshot the posting and send me the image instead. That works well."
        : "That is just a link, and I cannot open pages. Send a screenshot of the posting, or paste the text.",
    );
    return;
  }

  // A cold enquiry has no posting to read, so it skips the extract step
  // entirely and goes straight to writing.
  if (!message.photo?.length) {
    const ask = parseAsk(text);
    if (ask) {
      await handleAsk(chatId, ask);
      return;
    }
    if (/^\/ask\b/i.test(text)) {
      await say(chatId, "Usage:  /ask hr@company.com Software Engineer");
      return;
    }
  }

  const images: { mediaType: string; data: string }[] = [];

  if (message.photo?.length) {
    // Telegram sends several sizes; the last is the largest.
    const largest = message.photo[message.photo.length - 1];
    const image = await fetchImage(largest.file_id);
    if (image) images.push(image);
  } else if (message.document?.mime_type?.startsWith("image/")) {
    const image = await fetchImage(message.document.file_id);
    if (image) images.push(image);
  }

  const texts = text && !images.length ? [text] : text ? [text] : [];

  if (!images.length && !texts.length) {
    await say(chatId, "Send me the job description as text or a screenshot.");
    return;
  }

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  const me = profile();
  let jobs;
  try {
    const { result } = await readJobs({ text: buildTaskText(me, texts), images }, "full");
    jobs = result.jobs;
  } catch (err) {
    await say(chatId, `⚠️ ${err instanceof Error ? err.message : "Could not read that."}`);
    return;
  }

  if (!jobs.length) {
    await say(chatId, "Nothing in that looked like a job posting.");
    return;
  }

  // One screenshot producing several drafts is nearly always a misread, and
  // sending them all would mean near-identical mail to the same company.
  if (jobs.length > 1) {
    await say(
      chatId,
      `I read ${jobs.length} separate postings in that. If it was really one, ignore the extras — ` +
        `each has its own Send button and nothing goes out until you tap one.`,
    );
  }

  for (const job of jobs) {
    const { addresses, suspicious } = cleanRecipients(job.recipients ?? []);
    const body = composeEmail(normalizePlainText(job.body ?? ""), me);
    const subject = normalizePlainText(job.subject ?? "");
    const draft = renderDraft(job.company, job.role, addresses, subject, body);

    if (!addresses.length) {
      await say(
        chatId,
        `${draft}\n\n⚠️ No email address in this posting — I cannot send it. Open the app to add one.`,
      );
      continue;
    }

    const warning = suspicious.length
      ? `

⚠️ Check ${suspicious.join(", ")} against the posting — a leading icon is often misread into the address.`
      : "";

    await say(chatId, draft + warning, {
      reply_markup: {
        inline_keyboard: [[{ text: "✉️ Send it", callback_data: "send" }]],
      },
    });
  }
}

async function handleCallback(query: NonNullable<TgUpdate["callback_query"]>) {
  const message = query.message;
  const chatId = message?.chat.id;
  if (!message || chatId === undefined) return;

  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: query.id, text });

  const parsed = parseDraft(message.text ?? "");
  if (!parsed) {
    await answer("Could not read that draft.");
    return;
  }

  const me = profile();
  if (!me.gmailUser || !me.gmailAppPassword) {
    await answer("GMAIL_USER and GMAIL_APP_PASSWORD are not set on the server.");
    return;
  }

  const problem = preflight({ to: parsed.to, subject: parsed.subject, text: parsed.body });
  if (problem) {
    await answer(problem.slice(0, 190));
    return;
  }

  // The email text may say a resume is attached, so a broken resume must stop
  // the send rather than quietly produce a mail that contradicts itself.
  const resume = await fetchResume();
  if (resume && !resume.ok) {
    await answer(`Not sent — ${resume.reason}.`.slice(0, 190));
    return;
  }

  try {
    await sendMail({
      user: me.gmailUser,
      pass: me.gmailAppPassword,
      fromName: me.fullName,
      to: parsed.to,
      cc: me.ccSelf ? me.gmailUser : undefined,
      replyTo: me.email || undefined,
      subject: parsed.subject,
      text: parsed.body,
      attachment: resume?.ok ? resume.attachment : undefined,
    });

    await answer("Sent");
    // Drop the button so the same draft cannot be sent twice.
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: `✅ Sent\n\n${message.text}`,
      disable_web_page_preview: true,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[telegram send]", raw);
    await answer(explainSmtpError(raw).slice(0, 190));
  }
}

export async function POST(request: Request) {
  // Telegram echoes this header; without it the URL alone is the only secret.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId === undefined) return NextResponse.json({ ok: true });

  if (!allowed(chatId)) {
    await say(chatId, "This bot is private.");
    return NextResponse.json({ ok: true });
  }

  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (err) {
    console.error("[telegram]", err);
    await say(chatId, "⚠️ Something went wrong handling that.");
  }

  // Always 200 — a non-200 makes Telegram retry the same update.
  return NextResponse.json({ ok: true });
}

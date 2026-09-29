import { NextResponse } from "next/server";
import { readJobs } from "@/lib/llm";
import { buildTaskText } from "@/lib/llm/prompt";
import { explainSmtpError, preflight, sendMail } from "@/lib/mailer";
import { SEED_PROFILE } from "@/lib/seed";
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
    gmailUser: process.env.GMAIL_USER ?? "",
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? "",
    // The browser holds the resume file; the bot fetches one from a URL instead.
    resumeFileName: process.env.RESUME_URL ? "resume.pdf" : "",
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

async function fetchResume() {
  const url = process.env.RESUME_URL;
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return {
      filename: process.env.RESUME_FILENAME || "resume.pdf",
      content: Buffer.from(await res.arrayBuffer()),
      contentType: "application/pdf",
    };
  } catch {
    return undefined;
  }
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

const HELP = `Send me a job description — paste the text, or send a screenshot.

I read it, write the application email from your profile, and reply with a Send button.

You can send several screenshots of one posting together as an album.`;

async function handleMessage(message: TgMessage) {
  const chatId = message.chat.id;

  const text = (message.text ?? message.caption ?? "").trim();
  if (/^\/(start|help)\b/.test(text)) {
    await say(chatId, HELP);
    return;
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

  for (const job of jobs) {
    const body = composeEmail(normalizePlainText(job.body ?? ""), me);
    const subject = normalizePlainText(job.subject ?? "");
    const draft = renderDraft(job.company, job.role, job.recipients, subject, body);

    if (!job.recipients.length) {
      await say(
        chatId,
        `${draft}\n\n⚠️ No email address in this posting — I cannot send it. Open the app to add one.`,
      );
      continue;
    }

    await say(chatId, draft, {
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
      attachment: await fetchResume(),
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

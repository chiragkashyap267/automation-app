import { NextResponse } from "next/server";
import { allowed, botToken, fileUrl, say, tg } from "@/lib/telegramApi";
import { providerStatus, readJobs, reviseIfNeeded, writeOutreach } from "@/lib/llm";
import { buildTaskText, companyFromEmail } from "@/lib/llm/prompt";
import { explainSmtpError, preflight, sendMail } from "@/lib/mailer";
import { loadBotProfile, sharedProfileAvailable } from "@/lib/sharedProfile";
import {
  addToBatch,
  batchingAvailable,
  clearBatch,
  isLastOfBurst,
  loadBatch,
  sendsToday,
  setSummaryMessage,
} from "@/lib/batch";
import { sendAllInBatch } from "./sendAll";
import { cleanRecipients } from "@/lib/email";
import { unsupportedClaimsIn } from "@/lib/validate";
import { describeCandidates } from "@/lib/followup";
import { findQuiet, sendFollowUps } from "@/lib/followupRun";
import { loadOutbox, loadState, recordOutbound } from "@/lib/outbox";
import {
  clearQueue,
  describeWindow,
  loadQueue,
  queueDrafts,
  schedulingAvailable,
} from "@/lib/schedule";
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


/** Named once so a newline never has to be escaped inline. */
const NL = String.fromCharCode(10);

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

async function profile(): Promise<Profile> {
  const base = await loadBotProfile();
  return {
    ...base,
    // The browser holds the resume file; the bot fetches one from a URL.
    resumeFileName: process.env.RESUME_URL?.trim() ? resumeFilename() : "",
  };
}

async function fetchImage(fileId: string): Promise<{ mediaType: string; data: string } | null> {
  const info = await fetch(fileUrl(`getFile?file_id=${encodeURIComponent(fileId)}`));
  if (!info.ok) return null;

  const meta = (await info.json()) as { ok: boolean; result?: { file_path?: string } };
  const path = meta.result?.file_path;
  if (!path) return null;

  const file = await fetch(`https://api.telegram.org/file/bot${botToken()}/${path}`);
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

async function handleSendAll(
  chatId: number,
  summaryMessageId: number,
  answer: (text: string) => Promise<unknown>,
) {
  await sendAllInBatch(chatId, summaryMessageId, {
    profile: await profile(),
    attachment: async () => {
      const resume = await fetchResume();
      return resume?.ok ? resume.attachment : undefined;
    },
    edit: (messageId, text) =>
      tg("editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }),
    answer,
  });
}

/**
 * Offers, or sends, a nudge on everything that has gone quiet.
 *
 * The list is always recomputed, never taken from the message the offer was
 * posted in: a reply that arrived since then has to cancel the nudge, and the
 * only way to know is to look at the inbox again.
 */
async function handleFollowUps(
  chatId: number,
  send: boolean,
  answer: (text: string) => Promise<unknown>,
) {
  const me = await profile();
  const { candidates, scanned } = await findQuiet(me);

  if (scanned === null) {
    await answer("Could not read the inbox, so I cannot tell who already replied.");
    return;
  }
  if (!candidates.length) {
    await answer("Nothing has gone quiet. Everything is either too recent or answered.");
    return;
  }

  if (!send) {
    await say(chatId, describeCandidates(candidates), {
      reply_markup: {
        inline_keyboard: [
          [{ text: `✉️ Nudge all ${candidates.length}`, callback_data: "followup" }],
          [{ text: "🔕 Not now", callback_data: "followup:skip" }],
        ],
      },
    });
    return;
  }

  await answer(`Nudging ${candidates.length}…`);
  const { sent, outcomes } = await sendFollowUps(candidates, me, { chatId });

  const lines = outcomes.map((o) => `${o.ok ? "✓" : "✕"} ${o.label} — ${o.detail}`);
  await say(
    chatId,
    [`${sent ? "✅" : "⚠️"} Nudged ${sent} of ${candidates.length}`, "", lines.join(NL)].join(NL),
  );
}

/**
 * What is actually configured, read from the running server.
 *
 * Most of this app's confusion is environment variables: which one, set
 * where, and whether the deployment has picked them up yet. Asking the server
 * itself beats guessing from a dashboard.
 */
async function handleStatus(chatId: number) {
  const providers = providerStatus();
  const me = await profile();

  const pool = (name: string, p: { total: number; available: number } | null) =>
    p ? `${name}: ${p.available}/${p.total} key${p.total === 1 ? "" : "s"} ready` : `${name}: none`;

  const lines = [
    "READING AND WRITING",
    `  screenshots → ${providers.visionReader ?? "nothing configured"}`,
    `  text → ${providers.textReader ?? "nothing configured"}`,
    `  writing → ${providers.writer ?? "nothing configured"}`,
    `  ${pool("gemini", providers.gemini)}`,
    `  ${pool("groq", providers.groq)}`,
    `  ${pool("cerebras", providers.cerebras)}`,
    "",
    "SENDING",
    `  gmail: ${me.gmailUser || "GMAIL_USER not set"}`,
    `  password: ${me.gmailAppPassword ? "set" : "GMAIL_APP_PASSWORD not set"}`,
    `  resume: ${process.env.RESUME_URL?.trim() ? "from RESUME_URL" : "none attached"}`,
  ];

  if (!batchingAvailable()) {
    lines.push("", "STORAGE", "  Upstash not configured — no batching, no follow-ups");
  } else {
    const [batch, outbox, state, today] = await Promise.all([
      loadBatch(chatId),
      loadOutbox(),
      loadState(),
      sendsToday(chatId),
    ]);
    const nudged = Object.values(state).filter((x) => x.followedUpAt).length;
    lines.push(
      "",
      "STORAGE",
      `  waiting in this batch: ${batch?.drafts.length ?? 0}`,
      `  sent today: ${today}`,
      `  logged for follow-up: ${outbox.length}`,
      `  already nudged: ${nudged}`,
      `  profile: ${sharedProfileAvailable() ? "shared from the app" : "built-in seed"}`,
    );
  }

  await say(chatId, lines.join(NL));
}

/** What is waiting for the next working morning. */
async function handleQueue(chatId: number) {
  if (!schedulingAvailable()) {
    await say(chatId, "Scheduling needs Upstash configured.");
    return;
  }

  const queued = await loadQueue(chatId);
  if (!queued.length) {
    await say(chatId, "Nothing queued.");
    return;
  }

  const lines = queued.map(
    (d, i) => `${i + 1}. ${d.company || d.to[0] || "Unknown"} — ${d.role || "role"}`,
  );
  await say(
    chatId,
    [`⏰ ${queued.length} going out ${describeWindow()}`, "", lines.join(NL)].join(NL),
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🗑 Cancel all", callback_data: "unqueue" }]],
      },
    },
  );
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

  // The first line is the header renderDraft wrote: an icon, then
  // "Company — Role". Without the dash there was no company to write down.
  const header = text.split("\n")[0].replace(/^\S+\s*/, "").trim();
  const dash = header.includes(" — ") ? header.split(" — ") : [];
  const company = (dash[0] ?? "").trim();
  const role = (dash[1] ?? "").trim();

  return {
    company: company ?? "",
    role: role ?? "",
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
   This writes a short "do you have openings?" email instead.

I also check every weekday morning for applications that have gone quiet for a week, and offer to nudge them once. Ask any time with /followups.

Every draft also has a ⏰ button that holds it until the next working morning, which reads better than mail sent at midnight. /queue shows what is waiting.

/status shows what the server actually has configured.`;

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
  const me = await profile();
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

  if (/^\/queue\b/i.test(text)) {
    await handleQueue(chatId);
    return;
  }

  if (/^\/status\b/i.test(text)) {
    await handleStatus(chatId);
    return;
  }

  if (/^\/followups?\b/i.test(text)) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    await handleFollowUps(chatId, false, (t) => say(chatId, t));
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

  const me = await profile();
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

    // A one-shot read writes the email in the same call it extracts the
    // facts, which skipped the quality check the web app runs. Checking is
    // free; a second model call happens only if something is actually wrong.
    const { written } = await reviseIfNeeded(
      me,
      {
        company: job.company,
        role: job.role,
        location: job.location,
        reqId: job.reqId,
        recipients: addresses,
        contactName: job.contactName,
        highlights: job.highlights,
        seniority: job.seniority,
        confidence: job.confidence,
        notes: job.notes,
      },
      { subject: job.subject ?? "", body: job.body ?? "" },
    );

    const body = composeEmail(normalizePlainText(written.body), me);
    const subject = normalizePlainText(written.subject);
    const draft = renderDraft(job.company, job.role, addresses, subject, body);

    // Experience the resume does not support is the one thing worth refusing
    // over: it is a claim about the sender, and it cannot be edited here.
    const invented = unsupportedClaimsIn(body, me);
    if (invented.length) {
      await say(
        chatId,
        `${draft}${NL}${NL}⛔ Not sending this one. It claims "${invented.join('", "')}" at a named ` +
          `employer and your resume does not say that. Open the app to fix it, or send the posting again.`,
      );
      continue;
    }

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
        inline_keyboard: [
          [{ text: "✉️ Send it now", callback_data: "send" }],
          ...(schedulingAvailable()
            ? [[{ text: `⏰ Send ${describeWindow()}`, callback_data: "later" }]]
            : []),
        ],
      },
    });

    if (batchingAvailable()) {
      await addToBatch(chatId, {
        company: job.company,
        role: job.role,
        contactName: job.contactName ?? "",
        to: addresses,
        subject,
        body,
      });
    }
  }

  await refreshSummary(chatId);
}

/**
 * Keeps one message at the bottom of the chat showing how many drafts are
 * waiting, with a single Send-all button. Re-posted rather than edited so it
 * stays the newest message as more screenshots arrive.
 */
async function refreshSummary(chatId: number) {
  if (!batchingAvailable()) return;

  const first = await loadBatch(chatId);
  if (!first) return;

  // With only one draft its own button is enough; a summary would be noise.
  // Checked before waiting, so a single screenshot is answered immediately.
  if (first.drafts.filter((d) => d.to.length).length < 2) return;

  // An album arrives as one webhook call per photo. Without this every one of
  // them posts its own summary, each with a different half-finished count.
  if (!(await isLastOfBurst(chatId))) return;

  // Re-read: more screenshots may have landed while we waited.
  const batch = await loadBatch(chatId);
  if (!batch) return;

  const ready = batch.drafts.filter((d) => d.to.length);
  if (ready.length < 2) return;

  if (batch.summaryMessageId) {
    await tg("deleteMessage", { chat_id: chatId, message_id: batch.summaryMessageId });
  }

  const lines = ready.map((d, i) => `${i + 1}. ${d.company || "Unknown"} — ${d.role || "role"}`);
  const res = await say(
    chatId,
    [
      `📋 ${ready.length} emails ready`,
      "",
      lines.join(NL),
      "",
      "Send them all, or use each draft's own button.",
    ].join(NL),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `📤 Send all ${ready.length} now`, callback_data: "sendall" }],
          ...(schedulingAvailable()
            ? [[{ text: `⏰ Send ${describeWindow()}`, callback_data: "schedule" }]]
            : []),
          [{ text: "🗑 Clear the batch", callback_data: "clearbatch" }],
        ],
      },
    },
  );

  try {
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    if (body.ok && body.result) await setSummaryMessage(chatId, body.result.message_id);
  } catch {
    /* the summary is a convenience; losing its id only costs a duplicate */
  }
}

async function handleCallback(query: NonNullable<TgUpdate["callback_query"]>) {
  const message = query.message;
  const chatId = message?.chat.id;
  if (!message || chatId === undefined) return;

  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: query.id, text });

  if (query.data === "clearbatch") {
    await clearBatch(chatId);
    await answer("Batch cleared");
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: "🗑 Batch cleared. Nothing was sent.",
    });
    return;
  }

  if (query.data === "sendall") {
    await handleSendAll(chatId, message.message_id, answer);
    return;
  }

  if (query.data === "unqueue") {
    await clearQueue(chatId);
    await answer("Queue cleared");
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: "🗑 Queue cleared. Nothing was sent.",
    });
    return;
  }

  if (query.data === "schedule") {
    const batch = await loadBatch(chatId);
    const ready = (batch?.drafts ?? []).filter((d) => d.to.length);
    if (!ready.length) {
      await answer("Nothing in this batch to schedule.");
      return;
    }

    const total = await queueDrafts(chatId, ready);
    await clearBatch(chatId);
    await answer(`Queued ${ready.length}`);
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text:
        `⏰ ${ready.length} queued — going out ${describeWindow()}.${NL}${NL}` +
        `${total} waiting in all. /queue to see them, or call it off.`,
    });
    return;
  }

  if (query.data === "later") {
    const parsed = parseDraft(message.text ?? "");
    if (!parsed?.to.length) {
      await answer("Could not read that draft.");
      return;
    }

    await queueDrafts(chatId, [
      {
        company: parsed.company,
        role: parsed.role,
        to: parsed.to,
        subject: parsed.subject,
        body: parsed.body,
      },
    ]);
    await answer("Queued");
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: `⏰ Queued for ${describeWindow()}${NL}${NL}${message.text}`,
      disable_web_page_preview: true,
    });
    return;
  }

  if (query.data === "followup:skip") {
    await answer("Left alone");
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: "🔕 No nudges sent. I will ask again tomorrow.",
    });
    return;
  }

  if (query.data === "followup") {
    // Drop the button first, so a double tap cannot start a second run.
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    await handleFollowUps(chatId, true, answer);
    return;
  }

  const parsed = parseDraft(message.text ?? "");
  if (!parsed) {
    await answer("Could not read that draft.");
    return;
  }

  const me = await profile();
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
    const messageId = await sendMail({
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

    await recordOutbound({
      id: messageId || `${chatId}:${message.message_id}`,
      messageId,
      to: parsed.to,
      company: parsed.company,
      role: parsed.role,
      contactName: "",
      subject: parsed.subject,
      sentAt: Date.now(),
      via: "bot",
      chatId,
    }).catch((err) => console.error("[telegram] outbox", err));

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

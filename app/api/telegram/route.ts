import { NextResponse } from "next/server";
import { allowed, botToken, fileUrl, say, tg } from "@/lib/telegramApi";
import {
  providerStatus,
  readJobs,
  reviseIfNeeded,
  writeEmail,
  writeOutreach,
  writePitch,
} from "@/lib/llm";
import { parseLead, servicesReady } from "@/lib/services";
import { loadSharedServices } from "@/lib/sharedServices";
import { buildTaskText, companyFromEmail, type Facts } from "@/lib/llm/prompt";
import { explainSmtpError, preflight, sendMail } from "@/lib/mailer";
import { loadBotProfile, sharedProfileExists } from "@/lib/sharedProfile";
import { checkExperience } from "@/lib/experience";
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
import { explainImapError } from "@/lib/inboxScan";
import { scanForPostings } from "@/lib/inboxJobs";
import { replySubject } from "@/lib/followup";
import { fetchResume, resumeFilename } from "@/lib/resumeFetch";
import { loadSharedResume, type SharedResume } from "@/lib/sharedResume";
import { resumeVariants } from "@/lib/resume";
import { applyFixes, recipeProblems, validateDraft, type Issue } from "@/lib/validate";
import {
  findRecipe,
  hashInput,
  profileFingerprint,
  renderRecipe,
  type Recipe,
} from "@/lib/recipeCore";
import { readSharedExtract, writeSharedExtract } from "@/lib/sharedCache";
import { loadSharedRecipes } from "@/lib/sharedRecipes";
import { findPriorApplication, type PastSend } from "@/lib/priorApplication";
import { describeCandidates } from "@/lib/followup";
import { findQuiet, sendFollowUps } from "@/lib/followupRun";
import { loadOutbox, loadState, outboxAvailable, recordOutbound } from "@/lib/outbox";
import {
  clearQueue,
  describeWindow,
  loadQueue,
  queueDrafts,
  schedulingAvailable,
} from "@/lib/schedule";
import { digestHeader, jobCard, jobKeyboard, markSeen, runWatch } from "@/lib/jobs/watch";
import {
  asPostingText,
  isReadableLinkedIn,
  postAsText,
  readLinkedIn,
} from "@/lib/linkedin";
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
async function handleSendAll(
  chatId: number,
  summaryMessageId: number,
  answer: (text: string) => Promise<unknown>,
) {
  const me = await profile();
  await sendAllInBatch(chatId, summaryMessageId, {
    profile: me,
    attachment: async (draft) => {
      const resume = await fetchResume(draft.role, me.fullName);
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
/**
 * Openings found by watching company career boards.
 *
 * Each one arrives with a button that opens the employer's own form, which
 * is the only way into a big company — there is no address to write to, and
 * inventing one would waste a send and the goodwill of a real inbox.
 */
async function handleJobs(chatId: number) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  const me = await profile();
  const result = await runWatch(me);

  await say(chatId, digestHeader(result));

  const total = result.fresh.length;
  for (let i = 0; i < total; i += 1) {
    await say(chatId, jobCard(result.fresh[i], i + 1, total), {
      reply_markup: jobKeyboard(result.fresh[i]),
    });
    // Only once it has actually arrived. Marking it seen any earlier
    // buries the job for forty-five days if the send failed.
    await markSeen(result.fresh[i]);
  }

  if (result.forgetful && total) {
    await say(
      chatId,
      "Note: no store is configured, so I cannot remember what I have already shown you. These will come round again.",
    );
  }
}

/**
 * Which resume will actually be attached.
 *
 * Worth spelling out, because the answer changed: a file uploaded in the
 * web app now outranks RESUME_URL, and there is no way to tell from the
 * outside which one an email carried.
 */
function describeResumeSource(uploaded: SharedResume | null): string {
  if (uploaded) {
    const age = Math.round((Date.now() - uploaded.savedAt) / 86_400_000);
    const when = age <= 0 ? "uploaded today" : age === 1 ? "uploaded yesterday" : `uploaded ${age} days ago`;
    const size = uploaded.bytes ? `, ${Math.round(uploaded.bytes / 1024)} KB` : "";
    // Says which store, because "the file is there" and "the file can be
    // downloaded" are different claims once it is hosted elsewhere.
    const where = uploaded.url ? "Cloudinary" : "the web app";
    return `${uploaded.filename} (${when}${size}, in ${where})`;
  }
  return process.env.RESUME_URL?.trim() ? "from RESUME_URL" : "none attached";
}

async function handleStatus(chatId: number) {
  const providers = providerStatus();
  const [me, uploadedResume] = await Promise.all([profile(), loadSharedResume()]);

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
    "WRITING FROM",
    `  ${me.fullName || "no name set"}, ${me.headline || "no headline"}`,
    `  experience: ${me.yearsExperience || "not set"} year(s)`,
    ...(checkExperience(me).mismatch
      ? [`  ⚠️ ${checkExperience(me).message}`]
      : []),
    "",
    "SENDING",
    `  gmail: ${me.gmailUser || "GMAIL_USER not set"}`,
    `  password: ${me.gmailAppPassword ? "set" : "GMAIL_APP_PASSWORD not set"}`,
    `  resume: ${describeResumeSource(uploadedResume)}`,
    ...(resumeVariants().length
      ? [`  role-specific: ${resumeVariants().map((v) => v.keyword).join(", ")}`]
      : []),
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
      `  saved recipes: ${(await loadSharedRecipes()).length}`,
      `  services profile: ${servicesReady(await loadSharedServices()) ? "ready for /pitch" : "not set up"}`,
      `  already nudged: ${nudged}`,
      `  profile: ${(await sharedProfileExists()) ? "shared from the app" : "built-in seed"}`,
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

/**
 * Job descriptions that were emailed straight to the inbox.
 *
 * These are the best leads there are: the sender is already the right person
 * to answer, which is exactly what a screenshot of a posting so often lacks.
 * The reply goes back inside their own thread rather than arriving cold.
 */
async function handleInbox(chatId: number) {
  const me = await profile();
  if (!me.gmailUser || !me.gmailAppPassword) {
    await say(chatId, "GMAIL_USER and GMAIL_APP_PASSWORD are not set on the server.");
    return;
  }

  await say(chatId, "Reading the last week of mail…");

  // Never treat a thread we started as somebody else's posting.
  const recipes = await loadSharedRecipes();
  const fingerprint = profileFingerprint(me);

  const known = new Set(
    (await loadOutbox())
      .map((e) => e.messageId.replace(/^<|>$/g, "").toLowerCase())
      .filter(Boolean),
  );

  let found;
  try {
    found = await scanForPostings(
      { user: me.gmailUser, pass: me.gmailAppPassword },
      { skipMessageIds: known },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await say(chatId, `⚠️ ${explainImapError(raw).slice(0, 300)}`);
    return;
  }

  if (!found.candidates.length) {
    await say(
      chatId,
      `Read ${found.scanned} messages. None of them looked like a job description ` +
        `someone sent you directly.`,
    );
    return;
  }

  await say(
    chatId,
    `📬 ${found.candidates.length} of ${found.scanned} look like postings. Writing replies…`,
  );

  const past = await pastSends();

  for (const candidate of found.candidates) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });

    let job;
    try {
      const { result } = await readJobs(
        { text: buildTaskText(me, [candidate.text]), images: [] },
        readModeFor(recipes),
      );
      job = result.jobs[0];
    } catch (err) {
      console.error("[inbox]", err instanceof Error ? err.message : err);
      continue;
    }
    if (!job) continue;

    // The sender wrote to you, so the sender is who to answer — not whatever
    // address the posting text happens to mention.
    const { addresses } = cleanRecipients([candidate.from]);
    if (!addresses.length) continue;

    const written = await composeFor(
      job,
      {
        company: job.company,
        role: job.role,
        location: job.location,
        reqId: job.reqId,
        recipients: addresses,
        contactName: job.contactName || candidate.fromName,
        highlights: job.highlights,
        seniority: job.seniority,
        confidence: job.confidence,
        notes: job.notes,
      },
      me,
      recipes,
      fingerprint,
    );

    const subject = replySubject(candidate.subject || normalizePlainText(written.subject));
    const checked = vet(
      {
        subject,
        body: composeEmail(normalizePlainText(written.body), me),
        recipients: addresses,
        company: job.company,
        contactName: job.contactName || candidate.fromName,
      },
      me,
      past,
    );
    const body = checked.body;
    const draft = renderDraft(job.company, job.role, addresses, subject, body, candidate.messageId);

    if (checked.errors.length) {
      await say(
        chatId,
        `${draft}${NL}${NL}⛔ Not sending this one:${NL}` +
          checked.errors.map((e) => `• ${e.message}`).join(NL),
      );
      continue;
    }

    const notes = checked.warnings.map((w) => `⚠️ ${w.message}`).join(NL);

    await say(
      chatId,
      `${draft}${NL}${NL}↩️ Goes back inside their own thread.${notes ? `${NL}${NL}${notes}` : ""}`,
      {
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
        contactName: job.contactName || candidate.fromName,
        inReplyTo: candidate.messageId ? `<${candidate.messageId}>` : "",
        to: addresses,
        subject,
        body,
      });
    }
  }

  await refreshSummary(chatId);
}

/**
 * Runs the same checks the web app runs, and fixes what can be fixed.
 *
 * The bot only ever ran the invented-experience rule, so misspellings, a
 * mistyped portfolio link and writing to the same company twice all went
 * straight out. There is no edit box in a chat window, so anything with an
 * unambiguous repair — a known misspelling, a greeting that should use the
 * name the posting gave — is applied here rather than reported.
 */
function vet(
  draft: { subject: string; body: string; recipients: string[]; company: string; contactName: string },
  me: Profile,
  past: PastSend[],
): { body: string; errors: Issue[]; warnings: Issue[] } {
  const prior = findPriorApplication(past, draft.company, draft.recipients);
  const check = (body: string) => validateDraft({ ...draft, body }, me, prior);

  let body = draft.body;
  let issues = check(body);

  const fixable = issues.filter((i) => i.fix);
  if (fixable.length) {
    body = applyFixes(body, fixable);
    issues = check(body);
  }

  return {
    body,
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

/** Everything already sent, for the "you wrote to them last week" check. */
async function pastSends(): Promise<PastSend[]> {
  if (!outboxAvailable()) return [];
  const [entries, state] = await Promise.all([loadOutbox(), loadState()]);
  return entries.map((e) => ({
    company: e.company,
    role: e.role,
    to: e.to,
    sentAt: e.sentAt,
    reply: state[e.id]?.repliedAt ? "replied" : "awaiting",
  }));
}

type Composed = { subject: string; body: string; fromRecipe: boolean };

/**
 * The email for one posting, as cheaply as it can honestly be produced.
 *
 * A one-shot read has already written it, in which case it only needs
 * checking. Otherwise a recipe learned in the web app can render it here for
 * nothing, and the model is paid for only when no recipe fits or the one
 * that does no longer matches the profile.
 */
async function composeFor(
  job: { subject?: string; body?: string },
  facts: Facts,
  me: Profile,
  recipes: Recipe[],
  fingerprint: string,
): Promise<Composed> {
  if (job.subject && job.body) {
    const { written } = await reviseIfNeeded(me, facts, { subject: job.subject, body: job.body });
    return { subject: written.subject, body: written.body, fromRecipe: false };
  }

  const recipe = findRecipe(recipes, facts, fingerprint);
  if (recipe) {
    const rendered = renderRecipe(recipe, facts);
    const problems = recipeProblems(rendered.body, rendered.subject, me);
    if (!problems.length) {
      return { subject: rendered.subject, body: rendered.body, fromRecipe: true };
    }
    console.warn(`[recipe] ${recipe.key} rejected: ${problems.join("; ")}`);
  }

  const { written } = await writeEmail(me, facts);
  return { subject: written.subject, body: written.body, fromRecipe: false };
}

/**
 * Extracting facts is cheaper than extracting and writing in one call, but
 * only worth it when a recipe is likely to cover the writing.
 */
function readModeFor(recipes: Recipe[]): "extract" | "full" {
  return recipes.length ? "extract" : "full";
}

/**
 * A freelance pitch, which is the other half of the business: selling a
 * service to a company rather than asking one for a job.
 *
 * Deliberately one lead at a time and one tap per send. Cold pitches have
 * worse deliverability than applications, and a burst of them is the
 * fastest way to lose the account that everything else here depends on.
 */
async function handlePitch(chatId: number, text: string) {
  const services = await loadSharedServices();

  if (!servicesReady(services)) {
    await say(
      chatId,
      "Set up the services profile first — open the app and fill in Services. " +
        "I need at least your name, what you offer, and some real past work to point at.",
    );
    return;
  }

  const lead = parseLead(text);
  if (!lead) {
    await say(
      chatId,
      [
        "Send me a lead with an email address in it. Either:",
        "",
        "  /pitch hello@brand.com they need packaging for a new snack range",
        "",
        "or paste the whole enquiry after /pitch and I will read it.",
      ].join(NL),
    );
    return;
  }

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  let written;
  let problems: string[] = [];
  try {
    ({ written, problems } = await writePitch(services, lead));
  } catch (err) {
    await say(chatId, `⚠️ ${err instanceof Error ? err.message : "Could not write that."}`);
    return;
  }

  const signature = [
    services.fullName || services.businessName,
    services.tagline,
    [services.portfolio, services.showreel].filter(Boolean).join("  |  "),
    [services.phone, services.email].filter(Boolean).join("  |  "),
  ]
    .filter((line) => line && line.trim())
    .join(NL);

  const body = `${normalizePlainText(written.body)}${NL}${NL}${services.signOff || "Best regards"},${NL}${signature}`;
  const subject = normalizePlainText(written.subject);
  const draft = renderDraft(
    lead.company || "Pitch",
    lead.need.slice(0, 40),
    [lead.email],
    subject,
    body,
    "",
    "pitch",
  );

  if (problems.length) {
    await say(
      chatId,
      `${draft}${NL}${NL}⛔ Not sending this one:${NL}` +
        problems.map((x) => `• ${x}`).join(NL),
    );
    return;
  }

  await say(chatId, draft, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✉️ Send it now", callback_data: "send" }],
        ...(schedulingAvailable()
          ? [[{ text: `⏰ Send ${describeWindow()}`, callback_data: "later" }]]
          : []),
      ],
    },
  });
}

/** The reply doubles as the store, so its shape has to be parseable. */
function renderDraft(
  company: string,
  role: string,
  to: string[],
  subject: string,
  body: string,
  threadId = "",
  kind: "application" | "pitch" = "application",
) {
  const header = [company, role].filter(Boolean).join(" — ") || "Job application";
  // The Thread line is how a reply to mail we received keeps its thread:
  // the draft text is the only place state lives between two webhook calls.
  const thread = threadId ? `Thread: ${threadId}\n` : "";
  // A pitch must not pick up a resume or an application-shaped nudge,
  // and the draft text is the only state that survives to the Send tap.
  const stamp = kind === "pitch" ? `Kind: pitch\n` : "";
  return `📬 ${header}\n\nTo: ${to.join(", ")}\n${thread}${stamp}Subject: ${subject}\n\n${body}`;
}

function parseDraft(text: string) {
  const to = text.match(/^To:\s*(.+)$/m)?.[1] ?? "";
  const threadId = text.match(/^Thread:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const kind: "application" | "pitch" = /^Kind:\s*pitch$/m.test(text)
    ? "pitch"
    : "application";
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
    threadId,
    kind,
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

/jobs watches company career boards and shows openings that fit you — tech roles, 1-3 years, in India, newest first. Each one has a button that opens the employer's own application form. Nothing is emailed: big companies only take applications through their portal.

I also check every weekday morning for applications that have gone quiet for a week, and offer to nudge them once. Ask any time with /followups.

Every draft also has a ⏰ button that holds it until the next working morning, which reads better than mail sent at midnight. /queue shows what is waiting.

/pitch sells your freelance services to a lead instead of applying for a job:
   /pitch hello@brand.com they need packaging for a new snack range

/inbox reads the last week of mail for job descriptions people sent you directly, and drafts a reply inside their own thread.

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

  const subject = normalizePlainText(written.subject);
  // A cold enquiry is still an email going to a stranger, so it gets the
  // same checks a posting-driven draft gets.
  const checked = vet(
    {
      subject,
      body: composeEmail(normalizePlainText(written.body), me),
      recipients: [ask.email],
      company,
      contactName: "",
    },
    me,
    await pastSends(),
  );

  const draft = renderDraft(company || "Cold enquiry", role, [ask.email], subject, checked.body);

  if (checked.errors.length) {
    await say(
      chatId,
      `${draft}${NL}${NL}⛔ Not sending this one:${NL}` +
        checked.errors.map((e) => `• ${e.message}`).join(NL),
    );
    return;
  }

  const notes = checked.warnings.map((w) => `⚠️ ${w.message}`).join(NL);

  await say(chatId, notes ? `${draft}${NL}${NL}${notes}` : draft, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✉️ Send it now", callback_data: "send" }],
        ...(schedulingAvailable()
          ? [[{ text: `⏰ Send ${describeWindow()}`, callback_data: "later" }]]
          : []),
      ],
    },
  });
}

async function handleMessage(message: TgMessage) {
  const chatId = message.chat.id;

  // Not const: a LinkedIn job link is replaced by the posting behind it.
  let text = (message.text ?? message.caption ?? "").trim();
  if (/^\/(start|help)\b/.test(text)) {
    await say(chatId, HELP);
    return;
  }

  if (/^\/pitch\b/i.test(text)) {
    await handlePitch(chatId, text);
    return;
  }

  if (/^\/inbox\b/i.test(text)) {
    await handleInbox(chatId);
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

  if (/^\/jobs?\b/i.test(text)) {
    await handleJobs(chatId);
    return;
  }

  // Everything past this point writes an email, and writing one without a
  // profile produces an application from nobody describing no experience.
  // There used to be a built-in profile to fall back on, which hid this —
  // and wrote from someone's old resume once the real one changed.
  const ready = await profile();
  if (!ready.fullName.trim() || !ready.resumeText.trim()) {
    await say(
      chatId,
      [
        "I have nothing to write from yet.",
        "",
        !ready.fullName.trim() ? "• your name is not set" : "",
        !ready.resumeText.trim() ? "• your resume text is empty" : "",
        "",
        "Open the web app, fill in Details and paste your resume text. It reaches me on its own within a few seconds.",
      ]
        .filter((line) => line !== "")
        .join(NL),
    );
    return;
  }

  // A link on its own has nothing to read. LinkedIn in particular serves job
  // pages to logged-out visitors with the description stripped out, so there
  // is no posting text and no address behind the link — say so rather than
  // feeding a URL to the model and returning nonsense.
  if (!message.photo?.length && BARE_URL.test(text)) {
    const link = text.trim();

    // Both kinds of LinkedIn link are public: a job listing because
    // LinkedIn wants it in search results, a feed post because it is
    // served to anyone embedding it on their own site.
    if (isReadableLinkedIn(link)) {
      await tg("sendChatAction", { chat_id: chatId, action: "typing" });
      const found = await readLinkedIn(link);

      if (!found) {
        console.error("[linkedin] could not read", link);
        await say(
          chatId,
          [
            "I could not read that one. Usually it is a post with no text of its own — a shared image, a video, or a repost with nothing written above it.",
            "",
            "Screenshot it and send me the image; that reads the words off the picture and works on anything.",
          ].join(NL),
        );
        return;
      }

      const emails = found.kind === "job" ? found.job.emails : found.post.emails;

      if (!emails.length) {
        const headline =
          found.kind === "job"
            ? [
                `${found.job.title}${found.job.company ? ` at ${found.job.company}` : ""}`,
                found.job.location,
                "",
                "There is no email in this one, so there is nobody to write to — it only takes applications through LinkedIn itself.",
              ]
            : [
                found.post.author ? `Post by ${found.post.author}` : "LinkedIn post",
                "",
                "I read it, but there is no email address in it, so there is nobody to write to. Reply or message them on LinkedIn instead.",
              ];
        await say(chatId, [...headline, "", link].filter(Boolean).join(NL));
        return;
      }

      text = found.kind === "job" ? asPostingText(found.job) : postAsText(found.post);
    } else {
      await say(
        chatId,
        "That is just a link, and I cannot open pages. Send a screenshot of the posting, or paste the text.",
      );
      return;
    }
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
  const recipes = await loadSharedRecipes();
  const fingerprint = profileFingerprint(me);

  // The same screenshot shared twice should not be read twice.
  const inputHash = hashInput(images, texts);
  // A cached entry holds only the facts; a fresh read may also carry the
  // email the model wrote in the same call.
  type ReadJob = Facts & { subject?: string; body?: string };
  let jobs: ReadJob[] | null = await readSharedExtract(inputHash);
  const cached = Boolean(jobs?.length);

  if (!cached) {
    try {
      const { result } = await readJobs(
        { text: buildTaskText(me, texts), images },
        readModeFor(recipes),
      );
      jobs = result.jobs;
      await writeSharedExtract(
        inputHash,
        // Never cache the written email: the wording depends on the profile
        // and would outlive an edit to it.
        jobs.map(({ subject: _s, body: _b, ...facts }) => facts as Facts),
      );
    } catch (err) {
      await say(chatId, `⚠️ ${err instanceof Error ? err.message : "Could not read that."}`);
      return;
    }
  }
  if (!jobs) jobs = [];

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

  const past = await pastSends();

  for (const job of jobs) {
    const { addresses, suspicious } = cleanRecipients(job.recipients ?? []);

    const written = await composeFor(
      job,
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
      me,
      recipes,
      fingerprint,
    );

    const subject = normalizePlainText(written.subject);
    const checked = vet(
      {
        subject,
        body: composeEmail(normalizePlainText(written.body), me),
        recipients: addresses,
        company: job.company,
        contactName: job.contactName ?? "",
      },
      me,
      past,
    );
    const body = checked.body;
    const draft = renderDraft(job.company, job.role, addresses, subject, body);

    // An error is something that cannot be repaired from a chat window, so
    // the draft is shown without a Send button rather than quietly going out.
    if (checked.errors.length) {
      await say(
        chatId,
        `${draft}${NL}${NL}⛔ Not sending this one:${NL}` +
          checked.errors.map((e) => `• ${e.message}`).join(NL),
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

    const notes = [
      ...(written.fromRecipe ? ["♻️ Written from a saved recipe — no API call."] : []),
      ...checked.warnings.map((w) => `⚠️ ${w.message}`),
      ...(suspicious.length
        ? [
            `⚠️ Check ${suspicious.join(", ")} against the posting — a leading icon is ` +
              `often misread into the address.`,
          ]
        : []),
    ];
    const warning = notes.length ? `${NL}${NL}${notes.join(NL)}` : "";

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
        inReplyTo: parsed.threadId ? `<${parsed.threadId}>` : "",
        kind: parsed.kind,
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
  // A service pitch carries no CV. Sending one turns an offer of work
  // into what looks like a job application.
  const resume = parsed.kind === "pitch" ? null : await fetchResume(parsed.role, me.fullName);
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
      inReplyTo: parsed.threadId ? `<${parsed.threadId}>` : undefined,
      references: parsed.threadId ? `<${parsed.threadId}>` : undefined,
      attachment: resume?.ok ? resume.attachment : undefined,
    });

    await recordOutbound({
      id: messageId || `${chatId}:${message.message_id}`,
      messageId,
      to: parsed.to,
      company: parsed.company,
      role: parsed.role,
      contactName: "",
      kind: parsed.kind,
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

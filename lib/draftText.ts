/**
 * The draft, as it lives inside a Telegram message.
 *
 * A webhook remembers nothing between calls, so the message the bot posts
 * IS the store: tapping Send reads the email back out of the text it is
 * attached to. That makes the shape of this text load-bearing in a way
 * the eye does not catch — it is a wire format pretending to be a chat
 * message.
 *
 * It bit once already. Warnings were appended under the draft, and the
 * body was read as "everything after the Subject line", so an application
 * went out with
 *
 *     ⚠️ You wrote to hr@tramo.in 5 days ago. Sending again may read as
 *     spam.
 *
 * printed underneath the signature, in the email, to the employer.
 *
 * Two defences now. Notes go ABOVE the draft, so the body is always the
 * last thing in the message and has nothing after it to absorb. And the
 * parser strips trailing note lines anyway, because a draft posted before
 * this change still has a working Send button sitting in the chat history.
 */

export type DraftKind = "application" | "pitch";

export type ParsedDraft = {
  threadId: string;
  kind: DraftKind;
  company: string;
  role: string;
  to: string[];
  subject: string;
  body: string;
};

/** The first line of the draft proper, so notes can sit above it. */
const DRAFT_MARK = "📬"; // 📬

/**
 * Every prefix the bot uses for something that is commentary, not email.
 *
 * Kept as escapes: these are the one thing in the file that must survive
 * every editor and transport between here and production intact.
 */
const NOTE_PREFIX = new RegExp(
  "^(?:" +
    [
      "\\u26A0\\uFE0F?", // warning
      "\\u26D4", // no entry
      "\\u267B\\uFE0F?", // recycle, for a recipe-written draft
      "\\u21A9\\uFE0F?", // reply arrow
      "\\u23F0", // alarm clock
      "\\u2705", // tick
      "\\uD83D\\uDDD1\\uFE0F?", // bin
      "\\u2022", // a bullet under one of the above
    ].join("|") +
    ")",
);

/**
 * Drops note lines from the end of a body.
 *
 * Only from the end, and only lines that begin with one of the bot's own
 * markers. An email body is prose and a signature; it does not begin a
 * line with a warning triangle.
 */
export function stripTrailingNotes(body: string): string {
  const lines = body.split("\n");

  let index = lines.length;
  let cut = -1;

  while (index > 0) {
    const line = lines[index - 1].trim();
    if (!line) {
      index--;
      continue;
    }
    if (NOTE_PREFIX.test(line)) {
      index--;
      cut = index;
      continue;
    }
    break;
  }

  return (cut === -1 ? body : lines.slice(0, cut).join("\n")).trimEnd();
}

/** The reply doubles as the store, so its shape has to be parseable. */
export function renderDraft(
  company: string,
  role: string,
  to: string[],
  subject: string,
  body: string,
  threadId = "",
  kind: DraftKind = "application",
): string {
  const header = [company, role].filter(Boolean).join(" — ") || "Job application";
  // The Thread line is how a reply to mail we received keeps its thread:
  // the draft text is the only place state lives between two webhook calls.
  const thread = threadId ? `Thread: ${threadId}\n` : "";
  // A pitch must not pick up a resume or an application-shaped nudge,
  // and the draft text is the only state that survives to the Send tap.
  const stamp = kind === "pitch" ? `Kind: pitch\n` : "";
  return `${DRAFT_MARK} ${header}\n\nTo: ${to.join(", ")}\n${thread}${stamp}Subject: ${subject}\n\n${body}`;
}

/**
 * Puts the bot's own remarks above the draft, never below it.
 *
 * Above is both safer and better to read: the reason not to send is the
 * first thing in front of you, rather than something found after the
 * signature once the thumb is already near the button.
 */
export function withNotes(draft: string, notes: string[]): string {
  const said = notes.filter((note) => note && note.trim());
  if (!said.length) return draft;
  return `${said.join("\n")}\n\n${draft}`;
}

export function parseDraft(text: string): ParsedDraft | null {
  const to = text.match(/^To:\s*(.+)$/m)?.[1] ?? "";
  const threadId = text.match(/^Thread:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const kind: DraftKind = /^Kind:\s*pitch$/m.test(text) ? "pitch" : "application";
  const subject = text.match(/^Subject:\s*(.+)$/m)?.[1] ?? "";

  const subjectAt = text.indexOf("\nSubject:");
  if (subjectAt === -1) return null;

  const afterSubject = text.indexOf("\n", subjectAt + 1);
  const blank = text.indexOf("\n\n", afterSubject);
  if (blank === -1) return null;

  // The header line carries the company and role. Found by its marker
  // rather than by being first, because notes now sit above it.
  const markAt = text.indexOf(`${DRAFT_MARK} `);
  const headerLine =
    markAt === -1
      ? text.split("\n")[0]
      : text.slice(markAt, text.indexOf("\n", markAt) === -1 ? undefined : text.indexOf("\n", markAt));

  const header = headerLine.replace(/^\S+\s*/, "").trim();
  const dash = header.includes(" — ") ? header.split(" — ") : [];

  return {
    threadId,
    kind,
    company: (dash[0] ?? "").trim(),
    role: (dash[1] ?? "").trim(),
    to: to.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean),
    subject: subject.trim(),
    body: stripTrailingNotes(text.slice(blank + 2)),
  };
}

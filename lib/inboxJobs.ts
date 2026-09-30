import { ImapFlow } from "imapflow";
import { extractPlainText, withoutQuotedReply } from "./mimeText";
import { classifyReply } from "./replyKind";

/**
 * Finding job descriptions that were emailed straight to the inbox.
 *
 * Recruiters send postings as ordinary mail all the time, and those are the
 * best possible leads: the sender address is already the right one to reply
 * to, which is the thing screenshots so often lack.
 *
 * Deliberately not job-alert digests. Those come from a no-reply address and
 * carry no one to write to, so drafting a reply to one produces a dead
 * letter. Anything unrepliable is rejected before it costs a model call.
 */

/** Addresses nobody reads. A draft to one of these can never arrive. */
const UNREPLIABLE =
  /(^|[.\-_])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|alerts?|bounce|automated)([.\-_]|@)/i;

/** Senders that only ever send digests, however human the subject looks. */
const DIGEST_SENDERS =
  /jobs-listings@linkedin|jobalerts|job-alerts|alerts@|@indeedemail|@glassdoor|newsletter@|updates@/i;

/** One of these alone is enough: nothing else phrases itself this way. */
const STRONG = [
  "job description",
  "we are looking for",
  "we are hiring",
  "hiring for",
  "job opening",
  "share your updated resume",
  "share your resume",
  "please find the jd",
  "find the jd",
  "attached jd",
  "current opening",
];

/** Two of these together suggest a posting. */
const WEAK = [
  "notice period",
  "expected ctc",
  "current ctc",
  "responsibilities",
  "requirements",
  "qualifications",
  "experience required",
  "years of experience",
  "skills required",
  "walk-in",
  "vacancy",
  "position",
  "immediate joiner",
  "relevant experience",
  "apply",
];

export type PostingCandidate = {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
  at: number;
};

export type Verdict = { ok: boolean; score: number; reason: string };

export function looksLikeJobPosting(input: {
  from: string;
  subject: string;
  text: string;
}): Verdict {
  const from = input.from.toLowerCase();
  const haystack = `${input.subject} ${input.text}`.toLowerCase();

  if (!from.includes("@")) return { ok: false, score: 0, reason: "no sender address" };
  if (UNREPLIABLE.test(from)) return { ok: false, score: 0, reason: "nobody reads that address" };
  if (DIGEST_SENDERS.test(from)) return { ok: false, score: 0, reason: "a job alert, not a posting" };

  // A reply to something we sent is a reply, not a new posting.
  const classified = classifyReply(input.subject, input.text.slice(0, 400));
  if (classified.kind !== "other" && classified.kind !== "recruiter") {
    return { ok: false, score: 0, reason: `looks like a ${classified.kind}` };
  }

  // A marketing mail is mostly links and an unsubscribe footer.
  const links = (input.text.match(/https?:\/\//g) ?? []).length;
  if (links > 15 && /unsubscribe/i.test(input.text)) {
    return { ok: false, score: 0, reason: "a newsletter" };
  }

  const strong = STRONG.filter((term) => haystack.includes(term)).length;
  const weak = WEAK.filter((term) => haystack.includes(term)).length;
  const score = strong * 2 + weak;

  if (!strong && weak < 2) return { ok: false, score, reason: "does not read like a posting" };
  if (input.text.trim().length < 120) return { ok: false, score, reason: "too short to read" };

  return { ok: true, score, reason: "looks like a posting" };
}

/**
 * Recent mail that reads like a job description.
 *
 * `skipMessageIds` carries everything already in the outbox so a thread we
 * started is never mistaken for someone else's posting.
 */
export async function scanForPostings(
  auth: { user: string; pass: string },
  options: { sinceDays?: number; limit?: number; skipMessageIds?: Set<string> } = {},
): Promise<{ candidates: PostingCandidate[]; scanned: number }> {
  const { sinceDays = 7, limit = 5, skipMessageIds = new Set<string>() } = options;

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth,
    logger: false,
  });

  const candidates: PostingCandidate[] = [];
  let scanned = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Envelopes first: most mail is rejected on the sender alone, and
      // downloading every body would be slow and pointless.
      const shortlist: { uid: number; from: string; fromName: string; subject: string; at: number; messageId: string }[] =
        [];

      for await (const message of client.fetch({ since }, { envelope: true, uid: true })) {
        scanned += 1;
        const envelope = message.envelope;
        if (!envelope) continue;

        const from = envelope.from?.[0]?.address?.toLowerCase() ?? "";
        const messageId = (envelope.messageId ?? "").replace(/^<|>$/g, "").toLowerCase();
        if (!from || UNREPLIABLE.test(from) || DIGEST_SENDERS.test(from)) continue;
        if (messageId && skipMessageIds.has(messageId)) continue;

        shortlist.push({
          uid: message.uid,
          from,
          fromName: envelope.from?.[0]?.name ?? "",
          subject: envelope.subject ?? "",
          at: envelope.date ? new Date(envelope.date).getTime() : Date.now(),
          messageId,
        });
      }

      // Newest first: a posting from yesterday is worth more than one from
      // last week, and only a handful are ever drafted.
      shortlist.sort((a, b) => b.at - a.at);

      for (const item of shortlist) {
        if (candidates.length >= limit) break;

        const { content } = await client.download(String(item.uid), undefined, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of content) chunks.push(chunk as Buffer);
        const text = withoutQuotedReply(extractPlainText(Buffer.concat(chunks).toString("utf8")));

        const verdict = looksLikeJobPosting({ from: item.from, subject: item.subject, text });
        if (!verdict.ok) continue;

        candidates.push({ ...item, text: text.slice(0, 6000) });
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* already closed */
    }
    throw err;
  }

  return { candidates, scanned };
}

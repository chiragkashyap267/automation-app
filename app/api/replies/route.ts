import { NextResponse } from "next/server";
import { ImapFlow } from "imapflow";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Checks the inbox for answers to mail this app sent.
 *
 * A Gmail App Password works for IMAP as well as SMTP, so the credential the
 * user already gave for sending is enough — nothing new to set up.
 *
 * Matching runs in three passes, strongest first:
 *   1. In-Reply-To / References carrying one of our Message-IDs — a real thread.
 *   2. A message from an address we wrote to, after we wrote to it. Applicant
 *      tracking systems routinely reply without threading headers.
 *   3. Mail from the postmaster whose body quotes one of our Message-IDs or
 *      recipient addresses — a bounce.
 */

type SentItem = {
  id: string;
  messageId: string;
  to: string[];
  sentAt: number;
};

type Result = {
  id: string;
  reply: "replied" | "auto" | "bounced";
  at: number;
  from: string;
  subject: string;
};

const AUTO_SUBJECT =
  /out of office|automatic reply|auto-?reply|autoresponder|vacation|away from|thank you for (your )?(application|applying)|we have received your application|application received|do not reply/i;

const POSTMASTER = /mailer-daemon|postmaster|no-?reply@.*(google|gmail)/i;
const BOUNCE_SUBJECT =
  /delivery status notification|undeliverable|undelivered mail|returned to sender|delivery has failed|address not found/i;

/** Only the headers we actually need, to keep the fetch small. */
const WANTED_HEADERS = ["in-reply-to", "references", "auto-submitted", "precedence", "x-autoreply"];

function parseHeaders(raw: unknown): Record<string, string> {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  const out: Record<string, string> = {};
  // Unfold continuation lines before splitting on the first colon.
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

function normalizeId(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

export async function POST(request: Request) {
  let body: { profile?: { gmailUser?: string; gmailAppPassword?: string }; items?: SentItem[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const user = body.profile?.gmailUser?.trim() ?? "";
  const pass = body.profile?.gmailAppPassword?.replace(/\s+/g, "") ?? "";
  const items = (body.items ?? []).filter((i) => i.messageId || i.to?.length);

  if (!user || !pass) {
    return NextResponse.json(
      { error: "Add your Gmail address and App Password in Details first." },
      { status: 400 },
    );
  }
  if (!items.length) return NextResponse.json({ results: [], scanned: 0 });

  // Index what we sent, so an incoming message can be matched cheaply.
  const byMessageId = new Map<string, SentItem>();
  const byRecipient = new Map<string, SentItem[]>();
  for (const item of items) {
    if (item.messageId) byMessageId.set(normalizeId(item.messageId), item);
    for (const address of item.to ?? []) {
      const key = address.toLowerCase().trim();
      const list = byRecipient.get(key);
      if (list) list.push(item);
      else byRecipient.set(key, [item]);
    }
  }

  const earliest = Math.min(...items.map((i) => i.sentAt));
  // A day of slack absorbs clock skew between this machine and Gmail.
  const since = new Date(earliest - 24 * 60 * 60 * 1000);

  const results = new Map<string, Result>();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let scanned = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      for await (const message of client.fetch(
        { since },
        { envelope: true, headers: WANTED_HEADERS, uid: true },
      )) {
        scanned += 1;

        const envelope = message.envelope;
        if (!envelope) continue;

        const from = envelope.from?.[0]?.address?.toLowerCase() ?? "";
        const subject = envelope.subject ?? "";
        const at = envelope.date ? new Date(envelope.date).getTime() : Date.now();
        const headers = parseHeaders(message.headers);

        const isAuto =
          AUTO_SUBJECT.test(subject) ||
          (headers["auto-submitted"] && headers["auto-submitted"] !== "no") ||
          headers["precedence"] === "auto_reply" ||
          Boolean(headers["x-autoreply"]);

        // 1. Threaded reply.
        const referenced = `${headers["in-reply-to"] ?? ""} ${headers["references"] ?? ""}`
          .split(/\s+/)
          .map(normalizeId)
          .filter(Boolean);

        let matched: SentItem | undefined;
        for (const ref of referenced) {
          const hit = byMessageId.get(ref);
          if (hit) {
            matched = hit;
            break;
          }
        }

        // 2. Same person writing back without threading.
        if (!matched && from) {
          const candidates = byRecipient.get(from) ?? [];
          matched = candidates
            .filter((c) => at >= c.sentAt - 60_000)
            .sort((a, b) => b.sentAt - a.sentAt)[0];
        }

        if (matched) {
          const existing = results.get(matched.id);
          // A genuine reply outranks an autoresponder for the same thread.
          if (!existing || (existing.reply === "auto" && !isAuto)) {
            results.set(matched.id, {
              id: matched.id,
              reply: isAuto ? "auto" : "replied",
              at,
              from,
              subject,
            });
          }
          continue;
        }

        // 3. Bounce — the postmaster quotes the original inside the body.
        if (POSTMASTER.test(from) && BOUNCE_SUBJECT.test(subject)) {
          const { content } = await client.download(String(message.uid), undefined, { uid: true });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          const source = Buffer.concat(chunks).toString("utf8").toLowerCase();

          for (const item of items) {
            const quoted =
              (item.messageId && source.includes(normalizeId(item.messageId))) ||
              (item.to ?? []).some((address) => source.includes(address.toLowerCase()));

            if (quoted && !results.has(item.id)) {
              results.set(item.id, { id: item.id, reply: "bounced", at, from, subject });
            }
          }
        }
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

    const raw = err instanceof Error ? err.message : String(err);
    console.error("[replies]", raw);

    let message = raw;
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(raw)) {
      message =
        "Gmail rejected the login for IMAP. The same 16-character App Password that sends mail should work — check it is entered correctly.";
    } else if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
      message = "Could not reach Gmail's IMAP server. Check the connection and retry.";
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ results: [...results.values()], scanned });
}

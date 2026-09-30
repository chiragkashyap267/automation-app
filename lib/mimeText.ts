/**
 * Pulling readable text out of a raw email.
 *
 * Only as much MIME handling as real mail actually needs: a plain part if
 * there is one, the HTML stripped down if there is not, and the two transfer
 * encodings anyone still uses. A full parser would be a dependency and a
 * surface; this is a few rules that degrade to "something readable".
 */

const NL = String.fromCharCode(10);

function decodeQuotedPrintable(body: string): string {
  return body
    // A trailing "=" is a soft line break and the newline is not real.
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(body: string): string {
  try {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return body;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, NL)
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, NL)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

type Part = { headers: string; body: string };

/** Splits a message into its header block and everything after it. */
function splitOnce(raw: string): Part {
  const blank = raw.search(/\r?\n\r?\n/);
  if (blank === -1) return { headers: raw, body: "" };
  return { headers: raw.slice(0, blank), body: raw.slice(raw.slice(blank).search(/\S/) + blank) };
}

function headerValue(headers: string, name: string): string {
  const target = `${name.toLowerCase()}:`;
  // Continuation lines are folded in first, so a wrapped Content-Type with
  // its boundary on the second line is still one value.
  for (const line of headers.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    if (line.toLowerCase().startsWith(target)) return line.slice(target.length).trim();
  }
  return "";
}

function decodeBody(headers: string, body: string): string {
  const encoding = headerValue(headers, "content-transfer-encoding").toLowerCase();
  if (encoding.includes("quoted-printable")) return decodeQuotedPrintable(body);
  if (encoding.includes("base64")) return decodeBase64(body);
  return body;
}

/**
 * The readable text of a message. Prefers text/plain; falls back to the HTML
 * part with its markup removed.
 */
export function extractPlainText(raw: string): string {
  const { headers, body } = splitOnce(raw);
  const rawContentType = headerValue(headers, "content-type");
  const contentType = rawContentType.toLowerCase();

  // Read the boundary off the unlowercased value: boundaries are
  // case-sensitive, and folding the case makes --XYZ stop matching itself.
  const boundary = rawContentType.match(/boundary="?([^";\s]+)"?/i)?.[1];
  if (boundary) {
    // A plain split: MIME boundaries are restricted to characters that
    // carry no regular-expression meaning, so escaping is not needed.
    const chunks = body.split("--" + boundary);
    let html = "";

    for (const chunk of chunks) {
      const trimmed = chunk.replace(/^\r?\n/, "");
      if (!trimmed.trim() || trimmed.startsWith("--")) continue;

      const part = splitOnce(trimmed);
      const type = headerValue(part.headers, "content-type").toLowerCase();
      const text = decodeBody(part.headers, part.body);

      // A nested multipart (alternative inside mixed) is handled by recursing.
      if (type.includes("multipart/")) {
        const inner = extractPlainText(trimmed);
        if (inner.trim()) return inner;
        continue;
      }
      if (type.includes("text/plain")) return tidy(text);
      if (type.includes("text/html") && !html) html = text;
    }

    if (html) return tidy(stripHtml(html));
    return "";
  }

  const decoded = decodeBody(headers, body);
  return tidy(contentType.includes("text/html") ? stripHtml(decoded) : decoded);
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, NL)
    .replace(/\n{3,}/g, NL + NL)
    .trim();
}

/**
 * Drops the quoted history below a reply marker, so a long thread does not
 * cost tokens or confuse a reader with last week's message.
 */
export function withoutQuotedReply(text: string): string {
  const markers = [
    /^On .{5,80}wrote:$/im,
    /^-+ ?Original Message ?-+$/im,
    /^_{10,}$/m,
    /^From: .+$/im,
  ];

  let cut = text.length;
  for (const marker of markers) {
    const at = text.search(marker);
    if (at > 0 && at < cut) cut = at;
  }
  return text.slice(0, cut).trim();
}

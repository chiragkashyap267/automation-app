/**
 * Reading a LinkedIn job link without being logged in.
 *
 * This was ruled out earlier in the project on the grounds that LinkedIn
 * hides everything from logged-out visitors. That is true of feed posts,
 * and it is where the belief came from — but it is not true of job
 * listings. LinkedIn serves those to anyone, because it wants them in
 * search results, through the same guest endpoint its own public job page
 * calls:
 *
 *   /jobs-guest/jobs/api/jobPosting/{id}
 *
 * Nothing here signs in, sends a cookie, or touches an account. It asks
 * for a public page the way a search engine does, which is why it cannot
 * put the LinkedIn account at risk — the thing that matters most here.
 */

/** Matched against what the share sheet actually hands over. */
const JOB_URL =
  /(?:^|\/\/|\.)(?:[a-z0-9-]+\.)*linkedin\.com\/(?:jobs\/view|jobs-guest\/jobs\/api\/jobPosting)\/(?:[^/?#]*?-)?(\d{6,})/i;

/** LinkedIn's own shortener, which has to be followed before anything else. */
const SHORT_URL = /(?:^|\/\/)(?:lnkd\.in|linkedin\.com\/slink)\/\S+/i;

/** A feed post, which really is gated. Worth telling them apart. */
const FEED_URL = /linkedin\.com\/(?:posts|feed|pulse)\//i;

export type LinkedInJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  /** The posting body, as plain text. */
  description: string;
  /** Addresses written into the posting, which is how you apply by mail. */
  emails: string[];
  url: string;
};

export function linkedInJobId(url: string): string | null {
  return JOB_URL.exec(url ?? "")?.[1] ?? null;
}

export function isShortLink(url: string): boolean {
  return SHORT_URL.test(url ?? "");
}

export function isFeedPost(url: string): boolean {
  return FEED_URL.test(url ?? "") && !linkedInJobId(url ?? "");
}

/** Strips tags and collapses the whitespace LinkedIn leaves everywhere. */
export function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First element whose class contains `name`, with its nesting respected. */
export function extractByClass(html: string, name: string): string | null {
  const open = new RegExp(`<(\\w+)[^>]*class="[^"]*${name}[^"]*"[^>]*>`, "i");
  const found = open.exec(html);
  if (!found) return null;

  const tag = found[1].toLowerCase();
  // Self-closing, or a void element: nothing is inside it.
  if (found[0].endsWith("/>")) return "";

  const start = found.index + found[0].length;
  const step = new RegExp(`<(/)?${tag}\\b[^>]*>`, "gi");
  step.lastIndex = start;

  let depth = 1;
  for (let m = step.exec(html); m; m = step.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  // Unbalanced markup: take the rest rather than nothing.
  return html.slice(start);
}

/** Everything useful out of one guest-endpoint response. */
export function parseGuestJob(html: string, id: string, url: string): LinkedInJob | null {
  const text = (name: string) => {
    const raw = extractByClass(html, name);
    return raw === null ? "" : toPlainText(raw);
  };

  const title = text("topcard__title");
  const company = text("topcard__org-name-link");
  const body = text("show-more-less-html__markup");

  // Three things wear a "flavor" class: the company, the location and the
  // posted date. Only the location is a bullet, and taking the last one
  // instead picked up "2 months ago" as the place of work.
  const location = text("topcard__flavor--bullet");

  if (!title && !body) return null;

  const emails = [...new Set(body.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])].filter(
    // LinkedIn's own addresses are not the employer's.
    (e) => !/linkedin\.com$/i.test(e),
  );

  return { id, title, company, location, description: body, emails, url };
}

/**
 * The text to hand the reader, shaped like a posting someone pasted in.
 *
 * Deliberately plain: the rest of the pipeline is already good at reading
 * a job description, and the less this invents, the better it does.
 */
export function asPostingText(job: LinkedInJob): string {
  return [
    job.title,
    job.company ? `Company: ${job.company}` : "",
    job.location ? `Location: ${job.location}` : "",
    "",
    job.description,
    job.emails.length ? `\nContact: ${job.emails.join(", ")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** Follows a shortened link far enough to find the job id behind it. */
async function resolve(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(12_000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

/** Null when the link is not a readable job, for any reason. */
export async function fetchLinkedInJob(rawUrl: string): Promise<LinkedInJob | null> {
  let url = (rawUrl ?? "").trim();
  if (isShortLink(url)) url = await resolve(url);

  const id = linkedInJobId(url);
  if (!id) return null;

  try {
    const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return parseGuestJob(await res.text(), id, url);
  } catch {
    return null;
  }
}

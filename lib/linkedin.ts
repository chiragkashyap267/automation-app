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

/**
 * A feed post — the "we are hiring, send your CV to…" kind.
 *
 * Also readable, through the endpoint LinkedIn provides so posts can be
 * embedded in other people's web pages. The activity id is already in the
 * URL the share sheet produces, which is the whole trick.
 */
const FEED_URL = /linkedin\.com\/(?:posts|feed|pulse)\//i;

/** "…-activity-7131590082221752320-9C4_" or "urn:li:activity:7131…". */
const ACTIVITY_ID = /(?:activity[-:]|ugcPost[-:]|share[-:])(\d{15,})/i;

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

export function linkedInActivityId(url: string): string | null {
  if (linkedInJobId(url ?? "")) return null; // a job, not a post
  return ACTIVITY_ID.exec(url ?? "")?.[1] ?? null;
}

export function isFeedPost(url: string): boolean {
  return FEED_URL.test(url ?? "") && !linkedInJobId(url ?? "");
}

/** Any LinkedIn link this can do something with. */
export function isReadableLinkedIn(url: string): boolean {
  return Boolean(linkedInJobId(url) || linkedInActivityId(url) || isShortLink(url));
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

/** One `<meta property="og:x" content="…">` value. */
export function ogTag(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta[^>]*(?:property|name)="${property}"[^>]*content="([^"]*)"`,
    "i",
  );
  const found = pattern.exec(html)?.[1];
  return found ? toPlainText(found) : "";
}

/**
 * Everything useful out of one embedded post.
 *
 * The embed has no element naming the author, but og:title spells it
 * "First line of the post | Author Name | 37 comments", so the author is
 * the middle of three.
 */
export function parseEmbeddedPost(html: string, id: string, url: string): LinkedInPost | null {
  const body = extractByClass(html, "attributed-text-segment-list__content");
  const text = body === null ? "" : toPlainText(body);
  if (!text) return null;

  const parts = ogTag(html, "og:title")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  const author =
    parts.length >= 2
      ? // Some posts read "Aya Waled posted on the topic …"; the name is
        // what comes before that, not the whole sentence.
        parts[parts.length - 2].replace(/\s+(posted|shared|commented)\b.*$/i, "").trim()
      : "";

  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])].filter(
    (e) => !/linkedin\.com$/i.test(e),
  );

  return { id, author, text, emails, url };
}

export type LinkedInPost = {
  id: string;
  author: string;
  text: string;
  emails: string[];
  url: string;
};

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

/**
 * A feed post, through LinkedIn's own embed endpoint.
 *
 * That endpoint exists so a post can be shown on someone else's website,
 * which means it has to work for a reader who is not signed in. Same
 * reasoning as the job listing: public by design, no account involved.
 */
export async function fetchLinkedInPost(rawUrl: string): Promise<LinkedInPost | null> {
  let url = (rawUrl ?? "").trim();
  if (isShortLink(url)) url = await resolve(url);

  const id = linkedInActivityId(url);
  if (!id) return null;

  try {
    const res = await fetch(
      `https://www.linkedin.com/embed/feed/update/urn:li:activity:${id}`,
      { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    return parseEmbeddedPost(await res.text(), id, url);
  } catch {
    return null;
  }
}

/** What a shared LinkedIn link turned out to be. */
export type LinkedInContent =
  | { kind: "job"; job: LinkedInJob }
  | { kind: "post"; post: LinkedInPost };

/**
 * Reads whatever kind of LinkedIn link was shared.
 *
 * A short link could be either, so it is resolved once here and the real
 * URL decides, rather than each caller guessing.
 */
export async function readLinkedIn(rawUrl: string): Promise<LinkedInContent | null> {
  let url = (rawUrl ?? "").trim();
  if (isShortLink(url)) url = await resolve(url);

  if (linkedInJobId(url)) {
    const job = await fetchLinkedInJob(url);
    return job ? { kind: "job", job } : null;
  }
  if (linkedInActivityId(url)) {
    const post = await fetchLinkedInPost(url);
    return post ? { kind: "post", post } : null;
  }
  return null;
}

/** The post, shaped the way a pasted job description would arrive. */
export function postAsText(post: LinkedInPost): string {
  return [post.author ? `Posted by ${post.author} on LinkedIn` : "", "", post.text]
    .filter((line) => line !== "")
    .join("\n")
    .trim();
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

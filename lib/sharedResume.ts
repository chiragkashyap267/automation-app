import { kvConfigured, kvGet, kvSet } from "./kv";

/**
 * The resume file, shared with the bot.
 *
 * The profile mirror deliberately strips credentials, and the uploaded PDF
 * was stripped along with them — so a new resume uploaded in the web app
 * reached the web app's own sending path and nowhere else, while the bot
 * went on attaching whatever RESUME_URL pointed at. Mail sent from a phone
 * carried the old resume indefinitely, which is the kind of thing nobody
 * notices until a recruiter replies about the wrong skills.
 *
 * Kept under its own key rather than inside the profile blob: the profile
 * is written on a two-second debounce while someone types, and a few
 * hundred kilobytes of base64 does not belong in that.
 */

const KEY = "resume:v1";
const TTL = 365 * 24 * 60 * 60;

/**
 * Upstash's REST interface takes the whole command in one request body, so
 * an enormous file fails the request rather than the write. Refusing early
 * with a reason beats a silent miss; a resume this size is also a resume
 * no recruiter wants.
 */
const MAX_BASE64 = 900_000; // roughly a 650 KB PDF

export type SharedResume = {
  /** base64, no data: prefix. */
  data: string;
  filename: string;
  contentType: string;
  /** Epoch ms. Doubles as the cache key for anything that holds the file. */
  savedAt: number;
};

export type SaveResult = { ok: true } | { ok: false; reason: string };

export function sharedResumeAvailable(): boolean {
  return kvConfigured();
}

export async function saveSharedResume(
  data: string,
  filename: string,
  contentType: string,
): Promise<SaveResult> {
  if (!kvConfigured()) return { ok: false, reason: "no-store" };
  if (!data) return { ok: false, reason: "empty" };

  if (data.length > MAX_BASE64) {
    return {
      ok: false,
      reason: `that file is about ${Math.round((data.length * 3) / 4 / 1024)} KB, and the limit is 650 KB`,
    };
  }

  const record: SharedResume = {
    data,
    filename: filename || "resume.pdf",
    contentType: contentType || "application/pdf",
    savedAt: Date.now(),
  };

  return (await kvSet(KEY, record, TTL)) ? { ok: true } : { ok: false, reason: "store-failed" };
}

export async function loadSharedResume(): Promise<SharedResume | null> {
  if (!kvConfigured()) return null;
  const found = await kvGet<SharedResume>(KEY);
  // A record written by an older shape, or a half-written one, is no use.
  return found?.data ? found : null;
}

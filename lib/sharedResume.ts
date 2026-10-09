import { cloudinaryConfigured, destroyResume, uploadResume } from "./cloudinary";
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
 *
 * Two places the bytes can live. With Cloudinary configured they go there
 * and this key holds a pointer; without it they sit here as base64, which
 * works but caps the file at about 650 KB. Readers are handed a Buffer
 * either way and need not care which it was.
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

/**
 * The ceiling once Cloudinary is carrying the bytes.
 *
 * Not Cloudinary's limit — ours. A Vercel function rejects a request body
 * over about 4.5 MB before any of this code runs, so the upload request is
 * the narrow part of the pipe, and base64 inflates a file by a third. The
 * form stops at a 4 MB file for the same reason.
 */
const MAX_BASE64_HOSTED = 5_600_000; // roughly a 4 MB PDF

export type SharedResume = {
  /** base64, no data: prefix. Absent when the bytes live at `url`. */
  data?: string;
  /** Direct URL to the file. Absent when the bytes are inline in `data`. */
  url?: string;
  /** Cloudinary's id for it, so the file this replaces can be deleted. */
  publicId?: string;
  filename: string;
  contentType: string;
  /** Size of the stored file, when the host reported one. */
  bytes?: number;
  /** Epoch ms. Doubles as the cache key for anything that holds the file. */
  savedAt: number;
};

export type SaveResult = { ok: true } | { ok: false; reason: string };

export function sharedResumeAvailable(): boolean {
  return kvConfigured();
}

/** Where a new upload would go, for saying so before one is attempted. */
export function sharedResumeStore(): "cloudinary" | "redis" | "none" {
  if (!kvConfigured()) return "none";
  return cloudinaryConfigured() ? "cloudinary" : "redis";
}

/** The largest file this will currently accept, in bytes of PDF. */
export function sharedResumeLimit(): number {
  const base64 = cloudinaryConfigured() ? MAX_BASE64_HOSTED : MAX_BASE64;
  return Math.round((base64 * 3) / 4);
}

function tooBig(length: number, limit: number): SaveResult {
  const kb = (n: number) => Math.round((n * 3) / 4 / 1024);
  return { ok: false, reason: `that file is about ${kb(length)} KB, and the limit is ${kb(limit)} KB` };
}

export async function saveSharedResume(
  data: string,
  filename: string,
  contentType: string,
): Promise<SaveResult> {
  // The pointer lives in Redis whichever store holds the bytes, so without
  // it there is no way to say which file is the current one.
  if (!kvConfigured()) return { ok: false, reason: "no-store" };
  if (!data) return { ok: false, reason: "empty" };

  const name = filename || "resume.pdf";
  const type = contentType || "application/pdf";
  const previous = await kvGet<SharedResume>(KEY);

  let record: SharedResume;

  if (cloudinaryConfigured()) {
    if (data.length > MAX_BASE64_HOSTED) return tooBig(data.length, MAX_BASE64_HOSTED);

    const up = await uploadResume(data, name, type);
    if (!up.ok) return { ok: false, reason: up.reason };

    record = {
      url: up.url,
      publicId: up.publicId,
      bytes: up.bytes,
      filename: name,
      contentType: type,
      savedAt: Date.now(),
    };
  } else {
    if (data.length > MAX_BASE64) return tooBig(data.length, MAX_BASE64);

    record = {
      data,
      bytes: Math.round((data.length * 3) / 4),
      filename: name,
      contentType: type,
      savedAt: Date.now(),
    };
  }

  if (!(await kvSet(KEY, record, TTL))) return { ok: false, reason: "store-failed" };

  // Only now that the replacement is recorded. The other order risks
  // deleting the old file and then failing to record the new one, which
  // would leave nothing attached at all.
  if (previous?.publicId && previous.publicId !== record.publicId) {
    void destroyResume(previous.publicId);
  }

  return { ok: true };
}

export async function loadSharedResume(): Promise<SharedResume | null> {
  if (!kvConfigured()) return null;
  const found = await kvGet<SharedResume>(KEY);
  // A record written by an older shape, or a half-written one, is no use:
  // it has to say where the bytes are, one way or the other.
  return found && (found.data || found.url) ? found : null;
}

export type BytesResult = { ok: true; content: Buffer } | { ok: false; reason: string };

/**
 * The actual file, wherever it is kept.
 *
 * Failure is reported rather than swallowed. Quietly falling back to
 * RESUME_URL would attach a resume the person thought they had replaced,
 * and the whole point of this module is that the newest one wins.
 */
export async function sharedResumeBytes(record: SharedResume): Promise<BytesResult> {
  if (record.data) return { ok: true, content: Buffer.from(record.data, "base64") };
  if (!record.url) return { ok: false, reason: "the stored resume has no file" };

  let content: Buffer;
  try {
    const res = await fetch(record.url, { redirect: "follow", cache: "no-store" });
    if (!res.ok) {
      return { ok: false, reason: `the uploaded resume could not be downloaded (${res.status})` };
    }
    content = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: "the uploaded resume could not be downloaded" };
  }

  // A deleted or misconfigured file answers with a page, and 86 KB of HTML
  // attached as resume.pdf simply will not open.
  if (/pdf/i.test(record.contentType) && content.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, reason: "the uploaded resume did not come back as a PDF" };
  }

  return { ok: true, content };
}

import { describeResumeChoice, pickResumeUrl, resumeFileNameFor } from "./resume";
import { loadSharedResume } from "./sharedResume";

/**
 * Downloading the resume that goes with an application.
 *
 * Shared by the bot and by the scheduled morning send, which would otherwise
 * post mail with no attachment at all — the email says a resume is attached,
 * so one that arrives without it contradicts itself.
 */

export { describeResumeChoice };

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

export type ResumeResult =
  | { ok: true; attachment: { filename: string; content: Buffer; contentType: string } }
  | { ok: false; reason: string };

/** One download per URL per invocation, however many drafts want it. */
const resumeCache = new Map<string, ResumeResult>();

export function cache(url: string, result: ResumeResult): ResumeResult {
  resumeCache.set(url, result);
  return result;
}

/** Falls back to RESUME_FILENAME when there is no name or role to use. */
export function resumeNameFor(fullName: string, role: string): string {
  return resumeFileNameFor(fullName, role, resumeFilename());
}

/**
 * The resume for a given role.
 *
 * RESUME_URL_QA and friends let a QA application carry the QA resume; the
 * plain RESUME_URL covers everything else. The file is named for the person
 * and the role, because "resume.pdf" is unfindable in a recruiter's folder.
 */
export async function fetchResume(role = "", fullName = ""): Promise<ResumeResult | null> {
  // A role-specific RESUME_URL_<KEYWORD> is a deliberate choice for this
  // kind of application, so it outranks everything. Otherwise the file
  // uploaded in the web app wins: it is the one that was changed most
  // recently, and by hand.
  if (!describeResumeChoice(role)) {
    const uploaded = await loadSharedResume();
    if (uploaded) {
      // Keyed on savedAt, so uploading a new one is picked up at once
      // rather than after this warm instance happens to be recycled.
      const key = `uploaded:${uploaded.savedAt}`;
      const held = resumeCache.get(key);
      if (held?.ok) {
        return { ok: true, attachment: { ...held.attachment, filename: resumeNameFor(fullName, role) } };
      }
      return cache(key, {
        ok: true,
        attachment: {
          filename: resumeNameFor(fullName, role),
          content: Buffer.from(uploaded.data, "base64"),
          contentType: uploaded.contentType,
        },
      });
    }
  }

  const configured = pickResumeUrl(role);
  if (!configured) return null;

  const cached = resumeCache.get(configured);
  if (cached) {
    return cached.ok
      ? { ok: true, attachment: { ...cached.attachment, filename: resumeNameFor(fullName, role) } }
      : cached;
  }

  const url = resolveResumeUrl(configured);

  let buffer: Buffer;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return cache(configured, { ok: false, reason: `the resume URL returned ${res.status}` });
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    return cache(configured, { ok: false, reason: "the resume URL could not be reached" });
  }

  // Trust the bytes, not the URL or the content-type header.
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return cache(configured, {
      ok: false,
      reason:
        "that link returns a web page, not a PDF. Use the file's direct-download link, and make sure it is shared with 'Anyone with the link'",
    });
  }

  return cache(configured, {
    ok: true,
    attachment: {
      filename: resumeNameFor(fullName, role),
      content: buffer,
      contentType: "application/pdf",
    },
  });
}

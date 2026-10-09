import { createHash, randomBytes } from "node:crypto";

/**
 * Resume storage on Cloudinary.
 *
 * Redis held the uploaded PDF as base64, which worked but capped the file at
 * roughly 650 KB: Upstash's REST interface carries the whole command in one
 * request body, so a larger file failed the request rather than the write.
 * A resume with a bit of design in it passes that cap easily.
 *
 * With Cloudinary configured the bytes go there and Redis keeps only a
 * pointer — the URL, the name, and the id needed to delete the one it
 * replaces. The cap becomes the upload request itself rather than the store.
 *
 * Uploads are signed server-side, so the API secret never reaches a browser
 * and no unsigned upload preset has to exist on the account.
 */

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Where resumes live on the account, e.g. "jdmailer/resumes". */
  folder: string;
};

const DEFAULT_FOLDER = "jdmailer/resumes";

/**
 * Raw, not image.
 *
 * Cloudinary treats a PDF as an image it can rasterise, and new accounts
 * ship with PDF delivery blocked for that resource type — the upload
 * succeeds and the URL then returns 401, which is a miserable thing to
 * debug. `raw` stores and returns the exact bytes, with no transformation
 * pipeline and no such setting in the way.
 */
const RESOURCE_TYPE = "raw";

/**
 * Reads the config from either shape.
 *
 * Cloudinary's own dashboard hands out a single CLOUDINARY_URL, and every
 * other provider in this project uses separate variables; both are accepted
 * so neither has to be translated by hand.
 */
export function cloudinaryConfig(): CloudinaryConfig | null {
  const folder = (process.env.CLOUDINARY_FOLDER || DEFAULT_FOLDER).trim().replace(/^\/+|\/+$/g, "");

  const url = process.env.CLOUDINARY_URL?.trim();
  if (url) {
    const parsed = url.match(/^cloudinary:\/\/([^:@/]+):([^@/]+)@([^/?#]+)/);
    if (parsed) {
      return { apiKey: parsed[1], apiSecret: parsed[2], cloudName: parsed[3], folder };
    }
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (cloudName && apiKey && apiSecret) return { cloudName, apiKey, apiSecret, folder };

  return null;
}

export function cloudinaryConfigured(): boolean {
  return cloudinaryConfig() !== null;
}

/**
 * The string Cloudinary signs: every parameter except the file and the
 * credentials, sorted by name, joined as a query string.
 *
 * Split out from the hashing because this is the part that goes wrong. Get
 * the order or the exclusions wrong and the account returns 401 with
 * nothing to say about which parameter was at fault.
 */
export function signatureBase(params: Record<string, string | number>): string {
  const skip = new Set(["file", "cloud_name", "resource_type", "api_key", "signature"]);
  return Object.keys(params)
    .filter((key) => !skip.has(key) && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export function signParams(params: Record<string, string | number>, apiSecret: string): string {
  return createHash("sha1").update(signatureBase(params) + apiSecret).digest("hex");
}

/**
 * A public id that cannot be guessed.
 *
 * A raw Cloudinary URL is readable by anyone who has it, and a resume is a
 * phone number and an address. A fixed name under a known folder would be
 * enumerable, so the id carries random bytes. The extension is part of the
 * id for raw files — without it the URL has none, and a mail client is left
 * guessing what it just downloaded.
 */
export function resumePublicId(filename: string, folder: string): string {
  const match = filename.match(/\.([a-z0-9]{1,5})$/i);
  const extension = (match ? match[1] : "pdf").toLowerCase();
  const stem =
    filename
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "resume";

  return `${folder ? `${folder}/` : ""}${stem}-${randomBytes(6).toString("hex")}.${extension}`;
}

export type UploadResult =
  | { ok: true; url: string; publicId: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Sends the file up and hands back where it landed.
 *
 * Never throws: a storage outage should degrade to a reason the form can
 * show, not a 500 on a page someone is in the middle of filling in.
 */
export async function uploadResume(
  data: string,
  filename: string,
  contentType: string,
): Promise<UploadResult> {
  const config = cloudinaryConfig();
  if (!config) return { ok: false, reason: "Cloudinary is not configured" };
  if (!data) return { ok: false, reason: "empty" };

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = resumePublicId(filename || "resume.pdf", config.folder);
  const signed = { public_id: publicId, timestamp };

  const form = new FormData();
  // Cloudinary accepts a data URI in place of a file part, which saves
  // decoding the base64 only to re-encode it as multipart.
  form.append("file", `data:${contentType || "application/pdf"};base64,${data}`);
  form.append("api_key", config.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", signParams(signed, config.apiSecret));

  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudinary.com/v1_1/${config.cloudName}/${RESOURCE_TYPE}/upload`,
      { method: "POST", body: form, cache: "no-store" },
    );
  } catch {
    return { ok: false, reason: "Cloudinary could not be reached" };
  }

  let body: { secure_url?: string; public_id?: string; bytes?: number; error?: { message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: `Cloudinary returned ${res.status}` };
  }

  if (!res.ok || !body.secure_url) {
    const said = body.error?.message?.slice(0, 160);
    console.error("[cloudinary]", res.status, said ?? "no message");
    return { ok: false, reason: said || `Cloudinary returned ${res.status}` };
  }

  return {
    ok: true,
    url: body.secure_url,
    publicId: body.public_id ?? publicId,
    bytes: body.bytes ?? 0,
  };
}

/**
 * Removes a file the account no longer needs.
 *
 * Called after the replacement is safely recorded, so a failure here costs
 * an orphaned file rather than the resume someone just uploaded.
 */
export async function destroyResume(publicId: string): Promise<boolean> {
  const config = cloudinaryConfig();
  if (!config || !publicId) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("api_key", config.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", signParams({ public_id: publicId, timestamp }, config.apiSecret));

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${config.cloudName}/${RESOURCE_TYPE}/destroy`,
      { method: "POST", body: form, cache: "no-store" },
    );
    const body = (await res.json()) as { result?: string };
    return body.result === "ok" || body.result === "not found";
  } catch {
    return false;
  }
}

/**
 * The other half of the business: freelance work, not job applications.
 *
 * Kept as its own profile rather than more fields on the job one, because
 * almost nothing carries over. A pitch sells a service to a business; an
 * application sells a person to an employer. They want different facts,
 * different proof and a different tone, and mixing them produces an email
 * that reads like neither.
 */

export type ServicesProfile = {
  /** Trading name, or just the person's name. */
  businessName: string;
  fullName: string;
  /** One line: what you do, for whom. */
  tagline: string;
  /** Comma separated, e.g. "packaging design, websites, motion graphics". */
  services: string;
  city: string;
  portfolio: string;
  showreel: string;
  /**
   * Real past work. The only thing a pitch may claim — the same rule the
   * resume plays for applications.
   */
  proof: string;
  /** Optional, e.g. "logo and label from Rs 8,000". */
  startingPrice: string;
  email: string;
  phone: string;
  /** Shown as "reply on WhatsApp" when set. */
  whatsapp: string;
  tone: "warm" | "formal" | "direct";
  signOff: string;
};

export const EMPTY_SERVICES: ServicesProfile = {
  businessName: "",
  fullName: "",
  tagline: "",
  services: "",
  city: "",
  portfolio: "",
  showreel: "",
  proof: "",
  startingPrice: "",
  email: "",
  phone: "",
  whatsapp: "",
  tone: "warm",
  signOff: "Best regards",
};

/** Enough to write a pitch that is not vague. */
export function servicesReady(p: ServicesProfile): boolean {
  return Boolean(p.fullName.trim() && p.services.trim() && (p.proof.trim() || p.portfolio.trim()));
}

/** What the pitch is allowed to draw on, as one lowercase haystack. */
export function servicesCorpus(p: ServicesProfile): string {
  return [p.tagline, p.services, p.proof, p.portfolio, p.showreel, p.businessName]
    .join(" ")
    .toLowerCase();
}

export type Lead = {
  email: string;
  /** Who they are, if known. */
  company: string;
  contactName: string;
  /** What they appear to need, in the user's or the posting's words. */
  need: string;
  /** Where the lead came from, e.g. "OLX", "IndiaMART", "referral". */
  source: string;
};

import { companyFromEmail } from "./email";

const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i;

/**
 * Turns "/pitch hr@brand.com they need packaging for a new snack range"
 * into a lead — and copes with a whole posting pasted after the command,
 * which is how a lead usually arrives.
 */
export function parseLead(text: string, source = ""): Lead | null {
  const stripped = text.replace(/^\/pitch(?:@\w+)?\s*/i, "").trim();
  if (!stripped) return null;

  const email = stripped.match(EMAIL)?.[0]?.toLowerCase();
  if (!email) return null;

  // Whatever is left once the address is removed describes the work.
  const need = stripped.replace(email, " ").replace(/\s+/g, " ").trim();

  return {
    email,
    company: companyFromEmail(email),
    contactName: "",
    need,
    source,
  };
}

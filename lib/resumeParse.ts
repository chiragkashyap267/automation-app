import { z } from "zod";
import type { Profile } from "./types";

/**
 * Reading a resume PDF back into the profile.
 *
 * Uploading a new resume used to change only the attachment. The text the
 * emails are actually written from sat untouched in another box, so a new
 * resume produced mail describing the old one — the single easiest way to
 * tell a recruiter something that is no longer true.
 *
 * So the upload now reads the file. What comes back is a draft of the
 * profile, not a replacement for judgement: it is written into the form
 * where it can be read and corrected, and the previous values are kept so
 * one bad parse can be undone.
 */

export const ParsedResumeSchema = z.object({
  fullName: z.string().default(""),
  /** The role this person presents as, e.g. "Full Stack Developer". */
  headline: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  linkedin: z.string().default(""),
  github: z.string().default(""),
  portfolio: z.string().default(""),
  /** Digits only where possible: "2", not "2+ years". */
  yearsExperience: z.string().default(""),
  /** Comma separated, in the resume's own words. */
  skills: z.string().default(""),
  /** The whole resume as plain text, which is what the writer reads. */
  resumeText: z.string().default(""),
});

export type ParsedResume = z.infer<typeof ParsedResumeSchema>;

/** The fields a resume can speak for. Nothing else is touched. */
export const RESUME_FIELDS = [
  "fullName",
  "headline",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
  "yearsExperience",
  "skills",
  "resumeText",
] as const satisfies readonly (keyof Profile)[];

export type ResumeField = (typeof RESUME_FIELDS)[number];

export const RESUME_SYSTEM_PROMPT = `You are reading a candidate's resume PDF and filling in their profile.

Rules:
- Copy what the resume says. Do not improve it, summarise it or infer anything it does not state.
- skills: a comma separated list, in the resume's own words, most relevant first. No headings, no bullets.
- headline: the role the resume presents, e.g. "Full Stack Developer". Not a sentence.
- yearsExperience: a number only, e.g. "2" or "1.5". Work it out from the employment dates if it is not stated outright. Leave it empty if there is no employment history at all.
- linkedin, github, portfolio: the bare domain and path, no https:// and no www.
- resumeText: the entire resume as plain text, keeping its sections and order. This is the most important field — an email is written from it, so nothing may be left out.
- Leave a field as an empty string if the resume genuinely does not say. Never guess, and never carry anything over from another resume.`;

/** Fields the parse actually found something for. */
export function filledFields(parsed: ParsedResume): ResumeField[] {
  return RESUME_FIELDS.filter((field) => parsed[field].trim().length > 0);
}

/**
 * Applies a parse over the current profile.
 *
 * Only fields the resume spoke to are touched, so a resume that omits a
 * portfolio link does not wipe the one already typed in. Everything else —
 * tone, sign-off, Gmail details, the attachment itself — is left alone.
 */
export function applyParsed(profile: Profile, parsed: ParsedResume): Profile {
  const next = { ...profile };
  for (const field of filledFields(parsed)) next[field] = parsed[field].trim();
  return next;
}

/** Which fields a parse would change, for saying so before it is applied. */
export function changedBy(profile: Profile, parsed: ParsedResume): ResumeField[] {
  return filledFields(parsed).filter((field) => parsed[field].trim() !== profile[field].trim());
}

/** Plain-language summary of what was read, for the form to show. */
export function describeParse(parsed: ParsedResume): string {
  const found = filledFields(parsed);
  if (!found.length) return "Nothing could be read from that file.";

  const bits: string[] = [];
  if (parsed.headline) bits.push(parsed.headline);
  if (parsed.yearsExperience) bits.push(`${parsed.yearsExperience} year(s)`);

  const skills = parsed.skills
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (skills.length) bits.push(`${skills.length} skills`);
  if (parsed.resumeText) bits.push(`${parsed.resumeText.length} characters of resume text`);

  return `Read from your resume: ${bits.join(" · ")}. Check it and correct anything wrong.`;
}

import type { Profile } from "./types";

/**
 * Catching a profile that contradicts itself about how long someone has
 * been working.
 *
 * The prompt tells the model the resume is the only source of truth for the
 * candidate's history, which is right — prose beats a stray form field. The
 * consequence is that editing the "Years of experience" box alone changes
 * nothing: if the resume summary still opens "2+ years of experience", every
 * email will keep saying two years, and nothing anywhere says why.
 */

/**
 * Year counts the resume claims as total experience.
 *
 * Only counts phrasings that are about experience overall — "3 years" inside
 * a job's date range is a duration, not a claim about the candidate, and
 * flagging those would make the warning useless.
 */
export function statedYearsIn(text: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)[^.]{0,24}?\bexperience\b/gi,
    /\bexperience\b[^.]{0,24}?(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/gi,
    /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)['’]?\s+(?:of\s+)?(?:professional|industry|hands-on)?\s*experience/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 60) found.add(value);
    }
  }

  return [...found].sort((a, b) => a - b);
}

export type ExperienceCheck = {
  /** What the form field says, if anything. */
  stated: number | null;
  /** What the resume prose claims. */
  inResume: number[];
  mismatch: boolean;
  message: string;
};

export function checkExperience(profile: Profile): ExperienceCheck {
  const raw = profile.yearsExperience?.trim() ?? "";
  const stated = raw ? Number(raw.replace(/[^\d.]/g, "")) : NaN;
  const inResume = statedYearsIn(profile.resumeText ?? "");

  const hasStated = Number.isFinite(stated) && stated > 0;
  if (!hasStated || !inResume.length) {
    return { stated: hasStated ? stated : null, inResume, mismatch: false, message: "" };
  }

  if (inResume.includes(stated)) {
    return { stated, inResume, mismatch: false, message: "" };
  }

  const years = (n: number) => `${n} year${n === 1 ? "" : "s"}`;
  return {
    stated,
    inResume,
    mismatch: true,
    message:
      `Your resume text says ${inResume.map(years).join(" and ")} of experience, but the ` +
      `Years of experience field says ${years(stated)}. Emails follow the resume, so they ` +
      `will keep saying ${years(inResume[0])} until the resume text is edited too.`,
  };
}

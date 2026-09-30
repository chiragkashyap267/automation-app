/**
 * Choosing and naming the resume that goes with an application.
 *
 * "Tailoring" here means picking between resumes the candidate wrote and
 * labelling the file for the role — not having a model rewrite the contents.
 * A model editing claims about someone's own experience is the exact failure
 * this app already guards against everywhere else, and a fabricated line in a
 * resume is far worse than one in an email: it is the document an offer gets
 * checked against.
 *
 * Variants come from the environment as RESUME_URL_<KEYWORD>, so a QA resume
 * lives at RESUME_URL_QA and is used whenever the role mentions QA. The plain
 * RESUME_URL is the fallback.
 */

export type ResumeVariant = { keyword: string; url: string };

export function resumeVariants(env: NodeJS.ProcessEnv = process.env): ResumeVariant[] {
  const found: ResumeVariant[] = [];

  for (const [name, value] of Object.entries(env)) {
    const match = /^RESUME_URL_(.+)$/.exec(name);
    if (!match || !value?.trim()) continue;

    // RESUME_URL_QA matches a QA role; RESUME_URL_DATA_ENGINEER matches a
    // data engineer, with the underscore standing in for the space.
    const keyword = match[1].toLowerCase().replace(/_/g, " ").trim();
    if (keyword) found.push({ keyword, url: value.trim() });
  }

  // Longest first, so "data engineer" wins over "data" for the same role.
  return found.sort((a, b) => b.keyword.length - a.keyword.length);
}

/** The most specific resume that matches this role, or the default. */
export function pickResumeUrl(role: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = role.toLowerCase();
  if (target) {
    for (const variant of resumeVariants(env)) {
      if (target.includes(variant.keyword)) return variant.url;
    }
  }
  return env.RESUME_URL?.trim() ?? "";
}

/** Which variant was chosen, for saying so in chat. */
export function describeResumeChoice(role: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = role.toLowerCase();
  for (const variant of resumeVariants(env)) {
    if (target.includes(variant.keyword)) return variant.keyword;
  }
  return "";
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("-");
}

/**
 * A filename a recruiter can find again.
 *
 * "resume.pdf" arrives in a folder of two hundred files with the same name.
 * The candidate's name and the role they applied for is what makes it
 * findable, and it is the one part of an attachment anyone reads before
 * opening it.
 */
export function resumeFileNameFor(fullName: string, role: string, fallback = "resume.pdf"): string {
  const extension = /\.([A-Za-z0-9]{2,5})$/.exec(fallback)?.[1] ?? "pdf";

  const person = titleCase(fullName.replace(/[^A-Za-z\s-]/g, "").trim());
  // Drop anything a filesystem or a mail client would rather not see.
  const position = titleCase(
    role
      .replace(/[^A-Za-z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40),
  );

  const parts = [person, position].filter(Boolean);
  if (!parts.length) return fallback;

  return `${parts.join("-")}.${extension}`;
}

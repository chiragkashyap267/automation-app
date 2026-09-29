import { z } from "zod";
import type { Profile } from "@/lib/types";

/* ────────────────────────── schemas ────────────────────────── */

export const FactsSchema = z.object({
  company: z.string(),
  role: z.string(),
  location: z.string(),
  reqId: z.string(),
  recipients: z.array(z.string()),
  contactName: z.string(),
  highlights: z.array(z.string()),
  seniority: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

/** Extract stage adds nothing; the full stage adds the written email. */
export const JobSchema = FactsSchema.extend({
  subject: z.string(),
  body: z.string(),
});

export const JobsSchema = z.object({ jobs: z.array(JobSchema) });
export const ExtractSchema = z.object({ jobs: z.array(FactsSchema) });
export const WrittenSchema = z.object({ subject: z.string(), body: z.string() });

export type Facts = z.infer<typeof FactsSchema>;
export type JobsPayload = z.infer<typeof JobsSchema>;
export type Written = z.infer<typeof WrittenSchema>;

/* ──────────────────── provider-facing JSON Schema ──────────────────── */

const FACT_PROPS = {
  company: { type: "string" },
  role: { type: "string" },
  location: { type: "string" },
  reqId: { type: "string" },
  recipients: { type: "array", items: { type: "string" } },
  contactName: { type: "string" },
  highlights: { type: "array", items: { type: "string" } },
  seniority: { type: "string" },
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  notes: { type: "string" },
} as const;

const FACT_REQUIRED = [
  "company",
  "role",
  "location",
  "reqId",
  "recipients",
  "contactName",
  "highlights",
  "seniority",
  "confidence",
  "notes",
];

/**
 * Mirrors the Zod schemas for Gemini's `responseSchema`, which takes the
 * OpenAPI subset — no `additionalProperties`, and `propertyOrdering` to fix
 * field order so the cheap fields are emitted before the expensive prose.
 */
export const GEMINI_FULL_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: { ...FACT_PROPS, subject: { type: "string" }, body: { type: "string" } },
        propertyOrdering: [...FACT_REQUIRED, "subject", "body"],
        required: [...FACT_REQUIRED, "subject", "body"],
      },
    },
  },
  required: ["jobs"],
} as const;

export const GEMINI_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: FACT_PROPS,
        propertyOrdering: FACT_REQUIRED,
        required: FACT_REQUIRED,
      },
    },
  },
  required: ["jobs"],
} as const;

/* ────────────────────────── prompts ────────────────────────── */

const TONE_GUIDE: Record<Profile["tone"], string> = {
  warm: "Warm and human. Sound like a real person who is genuinely interested, not a template.",
  formal: "Professional and restrained. Complete sentences, no contractions, no exclamation marks.",
  direct: "Short and direct. Lead with the match, cut every sentence that is not doing work.",
};

const EXTRACT_RULES = `You read job postings. You receive one or more inputs: screenshots of job posts, and/or pasted job description text. Several inputs may be pages of ONE posting, and one input may contain SEVERAL postings. Decide from the content, and return one entry in "jobs" per distinct posting.

For each posting:
- company, role, location: copy from the posting. Use "" if genuinely absent. Never invent a company name.
- reqId: the requisition or job ID the posting shows, such as "REQ-4471", "JR12345" or "#8891". "" when the posting has none. Never invent one.
- seniority: "intern", "junior", "mid", "senior", "lead" or "" if the posting does not say.
- recipients: every email address in the posting that could receive an application. Read them carefully off screenshots, including obfuscated forms ("name [at] company [dot] com" becomes "name@company.com"). If there is no email address anywhere, return an empty array. An empty array is correct and expected; a guessed address like careers@<company>.com is a serious error.
  Screenshots often place a small envelope or contact icon immediately before an address, and that icon is frequently misread as a letter glued to the front — "Jnaincy.goel@x.com" is really "naincy.goel@x.com", and a stray symbol before "career@x.com" is not part of the address. Drop such a leading character when what remains is a clean name or a normal mailbox like career, hr or jobs. Return addresses in lower case.
- contactName: the named recruiter or hiring manager, but only when the posting writes their name out as text. Do NOT invent a name by reading one out of an email address — a misread character there becomes a misspelling of a real person's name in the greeting. "" when no name is written out.
- highlights: 3-5 short phrases naming the requirements this specific posting actually asks for. Put the most important technology or skill first.
- confidence: "high" when company, role and at least one recipient were read cleanly. "medium" when the posting is clear but there is no email address, or the text was partly unreadable. "low" when you are unsure what the posting even is.
- notes: one short line for the candidate, only when something needs their attention (no email found, unreadable screenshot, posting wants a portfolio link). "" when everything is fine.`;

const WRITE_RULES = `Write the cold application email the candidate will actually send.

- subject: specific and scannable. Name the role, and include the requisition/job ID verbatim when one is given.
- body: plain text, no markdown, no bold, no bullet characters. Paragraphs separated by a blank line.
- LENGTH: 60-90 words. Three short paragraphs at the very most, and two is usually better. This is a hard limit — a recruiter reads it on a phone between meetings. Going over is a failure, not thoroughness.
- The FIRST line is the salutation on its own, followed by a blank line: "Dear <contact name>," when the posting names a contact, otherwise "Dear Hiring Team,". Never run the salutation into the first sentence.
- Line 1 of the email: the role you are applying for, and the requisition/job ID if there is one. One sentence. Never "I hope this email finds you well", never "I am writing to express my keen interest".
- Do not invent where the posting was seen. Write "in your job posting" — never "on your careers page", "on LinkedIn" or similar unless the posting itself says so.
- Then ONE short paragraph of proof: the single strongest match between the candidate's real experience and what THIS posting asks for. Name one or two concrete things — a technology, a project, a number. One specific fact beats three vague ones. Do not list every skill they have.
- Close with one short sentence asking for a call. Nothing after it.
- Cut every sentence that states no fact. "I am confident I can contribute to your goals" and "I believe my skills align with your needs" are filler — delete them rather than rewriting them.

Mention an attached resume ONLY if the profile says one is attached. If it says no file is attached, never write "please find my resume attached" or anything like it.

CRITICAL — do NOT write a sign-off, your name, phone number, email address, or any links at the end. The body must STOP at the closing ask. A signature block with the candidate's contact details and links is appended automatically afterwards. Adding your own would duplicate it.

HARD RULES — these matter more than sounding like a good match.

1. Every factual claim must be traceable to the RESUME text. Before writing a sentence that says the candidate did something, find the words in the resume that say so. If they are not there, you may not write it.

2. NEVER write "At <employer> I <did task>" unless that exact task appears in the resume under that employer. Inventing duties for a real employer is the worst thing you can do here — it is a lie told in the candidate's name to someone who may check.

3. When the posting asks for a kind of work the candidate has NOT done, say so honestly and pivot. Do not manufacture the experience.
   WRONG: "At Acme I wrote manual test cases and logged defects." (when the resume never mentions testing)
   RIGHT: "My background is in full-stack development rather than dedicated QA, but I have debugged and reviewed production code daily, and I am keen to move into testing."
   A candidate who is honestly adjacent is credible. One caught inventing experience is finished.

4. Do not restate the posting's requirements as if they were the candidate's skills. "I have strong analytical and problem-solving abilities" copied from the requirements list is not evidence of anything.

5. Never claim more years of experience than the profile states, and never fewer to seem junior.

6. Never use placeholders such as [Company], [Your Name] or TODO. Every field must be final, sendable text.`;

export const FULL_SYSTEM_PROMPT = `${EXTRACT_RULES}

Then, for each posting, also write the email.

${WRITE_RULES}

If a posting is too unclear to write from, still return the entry, set confidence "low" and say what is missing in notes.`;

export const EXTRACT_SYSTEM_PROMPT = `${EXTRACT_RULES}

Extract only. Do not write any email text.`;

export const WRITE_SYSTEM_PROMPT = `${WRITE_RULES}

You are given the already-extracted facts about ONE posting, plus the candidate profile. Return the subject and body for that one posting.`;

/* ────────────────────────── builders ────────────────────────── */

export function buildProfileBlock(p: Profile): string {
  const lines: [string, string][] = [
    ["Name", p.fullName],
    ["Location", p.location],
    ["Current title / headline", p.headline],
    ["Years of experience", p.yearsExperience],
    ["Skills", p.skills],
    ["Anything else to weave in", p.extraNotes],
  ];

  const facts = lines
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`)
    .join("\n");

  const resume = p.resumeText.trim()
    ? `\n\nRESUME (the only source of truth for the candidate's history):\n${p.resumeText.trim()}`
    : "\n\n(No resume text was provided. Write only from the facts above and do not invent history.)";

  // Whether a file rides along is the app's decision, not the model's guess.
  const attachment = p.resumeFileName.trim()
    ? "\n\nATTACHMENT: a resume file IS attached to this email. You may refer to it once."
    : "\n\nATTACHMENT: no file is attached. Do NOT mention an attached resume or CV.";

  return `CANDIDATE PROFILE\n${facts}${resume}${attachment}\n\nTONE: ${TONE_GUIDE[p.tone]}`;
}

export function buildTaskText(profile: Profile, pastedText: string[]): string {
  const pasted = pastedText.length
    ? pastedText.map((t, i) => `--- pasted job description ${i + 1} ---\n${t}`).join("\n\n")
    : "";

  return [
    buildProfileBlock(profile),
    pasted ? `\n\nPASTED JOB DESCRIPTION TEXT\n${pasted}` : "",
    "\n\nRead every input above (including any attached screenshots) and return the jobs array.",
  ].join("");
}

/** A recruiting address rarely names the company; the domain almost always does. */
export function companyFromEmail(email: string): string {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const generic = /^(gmail|yahoo|outlook|hotmail|protonmail|icloud|rediffmail|zoho)\./;
  if (!domain || generic.test(domain)) return "";

  const label = domain.split(".")[0];
  if (!label || label.length < 2 || /^(mail|jobs|careers|hr|info|apply|contact|recruit)$/.test(label)) {
    return "";
  }
  return label.replace(/[-_]/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export type OutreachTarget = {
  email: string;
  /** What the candidate is asking about, e.g. "Software Engineer". */
  role: string;
  /** Inferred from the address unless the user named it. */
  company: string;
};

export const OUTREACH_SYSTEM_PROMPT = `Write a short cold email asking whether a company has openings. There is NO job posting — the candidate is approaching them speculatively, so do not pretend to be responding to an advertised role.

- subject: short and plain, naming the kind of role. Something like "Software Engineer — open to opportunities" or "Frontend Developer enquiry". Never mention a job ID or a specific vacancy.
- body: plain text, no markdown, no bullet characters. Paragraphs separated by a blank line.
- LENGTH: 50-80 words. Two short paragraphs. Shorter than a normal application, because there is nothing specific to respond to.
- The FIRST line is the salutation on its own, followed by a blank line: "Dear Hiring Team," unless a name is given.
- Line 1: say plainly that you are reaching out to ask whether they have openings for the named kind of role. Do not claim to have seen a posting, a careers page, or a LinkedIn ad — you have not.
- Then ONE short paragraph: who the candidate is and the single strongest reason to talk to them, using a real technology or number from their profile.
- Close by asking to be considered, or pointed to the right person.
- Never invent anything about the company: no praise for products, culture or mission you know nothing about. "I admire your work in fintech" is a lie unless the profile says so.

Mention an attached resume ONLY if the profile says one is attached.

CRITICAL — do NOT write a sign-off, your name, phone, email, or links at the end. The body must STOP at the closing ask. A signature is appended automatically.`;

export const REVISE_SYSTEM_PROMPT = `You are correcting a draft application email that failed a check. Return the corrected subject and body.

Fix ONLY what the problems list says is wrong. Do not restyle, re-order or "improve" anything else — the rest of the email has already been approved.

When a claim is unsupported, you cannot simply soften it. Delete it, or replace it with something the resume actually says. "Helped ensure quality" is the same lie as "wrote test cases" if the resume mentions neither.

Keep every rule of the original: 60-90 words, salutation on its own first line, no sign-off, no name, no links, no markdown, plain text only.`;

export function buildReviseText(
  profile: Profile,
  facts: Facts,
  draft: Written,
  problems: string[],
): string {
  return [
    buildProfileBlock(profile),
    `\n\nTHE POSTING\nCompany: ${facts.company || "(not stated)"}\nRole: ${facts.role || "(not stated)"}`,
    `\n\nTHE DRAFT\nSubject: ${draft.subject}\n\n${draft.body}`,
    `\n\nPROBLEMS TO FIX\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    "\n\nReturn the corrected subject and body.",
  ].join("");
}

export function buildOutreachText(profile: Profile, target: OutreachTarget): string {
  const about = [
    `Sending to: ${target.email}`,
    target.company ? `Company (inferred from the address): ${target.company}` : "Company: unknown",
    `Kind of role being asked about: ${target.role}`,
  ].join("\n");

  return `${buildProfileBlock(profile)}\n\nTHE APPROACH\n${about}\n\nWrite the subject and body for this speculative enquiry.`;
}

export function buildWriteText(profile: Profile, facts: Facts): string {
  const posting = [
    `Company: ${facts.company || "(not stated)"}`,
    `Role: ${facts.role || "(not stated)"}`,
    `Location: ${facts.location || "(not stated)"}`,
    `Requisition ID: ${facts.reqId || "(none given)"}`,
    `Seniority: ${facts.seniority || "(not stated)"}`,
    `Addressed to: ${facts.contactName || "Hiring Team"}`,
    `What the posting asks for: ${facts.highlights.join("; ") || "(not stated)"}`,
  ].join("\n");

  return `${buildProfileBlock(profile)}\n\nTHE POSTING\n${posting}\n\nWrite the subject and body for this one posting.`;
}

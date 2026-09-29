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
- contactName: the named recruiter or hiring manager, if the posting names one. "" otherwise.
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

HARD RULES
- Never state experience, employers, degrees, or numbers that are not in the candidate profile. If the posting demands something the candidate lacks, either leave it out or frame the nearest genuine thing honestly. Do not claim years of experience the profile does not support.
- Never use placeholders such as [Company], [Your Name] or TODO. Every field must be final, sendable text.`;

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

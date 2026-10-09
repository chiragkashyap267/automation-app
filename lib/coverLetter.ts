import { z } from "zod";
import { askGeminiJson } from "./llm/gemini";
import { askGroqJson } from "./llm/groq";
import { geminiPool, groqPool } from "./llm/keyPool";
import type { Profile } from "./types";
import { unsupportedClaimsIn } from "./validate";

/**
 * The box that says "Why do you want to join us?".
 *
 * On a phone this is the whole cost of an application. Fifteen short fields
 * are tedious; a blank 150-word box at the end of them is what makes people
 * close the tab. Everything else on a form is recall — this is the only
 * part that is writing.
 *
 * Deliberately not the email writer. That one produces 60-90 words with no
 * greeting and no sign-off, because it is a body with a subject line above
 * it. This is a letter: it opens, it argues, it closes, and it is read
 * beside a resume rather than in an inbox.
 */

export type CoverContext = {
  company: string;
  role: string;
  /** The posting, when there is one. Specificity comes from here. */
  jd: string;
};

export const COVER_SYSTEM_PROMPT = `You are writing a cover letter for a job application, in the candidate's own voice.

Rules:
- 120 to 180 words. It is read on a phone beside a resume, not studied.
- Use only what the candidate's profile and resume actually say. Never invent an employer, a project, a number or a technology.
- Name the company and the role in the first two sentences.
- Pick the two or three things in their background that genuinely bear on this posting, and say why. No lists of adjectives.
- Plain English. No "I am writing to express my keen interest", no "fast-paced environment", no "passionate about leveraging".
- No greeting line and no sign-off: the form has fields for those, and a letter that opens with "Dear Hiring Manager" pasted into a box that already said who it is to reads badly.
- Never mention salary, notice period or visa status.
- If the posting is thin or missing, write from the role title alone and stay honest rather than guessing what they want.`;

const SHAPE = 'Return a JSON object with exactly one string key: "letter". No other keys.';

export const GEMINI_COVER_SCHEMA = {
  type: "object",
  properties: { letter: { type: "string" } },
  required: ["letter"],
};

const AnswerSchema = z.object({ letter: z.string().default("") });

/** What the model is told about the candidate and the job. */
export function buildCoverText(profile: Profile, context: CoverContext): string {
  const parts = [
    `CANDIDATE: ${profile.fullName || "(not given)"}`,
    profile.headline ? `PRESENTS AS: ${profile.headline}` : "",
    profile.yearsExperience ? `YEARS OF EXPERIENCE: ${profile.yearsExperience}` : "",
    profile.location ? `BASED IN: ${profile.location}` : "",
    profile.skills ? `SKILLS: ${profile.skills}` : "",
    profile.extraNotes ? `NOTES: ${profile.extraNotes}` : "",
    "",
    "RESUME:",
    profile.resumeText || "(none given)",
    "",
    `COMPANY: ${context.company || "(not given)"}`,
    `ROLE: ${context.role || "(not given)"}`,
    "",
    "POSTING:",
    context.jd?.trim() || "(none given — write from the role title)",
  ];
  return parts.filter((part) => part !== "").join("\n");
}

const MIN_WORDS = 80;
const MAX_WORDS = 240;

/**
 * Checks the letter locally before it is shown.
 *
 * Free and instant, and it catches the two failures that matter: a claim
 * the resume does not support, which is the one that gets found out in an
 * interview, and a leftover placeholder, which is the one that gets read.
 */
export function coverProblems(letter: string, profile: Profile): string[] {
  const problems: string[] = [];
  const text = letter.trim();

  if (!text) return ["The letter came back empty."];

  const invented = unsupportedClaimsIn(text, profile);
  if (invented.length) {
    problems.push(`It claims "${invented.join('", "')}", which the resume does not say.`);
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) problems.push(`It is ${words} words. Cut it to 120-180.`);
  if (words < MIN_WORDS) problems.push(`It is only ${words} words.`);

  if (/\[(?:your|company|role|name|position)[^\]]*\]/i.test(text)) {
    problems.push("It has an unfilled placeholder in it.");
  }
  if (/^\s*(dear|to whom)/i.test(text)) {
    problems.push("It opens with a greeting, which the form does not want.");
  }

  return problems;
}

export type CoverResult = { letter: string; writer: string; problems: string[] };

export function coverWritersAvailable(): boolean {
  return groqPool.count() > 0 || geminiPool.count() > 0;
}

/**
 * Writes one, or says why it could not.
 *
 * Problems are reported alongside the letter rather than used to reject it.
 * A letter with one shaky sentence is still a far better starting point
 * than an empty box, and the person reads it before it goes anywhere —
 * this is a draft for them, not an email about to be sent.
 */
export async function writeCoverLetter(
  profile: Profile,
  context: CoverContext,
): Promise<CoverResult> {
  if (!coverWritersAvailable()) throw new Error("No key that can write a cover letter is set.");

  const user = buildCoverText(profile, context);
  const failures: string[] = [];

  if (groqPool.count() > 0) {
    try {
      const raw = await askGroqJson(`${COVER_SYSTEM_PROMPT}\n\n${SHAPE}`, user, 2048);
      const letter = AnswerSchema.safeParse(raw).data?.letter?.trim() ?? "";
      if (letter) return { letter, writer: "groq", problems: coverProblems(letter, profile) };
      failures.push("groq: empty answer");
    } catch (err) {
      failures.push(`groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (geminiPool.count() > 0) {
    try {
      const raw = await askGeminiJson(COVER_SYSTEM_PROMPT, user, GEMINI_COVER_SCHEMA, 2048);
      const letter = AnswerSchema.safeParse(raw).data?.letter?.trim() ?? "";
      if (letter) return { letter, writer: "gemini", problems: coverProblems(letter, profile) };
      failures.push("gemini: empty answer");
    } catch (err) {
      failures.push(`gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Could not write a cover letter. ${failures.join(" — ")}`);
}

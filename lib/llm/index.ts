import { outreachWithClaude, reviseWithClaude, runClaude, writeWithClaude } from "./claude";
import { outreachWithGemini, reviseWithGemini, runGemini, writeWithGemini } from "./gemini";
import { outreachWithGroq, readWithGroq, reviseWithGroq, writeWithGroq } from "./groq";
import { outreachWithCerebras, reviseWithCerebras, writeWithCerebras } from "./cerebras";
import { cerebrasPool, geminiPool, groqPool } from "./keyPool";
import { unsupportedClaimsIn } from "@/lib/validate";
import type { Facts, OutreachTarget, Written } from "./prompt";
import type { Profile } from "@/lib/types";

export type LlmImage = { mediaType: string; data: string };

export type LlmRequest = {
  text: string;
  images: LlmImage[];
};

/** "extract" pulls the facts only; "full" also writes the email in one call. */
export type ReadMode = "full" | "extract";

export type ReadJob = Facts & { subject?: string; body?: string };
export type ReadResult = { jobs: ReadJob[] };

export type VisionReader = "claude" | "gemini";
export type TextReader = VisionReader | "groq";
export type WriterName = "groq" | "cerebras" | "claude" | "gemini";

/** Screenshots need a model that can see. */
export function activeVisionReader(): VisionReader | null {
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (geminiPool.count() > 0) return "gemini";
  return null;
}

/**
 * Readers that can handle plain text, best first.
 *
 * Groq comes before Gemini deliberately. Gemini's free tier is the scarce
 * resource and it is the only one of the two that can read a screenshot, so
 * spending it on text that Groq handles perfectly well is a waste. Claude,
 * when configured, is paid and best, so it leads.
 */
export function textReaders(): TextReader[] {
  const list: TextReader[] = [];
  if (process.env.ANTHROPIC_API_KEY) list.push("claude");
  if (groqPool.count() > 0) list.push("groq");
  if (geminiPool.count() > 0) list.push("gemini");
  return list;
}

export function activeTextReader(): TextReader | null {
  return textReaders()[0] ?? null;
}

/** Readers that can see an image, best first. */
export function visionReaders(): VisionReader[] {
  const list: VisionReader[] = [];
  if (process.env.ANTHROPIC_API_KEY) list.push("claude");
  if (geminiPool.count() > 0) list.push("gemini");
  return list;
}

/** Writing never sees an image, so the fast free provider goes first. */
export function activeWriter(): WriterName | null {
  return writers()[0] ?? null;
}

export function providerStatus() {
  return {
    visionReader: activeVisionReader(),
    textReader: activeTextReader(),
    writer: activeWriter(),
    gemini: geminiPool.count() > 0 ? geminiPool.status() : null,
    groq: groqPool.count() > 0 ? groqPool.status() : null,
    cerebras: cerebrasPool.count() > 0 ? cerebrasPool.status() : null,
  };
}

async function readWith(
  reader: TextReader,
  req: LlmRequest,
  mode: ReadMode,
): Promise<ReadResult> {
  if (reader === "claude") return runClaude(req, mode);
  if (reader === "gemini") return runGemini(req, mode);
  return readWithGroq(req.text, mode);
}

export async function readJobs(
  req: LlmRequest,
  mode: ReadMode,
): Promise<{ result: ReadResult; reader: TextReader }> {
  // Screenshots need vision; text can go to any reader.
  const candidates: TextReader[] = req.images.length ? visionReaders() : textReaders();

  if (!candidates.length) {
    throw new Error(
      req.images.length
        ? groqPool.count() > 0
          ? "Groq cannot read screenshots — it has no vision. Use Local first so they are read on your device, or add GEMINI_API_KEY_1 (free)."
          : "No key that can read screenshots is set. Add GEMINI_API_KEY_1 (free) or ANTHROPIC_API_KEY."
        : "No key that can read job descriptions is set. Add GROQ_API_KEY_1 or GEMINI_API_KEY_1 (both free).",
    );
  }

  // One provider's pool running dry should not fail the request when another
  // provider could do the same job.
  let firstError: unknown;
  for (const reader of candidates) {
    try {
      return { result: await readWith(reader, req, mode), reader };
    } catch (err) {
      firstError ??= err;
      console.error(`[read] ${reader} failed, trying next`, err instanceof Error ? err.message : err);
    }
  }

  throw firstError instanceof Error ? firstError : new Error("Could not read this job description.");
}

/**
 * Writers in preference order. WRITER_ORDER overrides it — "gemini,groq" for
 * instance — so the default can be changed without a deploy of new code.
 */
function writers(): WriterName[] {
  const available = new Set<WriterName>();
  if (groqPool.count() > 0) available.add("groq");
  if (cerebrasPool.count() > 0) available.add("cerebras");
  if (process.env.ANTHROPIC_API_KEY) available.add("claude");
  if (geminiPool.count() > 0) available.add("gemini");

  const preferred = (process.env.WRITER_ORDER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is WriterName => available.has(s as WriterName));

  // Anything configured comes first; the rest still act as fallbacks.
  return [...new Set([...preferred, ...available])];
}

const MIN_WORDS = 45;
const MAX_WORDS = 130;

/**
 * Checks the finished email against the profile locally — free and instant —
 * and only pays for a second model call when something is actually wrong.
 * In the common case this costs nothing at all.
 */
function problemsWith(written: Written, profile: Profile): string[] {
  const problems: string[] = [];

  const invented = unsupportedClaimsIn(written.body, profile);
  if (invented.length) {
    problems.push(
      `The email claims "${invented.join('", "')}" at a named employer. None of that appears in ` +
        `the resume. Remove those claims, or replace them with something the resume actually says.`,
    );
  }

  const words = written.body.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) problems.push(`The body is ${words} words. Cut it to 60-90.`);
  if (words < MIN_WORDS) problems.push(`The body is only ${words} words. It needs more substance.`);

  if (/(best regards|sincerely|kind regards|warm regards)/i.test(written.body)) {
    problems.push("The body ends with a sign-off. Remove it — one is appended automatically.");
  }
  if (/\[(?:your|company|role|name)[^\]]*\]/i.test(written.body + written.subject)) {
    problems.push("There is an unfilled placeholder. Replace it with real text.");
  }

  return problems;
}

async function reviseWith(
  writer: WriterName,
  profile: Profile,
  facts: Facts,
  draft: Written,
  problems: string[],
): Promise<Written> {
  if (writer === "groq") return reviseWithGroq(profile, facts, draft, problems);
  if (writer === "cerebras") return reviseWithCerebras(profile, facts, draft, problems);
  if (writer === "claude") return reviseWithClaude(profile, facts, draft, problems);
  return reviseWithGemini(profile, facts, draft, problems);
}

/**
 * A speculative "do you have openings?" email — no posting involved, so it
 * takes a target address and a role rather than extracted job facts.
 */
export async function writeOutreach(
  profile: Profile,
  target: OutreachTarget,
): Promise<{ written: Written; writer: WriterName }> {
  const candidates = writers();
  if (!candidates.length) throw new Error("No key that can write emails is set.");

  let firstError: unknown;
  for (const writer of candidates) {
    try {
      const written =
        writer === "groq"
          ? await outreachWithGroq(profile, target)
          : writer === "cerebras"
            ? await outreachWithCerebras(profile, target)
            : writer === "claude"
              ? await outreachWithClaude(profile, target)
              : await outreachWithGemini(profile, target);
      return { written, writer };
    } catch (err) {
      firstError ??= err;
      console.error(`[outreach] ${writer} failed, trying next`, err instanceof Error ? err.message : err);
    }
  }

  throw firstError instanceof Error ? firstError : new Error("Could not write this email.");
}

export async function writeEmail(
  profile: Profile,
  facts: Facts,
): Promise<{ written: Written; writer: WriterName; revised: boolean }> {
  const candidates = writers();
  if (!candidates.length) throw new Error("No key that can write emails is set.");

  let firstError: unknown;

  for (const writer of candidates) {
    let written: Written;
    try {
      written =
        writer === "groq"
          ? await writeWithGroq(profile, facts)
          : writer === "cerebras"
            ? await writeWithCerebras(profile, facts)
            : writer === "claude"
              ? await writeWithClaude(profile, facts)
              : await writeWithGemini(profile, facts);
    } catch (err) {
      firstError ??= err;
      console.error(`[write] ${writer} failed, trying next`, err instanceof Error ? err.message : err);
      continue;
    }

    const problems = problemsWith(written, profile);
    if (!problems.length) return { written, writer, revised: false };

    console.warn(`[write] ${writer} produced ${problems.length} problem(s), revising`);
    try {
      const fixed = await reviseWith(writer, profile, facts, written, problems);
      // Keep the revision only if it actually improved matters.
      if (problemsWith(fixed, profile).length < problems.length) {
        return { written: fixed, writer, revised: true };
      }
    } catch (err) {
      console.error("[write] revision failed", err instanceof Error ? err.message : err);
    }

    return { written, writer, revised: false };
  }

  throw firstError instanceof Error ? firstError : new Error("Could not write this email.");
}

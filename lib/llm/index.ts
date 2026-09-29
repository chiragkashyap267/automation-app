import { outreachWithClaude, runClaude, writeWithClaude } from "./claude";
import { outreachWithGemini, runGemini, writeWithGemini } from "./gemini";
import { outreachWithGroq, readWithGroq, writeWithGroq } from "./groq";
import { geminiPool, groqPool } from "./keyPool";
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
export type WriterName = "groq" | "claude" | "gemini";

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
  if (groqPool.count() > 0) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (geminiPool.count() > 0) return "gemini";
  return null;
}

export function providerStatus() {
  return {
    visionReader: activeVisionReader(),
    textReader: activeTextReader(),
    writer: activeWriter(),
    gemini: geminiPool.count() > 0 ? geminiPool.status() : null,
    groq: groqPool.count() > 0 ? groqPool.status() : null,
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

/** Writers in preference order, so one spent pool can fall through to another. */
function writers(): WriterName[] {
  const list: WriterName[] = [];
  if (groqPool.count() > 0) list.push("groq");
  if (process.env.ANTHROPIC_API_KEY) list.push("claude");
  if (geminiPool.count() > 0) list.push("gemini");
  return list;
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
): Promise<{ written: Written; writer: WriterName }> {
  const writer = activeWriter();
  if (!writer) throw new Error("No key that can write emails is set.");

  if (writer === "groq") {
    try {
      return { written: await writeWithGroq(profile, facts), writer };
    } catch (err) {
      // Groq is the free path; if its whole pool is spent, fall back rather than fail.
      const fallback = process.env.ANTHROPIC_API_KEY
        ? ("claude" as const)
        : geminiPool.count() > 0
          ? ("gemini" as const)
          : null;
      if (!fallback) throw err;
      const written =
        fallback === "claude"
          ? await writeWithClaude(profile, facts)
          : await writeWithGemini(profile, facts);
      return { written, writer: fallback };
    }
  }

  const written =
    writer === "claude"
      ? await writeWithClaude(profile, facts)
      : await writeWithGemini(profile, facts);
  return { written, writer };
}

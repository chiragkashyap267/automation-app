import { runClaude, writeWithClaude } from "./claude";
import { runGemini, writeWithGemini } from "./gemini";
import { readWithGroq, writeWithGroq } from "./groq";
import { geminiPool, groqPool } from "./keyPool";
import type { Facts, Written } from "./prompt";
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
 * Text that is already text does not need vision, so Groq can read it. That is
 * what makes a Groq-only setup usable: pasted postings work end to end, and
 * only screenshots fall back to on-device OCR or a vision key.
 */
export function activeTextReader(): TextReader | null {
  return activeVisionReader() ?? (groqPool.count() > 0 ? "groq" : null);
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

export async function readJobs(
  req: LlmRequest,
  mode: ReadMode,
): Promise<{ result: ReadResult; reader: TextReader }> {
  if (req.images.length) {
    const reader = activeVisionReader();
    if (!reader) {
      throw new Error(
        groqPool.count() > 0
          ? "Groq cannot read screenshots — it has no vision. Use Local first so they are read on your device, or add GEMINI_API_KEY_1 (free)."
          : "No key that can read job descriptions is set. Add GEMINI_API_KEY_1 (free) or ANTHROPIC_API_KEY.",
      );
    }
    const result = reader === "claude" ? await runClaude(req, mode) : await runGemini(req, mode);
    return { result, reader };
  }

  const reader = activeTextReader();
  if (!reader) {
    throw new Error(
      "No key that can read job descriptions is set. Add GROQ_API_KEY_1 or GEMINI_API_KEY_1 (both free).",
    );
  }

  const result =
    reader === "claude"
      ? await runClaude(req, mode)
      : reader === "gemini"
        ? await runGemini(req, mode)
        : await readWithGroq(req.text, mode);

  return { result, reader };
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

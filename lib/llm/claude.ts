import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  EXTRACT_SYSTEM_PROMPT,
  ExtractSchema,
  FULL_SYSTEM_PROMPT,
  JobsSchema,
  OUTREACH_SYSTEM_PROMPT,
  WRITE_SYSTEM_PROMPT,
  buildOutreachText,
  type OutreachTarget,
  WrittenSchema,
  buildWriteText,
  type Facts,
  type Written,
} from "./prompt";
import type { LlmRequest, ReadMode, ReadResult } from "./index";
import type { Profile } from "@/lib/types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const EFFORT = process.env.ANTHROPIC_EFFORT as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | undefined;

function checkStop(response: { stop_reason: string | null }) {
  if (response.stop_reason === "refusal") {
    throw new Error(
      "Claude declined to process this input. Try removing the screenshot that may contain unrelated personal data.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The response was cut off. Try fewer job descriptions at a time.");
  }
}

export async function runClaude(req: LlmRequest, mode: ReadMode): Promise<ReadResult> {
  const client = new Anthropic();

  const content: Anthropic.ContentBlockParam[] = req.images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
      data: img.data,
    },
  }));
  content.push({ type: "text", text: req.text });

  const extractOnly = mode === "extract";

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: extractOnly ? EXTRACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content }],
    output_config: {
      format: zodOutputFormat(extractOnly ? ExtractSchema : JobsSchema),
      ...(EFFORT ? { effort: EFFORT } : {}),
    },
  });

  checkStop(response);
  if (!response.parsed_output) {
    throw new Error("Claude returned a response that did not match the expected shape.");
  }
  return response.parsed_output as ReadResult;
}

async function complete(system: string, user: string): Promise<Written> {
  const client = new Anthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: user }],
    output_config: {
      format: zodOutputFormat(WrittenSchema),
      ...(EFFORT ? { effort: EFFORT } : {}),
    },
  });

  checkStop(response);
  if (!response.parsed_output) {
    throw new Error("Claude returned an email in an unexpected shape.");
  }
  return response.parsed_output;
}

export function writeWithClaude(profile: Profile, facts: Facts): Promise<Written> {
  return complete(WRITE_SYSTEM_PROMPT, buildWriteText(profile, facts));
}

export function outreachWithClaude(profile: Profile, target: OutreachTarget): Promise<Written> {
  return complete(OUTREACH_SYSTEM_PROMPT, buildOutreachText(profile, target));
}

import {
  EXTRACT_SYSTEM_PROMPT,
  ExtractSchema,
  FULL_SYSTEM_PROMPT,
  JobsSchema,
  WRITE_SYSTEM_PROMPT,
  WrittenSchema,
  buildWriteText,
  type Facts,
  type Written,
} from "./prompt";
import { groqPool, markFailure, markSuccess, type KeyFailure, type KeyState } from "./keyPool";
import type { ReadMode, ReadResult } from "./index";
import type { Profile } from "@/lib/types";

/**
 * Groq serves open models on their own inference hardware. It has a free tier,
 * it is very fast, and it is text-only — which is exactly the shape of the
 * writing stage, since the reading stage has already turned screenshots into
 * plain facts. The API is OpenAI-compatible.
 */
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

class KeyError extends Error {
  failure: KeyFailure;
  retryAfterMs?: number;

  constructor(failure: KeyFailure, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "KeyError";
    this.failure = failure;
    this.retryAfterMs = retryAfterMs;
  }
}

function classify(status: number, raw: string, retryAfterHeader: string | null): KeyError | null {
  let message = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    /* non-JSON error body */
  }

  const retryAfterMs = retryAfterHeader ? Math.ceil(Number(retryAfterHeader) * 1000) : undefined;

  if (status === 429) {
    const daily = /per day|day|RPD|TPD/i.test(message);
    return new KeyError(daily ? "daily-quota" : "rate-limit", message, retryAfterMs);
  }
  if (status === 401 || status === 403) return new KeyError("invalid", message);
  if (status >= 500) return new KeyError("server", message);
  return null;
}

/**
 * Node throws a bare TypeError for a failed fetch, but so does a plain coding
 * mistake. Only the real network case should burn a key and move on — anything
 * else must surface, not be retried silently across every key in the pool.
 */
function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    (err.cause !== undefined || /fetch failed|network|socket|ECONNRESET/i.test(err.message))
  );
}

async function callGroq(
  state: KeyState,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const raw = await res.text();
    const keyError = classify(res.status, raw, res.headers.get("retry-after"));
    if (keyError) throw keyError;
    throw new Error(`Groq returned ${res.status}: ${raw.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };

  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Groq's response was cut off. Try fewer job descriptions at a time.");
  }

  const raw = choice?.message?.content ?? "";
  if (!raw.trim()) throw new Error("Groq returned an empty response.");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Groq returned text that was not valid JSON.");
  }
}

/** Runs one logical request across the Groq pool, failing over per key. */
async function withFailover<T>(run: (state: KeyState) => Promise<T>): Promise<T> {
  const candidates = groqPool.keysToTry();
  if (!candidates.length) throw new Error("No Groq API key is set.");

  const exhausted: string[] = [];

  for (const state of candidates) {
    try {
      const value = await run(state);
      markSuccess(state);
      return value;
    } catch (err) {
      if (err instanceof KeyError) {
        markFailure(state, err.failure, err.message, err.retryAfterMs);
        exhausted.push(`${state.label}: ${err.failure}`);
        continue;
      }
      if (isNetworkError(err)) {
        markFailure(state, "server", "network error");
        exhausted.push(`${state.label}: network`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `All ${candidates.length} Groq key${candidates.length === 1 ? "" : "s"} are rate limited or ` +
      `rejected right now (${exhausted.slice(0, 3).join("; ")}).`,
  );
}

export async function writeWithGroq(profile: Profile, facts: Facts): Promise<Written> {
  const parsed = await withFailover((state) =>
    callGroq(
      state,
      `${WRITE_SYSTEM_PROMPT}

Return a JSON object with exactly two string keys: "subject" and "body". No other keys.`,
      buildWriteText(profile, facts),
      1400,
      0.5,
    ),
  );

  const result = WrittenSchema.safeParse(parsed);
  // A malformed body is the model's fault, not the key's — do not bench a key for it.
  if (!result.success) throw new Error("Groq returned an email in an unexpected shape.");
  return result.data;
}

const JOBS_SHAPE = `Return a JSON object with one key "jobs", an array. Each entry must have exactly these keys: "company" (string), "role" (string), "location" (string), "reqId" (string), "recipients" (array of strings), "contactName" (string), "highlights" (array of strings), "seniority" (string), "confidence" ("high" | "medium" | "low"), "notes" (string)`;

/**
 * Groq has no vision, so it can only read job descriptions that are already
 * text. That still covers pasted postings, and it means a Groq-only setup is
 * useful on its own — screenshots are what need Gemini or Claude.
 */
export async function readWithGroq(text: string, mode: ReadMode): Promise<ReadResult> {
  const extractOnly = mode === "extract";
  const shape = extractOnly
    ? `${JOBS_SHAPE}. No other keys.`
    : `${JOBS_SHAPE}, plus "subject" (string) and "body" (string). No other keys.`;

  const parsed = await withFailover((state) =>
    callGroq(
      state,
      `${extractOnly ? EXTRACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT}

${shape}`,
      text,
      extractOnly ? 2000 : 6000,
      0.4,
    ),
  );

  const result = (extractOnly ? ExtractSchema : JobsSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("Groq returned JSON that did not match the expected shape.");
  }
  return result.data as ReadResult;
}

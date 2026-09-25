import {
  EXTRACT_SYSTEM_PROMPT,
  ExtractSchema,
  FULL_SYSTEM_PROMPT,
  GEMINI_EXTRACT_SCHEMA,
  GEMINI_FULL_SCHEMA,
  JobsSchema,
  WRITE_SYSTEM_PROMPT,
  WrittenSchema,
  buildWriteText,
  type Facts,
  type Written,
} from "./prompt";
import { geminiPool, markFailure, markSuccess, type KeyFailure, type KeyState } from "./keyPool";
import type { LlmRequest, ReadMode, ReadResult } from "./index";
import type { Profile } from "@/lib/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

type GeminiError = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; retryDelay?: string }[];
  };
};

/** A problem with this key — try the next one. Anything else is fatal. */
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

function parseRetryDelay(body: GeminiError): number | undefined {
  const info = body.error?.details?.find((d) => d["@type"]?.includes("RetryInfo"));
  const match = info?.retryDelay?.match(/^([\d.]+)s$/);
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

function classify(status: number, raw: string): KeyError | null {
  let body: GeminiError = {};
  try {
    body = JSON.parse(raw) as GeminiError;
  } catch {
    /* non-JSON error body — fall through on status alone */
  }
  const message = body.error?.message || raw.slice(0, 200);

  if (status === 429) {
    // Per-minute limits recover fast; per-day ones do not.
    const daily = /per day|PerDay|daily limit|quota.*exhausted/i.test(message);
    return new KeyError(daily ? "daily-quota" : "rate-limit", message, parseRetryDelay(body));
  }
  if (status === 401 || status === 403) return new KeyError("invalid", message);
  if (status === 400 && /API key not valid|API_KEY_INVALID|expired/i.test(message)) {
    return new KeyError("invalid", message);
  }
  if (status >= 500) return new KeyError("server", message);

  // 400s about the prompt or schema will fail identically on every key.
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

async function callGemini(
  state: KeyState,
  parts: GeminiPart[],
  system: string,
  schema: unknown,
  maxOutputTokens: number,
): Promise<unknown> {
  const res = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": state.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
  });

  if (!res.ok) {
    const raw = await res.text();
    const keyError = classify(res.status, raw);
    if (keyError) throw keyError;
    throw new Error(`Gemini returned ${res.status}: ${raw.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked this input (${json.promptFeedback.blockReason}).`);
  }

  const candidate = json.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("The response was cut off. Try fewer job descriptions at a time.");
  }

  const raw = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!raw.trim()) throw new Error("Gemini returned an empty response.");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned text that was not valid JSON.");
  }
}

/** Runs one logical request across the key pool, failing over per key. */
async function withFailover<T>(run: (state: KeyState) => Promise<T>): Promise<T> {
  const candidates = geminiPool.keysToTry();
  if (!candidates.length) {
    throw new Error("No Gemini API key is set. Add GEMINI_API_KEY_1 (and up) to your environment.");
  }

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
        // fetch-level network failure — not this key's fault, but retry elsewhere
        markFailure(state, "server", "network error");
        exhausted.push(`${state.label}: network`);
        continue;
      }
      throw err; // prompt, schema, or safety problem — every key would fail the same way
    }
  }

  throw new Error(
    `All ${candidates.length} Gemini key${candidates.length === 1 ? "" : "s"} are rate limited or ` +
      `rejected right now (${exhausted.slice(0, 3).join("; ")}). Wait about a minute and retry, ` +
      `or add a GROQ_API_KEY / ANTHROPIC_API_KEY.`,
  );
}

/**
 * Gemini is reached over raw HTTP rather than a client library: the request is
 * one POST, which keeps the free path dependency-free and makes per-key
 * failover straightforward.
 */
export async function runGemini(req: LlmRequest, mode: ReadMode): Promise<ReadResult> {
  const parts: GeminiPart[] = req.images.map((img) => ({
    inlineData: { mimeType: img.mediaType, data: img.data },
  }));
  parts.push({ text: req.text });

  const extractOnly = mode === "extract";
  const parsed = await withFailover((state) =>
    callGemini(
      state,
      parts,
      extractOnly ? EXTRACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT,
      extractOnly ? GEMINI_EXTRACT_SCHEMA : GEMINI_FULL_SCHEMA,
      extractOnly ? 2048 : 8192,
    ),
  );

  const result = (extractOnly ? ExtractSchema : JobsSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("Gemini returned JSON that did not match the expected shape.");
  }
  return result.data as ReadResult;
}

/** Writing fallback, used when no Groq or Claude key is configured. */
export async function writeWithGemini(profile: Profile, facts: Facts): Promise<Written> {
  const parsed = await withFailover((state) =>
    callGemini(
      state,
      [{ text: buildWriteText(profile, facts) }],
      WRITE_SYSTEM_PROMPT,
      {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        propertyOrdering: ["subject", "body"],
        required: ["subject", "body"],
      },
      2048,
    ),
  );

  const result = WrittenSchema.safeParse(parsed);
  if (!result.success) throw new Error("Gemini returned an email in an unexpected shape.");
  return result.data;
}

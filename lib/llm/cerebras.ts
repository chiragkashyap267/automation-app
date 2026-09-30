import type { Lead, ServicesProfile } from "../services";
import {
  OUTREACH_SYSTEM_PROMPT,
  PITCH_SYSTEM_PROMPT,
  REVISE_SYSTEM_PROMPT,
  WRITE_SYSTEM_PROMPT,
  WrittenSchema,
  buildOutreachText,
  buildPitchText,
  buildReviseText,
  buildWriteText,
  type Facts,
  type OutreachTarget,
  type Written,
} from "./prompt";
import { cerebrasPool, markFailure, markSuccess, type KeyFailure, type KeyState } from "./keyPool";
import type { Profile } from "@/lib/types";

/**
 * Cerebras runs open models on their own silicon — a free tier, an
 * OpenAI-compatible API, and the fastest of the three free writers. Text only,
 * so like Groq it writes but never reads a screenshot.
 */
const MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";
const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

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

function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    (err.cause !== undefined || /fetch failed|network|socket|ECONNRESET/i.test(err.message))
  );
}

function classify(status: number, raw: string, retryAfter: string | null): KeyError | null {
  let message = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { message?: string; error?: { message?: string } };
    message = body.error?.message ?? body.message ?? message;
  } catch {
    /* non-JSON error body */
  }

  const retryAfterMs = retryAfter ? Math.ceil(Number(retryAfter) * 1000) : undefined;

  if (status === 429) {
    const daily = /per day|daily|RPD|TPD/i.test(message);
    return new KeyError(daily ? "daily-quota" : "rate-limit", message, retryAfterMs);
  }
  if (status === 401 || status === 403) return new KeyError("invalid", message);
  if (status >= 500) return new KeyError("server", message);
  return null;
}

async function call(state: KeyState, system: string, user: string): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      // Same reasoning-model headroom Groq needs.
      max_completion_tokens: 6000,
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
    throw new Error(`Cerebras returned ${res.status}: ${raw.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };

  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Cerebras ran out of room before finishing the email.");
  }

  const raw = choice?.message?.content ?? "";
  if (!raw.trim()) throw new Error("Cerebras returned an empty response.");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Cerebras returned text that was not valid JSON.");
  }
}

async function complete(system: string, user: string): Promise<Written> {
  const candidates = cerebrasPool.keysToTry();
  if (!candidates.length) throw new Error("No Cerebras API key is set.");

  const exhausted: string[] = [];

  for (const state of candidates) {
    try {
      const parsed = await call(state, system, user);
      const result = WrittenSchema.safeParse(parsed);
      // A malformed body is the model's fault, not the key's.
      if (!result.success) throw new Error("Cerebras returned an email in an unexpected shape.");
      markSuccess(state);
      return result.data;
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
    `All ${candidates.length} Cerebras key${candidates.length === 1 ? "" : "s"} are rate limited ` +
      `or rejected right now (${exhausted.slice(0, 3).join("; ")}).`,
  );
}

const JSON_SHAPE =
  'Return a JSON object with exactly two string keys: "subject" and "body". No other keys.';

export function writeWithCerebras(profile: Profile, facts: Facts): Promise<Written> {
  return complete(`${WRITE_SYSTEM_PROMPT}\n\n${JSON_SHAPE}`, buildWriteText(profile, facts));
}

export function outreachWithCerebras(profile: Profile, target: OutreachTarget): Promise<Written> {
  return complete(`${OUTREACH_SYSTEM_PROMPT}\n\n${JSON_SHAPE}`, buildOutreachText(profile, target));
}

/** A freelance service pitch. Same plumbing, a very different email. */
export function pitchWithCerebras(services: ServicesProfile, lead: Lead): Promise<Written> {
  return complete(`${PITCH_SYSTEM_PROMPT}\n\n${JSON_SHAPE}`, buildPitchText(services, lead));
}

export function reviseWithCerebras(
  profile: Profile,
  facts: Facts,
  draft: Written,
  problems: string[],
): Promise<Written> {
  return complete(
    `${REVISE_SYSTEM_PROMPT}\n\n${JSON_SHAPE}`,
    buildReviseText(profile, facts, draft, problems),
  );
}

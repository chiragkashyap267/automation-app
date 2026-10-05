import { outreachWithClaude, pitchWithClaude, reviseWithClaude, runClaude, writeWithClaude } from "./claude";
import { outreachWithGemini, pitchWithGemini, reviseWithGemini, runGemini, writeWithGemini } from "./gemini";
import { outreachWithGroq, pitchWithGroq, readWithGroq, reviseWithGroq, writeWithGroq } from "./groq";
import { outreachWithCerebras, pitchWithCerebras, reviseWithCerebras, writeWithCerebras } from "./cerebras";
import { cerebrasPool, geminiPool, groqPool } from "./keyPool";
import { dedupeJobs } from "@/lib/dedupe";
import { inventedClientsIn, unsupportedClaimsIn } from "@/lib/validate";
import { loadCooldowns } from "./cooldown";
import type { Lead, ServicesProfile } from "@/lib/services";
import { EMPTY_PROFILE } from "@/lib/types";
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
  return liveFirst(list);
}

export function activeTextReader(): TextReader | null {
  return textReaders()[0] ?? null;
}

/** Readers that can see an image, best first. */
export function visionReaders(): VisionReader[] {
  const list: VisionReader[] = [];
  if (process.env.ANTHROPIC_API_KEY) list.push("claude");
  if (geminiPool.count() > 0) list.push("gemini");
  return liveFirst(list);
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

/**
 * Whether a provider has a key that is not cooling down.
 *
 * Ordering used to ask how many keys a provider had, which stays the same
 * whether they work or not — so a provider whose only key was spent kept its
 * place at the front of the queue and burned a round trip on every request.
 */
function hasHeadroom(name: TextReader | WriterName): boolean {
  if (name === "claude") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (name === "groq") return groqPool.available() > 0;
  if (name === "cerebras") return cerebrasPool.available() > 0;
  return geminiPool.available() > 0;
}

/**
 * Keeps the preference order but moves spent providers to the back. They stay
 * in the list: a stale attempt beats refusing to try when everything is cold.
 */
function liveFirst<T extends TextReader | WriterName>(list: T[]): T[] {
  return [...list.filter(hasHeadroom), ...list.filter((n) => !hasHeadroom(n))];
}

/**
 * Loads cooldowns recorded by earlier invocations before anything is chosen.
 * Without this each request starts believing every key is healthy.
 */
export async function primeCooldowns(): Promise<void> {
  try {
    const map = await loadCooldowns();
    if (!Object.keys(map).length) return;
    geminiPool.applyCooldowns(map);
    groqPool.applyCooldowns(map);
    cerebrasPool.applyCooldowns(map);
  } catch (err) {
    console.error("[llm] could not read cooldowns", err instanceof Error ? err.message : err);
  }
}

/**
 * One message naming what every provider said.
 *
 * Reporting only the first failure meant the user always saw the first
 * provider's complaint — "Groq quota exhausted" — even when the request
 * actually died somewhere else entirely.
 */
function describeAllFailures(failures: { provider: string; message: string }[]): string {
  if (!failures.length) return "No provider was available to try.";
  if (failures.length === 1) return failures[0].message;

  const detail = failures.map((f) => `${f.provider}: ${f.message}`).join(" — ");
  return `All ${failures.length} providers failed. ${detail}`;
}

export async function readJobs(
  req: LlmRequest,
  mode: ReadMode,
): Promise<{ result: ReadResult; reader: TextReader }> {
  // Cooldowns from earlier invocations, so a spent key is not tried first.
  await primeCooldowns();

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
  const failures: { provider: string; message: string }[] = [];
  for (const reader of candidates) {
    try {
      const result = await readWith(reader, req, mode);
      const jobs = dedupeJobs(result.jobs);
      if (jobs.length !== result.jobs.length) {
        console.warn(`[read] ${reader} split one posting into ${result.jobs.length}; merged to ${jobs.length}`);
      }
      return { result: { jobs }, reader };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ provider: reader, message });
      console.error(`[read] ${reader} failed, trying next`, message);
    }
  }

  throw new Error(describeAllFailures(failures));
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

  // Anything configured comes first; the rest still act as fallbacks, and
  // a provider with no usable key drops to the back of whatever order
  // that produces.
  return liveFirst([...new Set([...preferred, ...available])]);
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
  await primeCooldowns();

  const candidates = writers();
  if (!candidates.length) throw new Error("No key that can write emails is set.");

  const failures: { provider: string; message: string }[] = [];
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
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ provider: writer, message });
      console.error(`[outreach] ${writer} failed, trying next`, message);
    }
  }

  throw new Error(describeAllFailures(failures));
}

export async function writeEmail(
  profile: Profile,
  facts: Facts,
): Promise<{ written: Written; writer: WriterName; revised: boolean }> {
  await primeCooldowns();

  const candidates = writers();
  if (!candidates.length) throw new Error("No key that can write emails is set.");

  const failures: { provider: string; message: string }[] = [];

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
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ provider: writer, message });
      console.error(`[write] ${writer} failed, trying next`, message);
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

  throw new Error(describeAllFailures(failures));
}

/**
 * Applies the write-path's quality check to an email that arrived from a
 * one-shot read.
 *
 * The bot reads and writes in a single call to save quota, which meant its
 * drafts skipped the check that catches a model inventing experience — the
 * exact failure this app has already produced once. The check itself is
 * local and free; a second call is made only when something is wrong, and
 * only kept when it is actually an improvement.
 */
export async function reviseIfNeeded(
  profile: Profile,
  facts: Facts,
  written: Written,
): Promise<{ written: Written; problems: string[]; revised: boolean }> {
  const problems = problemsWith(written, profile);
  if (!problems.length) return { written, problems: [], revised: false };

  console.warn(`[read] one-shot draft has ${problems.length} problem(s), revising`);

  for (const writer of writers()) {
    try {
      const fixed = await reviseWith(writer, profile, facts, written, problems);
      const left = problemsWith(fixed, profile);
      if (left.length < problems.length) return { written: fixed, problems: left, revised: true };
    } catch (err) {
      console.error(`[read] revision via ${writer} failed`, err instanceof Error ? err.message : err);
    }
  }

  return { written, problems, revised: false };
}

/* ────────────────────── freelance service pitches ────────────────────── */

const PITCH_MIN_WORDS = 40;
const PITCH_MAX_WORDS = 120;

/**
 * What makes a pitch bad, checked locally and for free.
 *
 * The failure mode here is not the same as an application's. A pitch goes
 * wrong by inventing a client, praising a business the sender has never
 * seen, or sounding like the same mail sent to a thousand addresses — which
 * is both useless and the fastest way to get the account flagged.
 */
function pitchProblems(written: Written, services: ServicesProfile): string[] {
  const problems: string[] = [];
  const body = written.body;

  const invented = inventedClientsIn(body, services);
  if (invented.length) {
    problems.push(
      `The email claims work for "${invented.join('", "')}", which is not in the past work ` +
        `given. Remove those names, or describe the work without naming a client.`,
    );
  }

  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words > PITCH_MAX_WORDS) problems.push(`The body is ${words} words. Cut it to 60-90.`);
  if (words < PITCH_MIN_WORDS) problems.push(`The body is only ${words} words. Too thin to act on.`);

  // Praise for a business nobody has looked at is the clearest tell of a
  // bulk mail, and the recipient always knows.
  if (/\b(love|admire|impressed by|big fan of|huge fan)\b/i.test(body)) {
    problems.push("The email praises the business. Remove it — you have not seen their work.");
  }
  if (/\b(I came across your (website|instagram|page|store)|I was browsing|I visited your)\b/i.test(body)) {
    problems.push("The email claims to have looked at their site or socials. Remove that claim.");
  }
  if (/\b(apply|application|resume|CV|vacancy|position)\b/i.test(body)) {
    problems.push("This reads like a job application. It is an offer of services, not a request for a job.");
  }
  if (/(best regards|sincerely|kind regards|warm regards)/i.test(body)) {
    problems.push("The body ends with a sign-off. Remove it — one is appended automatically.");
  }

  return problems;
}

async function pitchWith(
  writer: WriterName,
  services: ServicesProfile,
  lead: Lead,
): Promise<Written> {
  if (writer === "groq") return pitchWithGroq(services, lead);
  if (writer === "cerebras") return pitchWithCerebras(services, lead);
  if (writer === "claude") return pitchWithClaude(services, lead);
  return pitchWithGemini(services, lead);
}

export async function writePitch(
  services: ServicesProfile,
  lead: Lead,
): Promise<{ written: Written; writer: WriterName; problems: string[] }> {
  await primeCooldowns();

  const candidates = writers();
  if (!candidates.length) throw new Error("No key that can write emails is set.");

  const failures: { provider: string; message: string }[] = [];

  for (const writer of candidates) {
    let written: Written;
    try {
      written = await pitchWith(writer, services, lead);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ provider: writer, message });
      console.error(`[pitch] ${writer} failed, trying next`, message);
      continue;
    }

    const problems = pitchProblems(written, services);
    if (!problems.length) return { written, writer, problems: [] };

    // One paid retry, kept only if it is actually better.
    console.warn(`[pitch] ${writer} produced ${problems.length} problem(s), revising`);
    try {
      const fixed = await reviseWith(
        writer,
        // The reviser speaks Profile and Facts; a pitch has neither, so it
        // is handed the nearest honest equivalents.
        { ...EMPTY_PROFILE, fullName: services.fullName, resumeText: services.proof },
        {
          company: lead.company,
          role: lead.need,
          location: "",
          reqId: "",
          recipients: [lead.email],
          contactName: lead.contactName,
          highlights: [],
          seniority: "",
          confidence: "high",
          notes: "",
        },
        written,
        problems,
      );
      const left = pitchProblems(fixed, services);
      if (left.length < problems.length) return { written: fixed, writer, problems: left };
    } catch (err) {
      console.error("[pitch] revision failed", err instanceof Error ? err.message : err);
    }

    return { written, writer, problems };
  }

  throw new Error(describeAllFailures(failures));
}

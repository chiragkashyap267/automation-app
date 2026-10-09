import { z } from "zod";
import { FILL_KINDS, isFillKind, type FillKind } from "./fillKinds";
import { askGeminiJson } from "./llm/gemini";
import { askGroqJson } from "./llm/groq";
import { geminiPool, groqPool } from "./llm/keyPool";

/**
 * Working out what a field is asking for when the pattern list cannot.
 *
 * The extension matches labels against a list of regular expressions,
 * which covers the forms that have been seen. "Present Employer Name",
 * "Total Relevant Exp. (Yrs)", "Mobile No. (Primary)" all fall straight
 * through it, and every portal words things its own way, so the list can
 * never be finished by hand.
 *
 * A model is good at exactly this question and nothing else is needed from
 * it: given the words beside a box, which of our field kinds is it. The
 * answer is constrained to that list, so anything inventive is discarded
 * rather than typed into someone's application.
 *
 * What is deliberately NOT sent: the profile. Not the name, not the phone
 * number, not the resume. Classifying "Present Employer Name" needs none
 * of it — the labels alone are the whole question. So this call carries no
 * personal data off the machine at all, and the filling itself happens in
 * the browser with values that never left it.
 */

/** A field the extension could not place, as the page describes it. */
export const UnknownFieldSchema = z.object({
  /** The words a human reads as the question. */
  label: z.string(),
  /** input type, or "select" / "textarea" / "radiogroup". */
  type: z.string().default(""),
  /** The choices, when it is a dropdown — often the best clue of all. */
  options: z.array(z.string()).default([]),
});

export type UnknownField = z.infer<typeof UnknownFieldSchema>;

export type Resolution = { label: string; kind: FillKind | null };

/** Nothing bigger goes to a model in one request. */
export const MAX_FIELDS = 40;
/** Long option lists are truncated: six is plenty to recognise a dropdown. */
const MAX_OPTIONS = 6;
const MAX_LABEL = 120;

export const RESOLVE_SYSTEM_PROMPT = `You label form fields on job application pages.

You are given fields from one form. For each, decide which of these field kinds it is asking for:
${FILL_KINDS.join(", ")}

Rules:
- Answer with a kind from that list, or "none" if the field is not one of them.
- "none" is the right answer often. Consent tick boxes, "how did you hear about us", referral codes, questionnaire answers, anything specific to one employer: none.
- Do not guess from a vague label. "Details" or "Other" is none, not fullName.
- A dropdown's options are usually the strongest clue. A list of Indian states is a state field whatever it is labelled.
- experience means years of experience as a number. currentCtc and expectedCtc are salary. These three are often confused with each other: read the label carefully.
- coverLetter covers any long free-text box asking why you want the job or for anything to add.
- Identity and credential fields — pan, aadhaar, passport, bank, uan, password, captcha — must be labelled as such. They are never filled in, but naming them is how someone knows to go back to them.`;

export const RESOLVE_SHAPE =
  'Return a JSON object with one key "fields", an array with one entry per field given, in the same order. ' +
  'Each entry is {"label": the label exactly as given, "kind": a kind name or "none"}.';

export const GEMINI_RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, kind: { type: "string" } },
        required: ["label", "kind"],
      },
    },
  },
  required: ["fields"],
};

/** Trimmed to what the question actually needs. */
export function describeFields(fields: UnknownField[]): string {
  return fields
    .slice(0, MAX_FIELDS)
    .map((field, index) => {
      const bits = [`${index + 1}. label: ${field.label.slice(0, MAX_LABEL)}`];
      if (field.type) bits.push(`type: ${field.type}`);
      if (field.options.length) {
        const shown = field.options.slice(0, MAX_OPTIONS).join(" | ");
        const more = field.options.length > MAX_OPTIONS ? `, +${field.options.length - MAX_OPTIONS} more` : "";
        bits.push(`options: ${shown}${more}`);
      }
      return bits.join("\n   ");
    })
    .join("\n");
}

const AnswerSchema = z.object({
  fields: z
    .array(z.object({ label: z.string().default(""), kind: z.string().default("none") }))
    .default([]),
});

/**
 * Reads the model's answer back, keeping only what it was allowed to say.
 *
 * Matched by position rather than by the returned label, because a model
 * rewrites a label far more often than it reorders a list — and a label
 * that comes back subtly different would otherwise silently drop a field.
 * The label we report is always the one we sent.
 */
export function parseResolutions(raw: unknown, asked: UnknownField[]): Resolution[] {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) return [];

  const answers = parsed.data.fields;
  const out: Resolution[] = [];

  for (let i = 0; i < Math.min(asked.length, MAX_FIELDS); i++) {
    const answer = answers[i];
    if (!answer) continue;

    const kind = answer.kind.trim();
    // "none" is an answer, not a failure. Anything outside the list is a
    // failure, and is dropped rather than trusted.
    if (!kind || kind === "none") {
      out.push({ label: asked[i].label, kind: null });
      continue;
    }
    out.push({ label: asked[i].label, kind: isFillKind(kind) ? kind : null });
  }

  return out;
}

export function resolversAvailable(): boolean {
  return groqPool.count() > 0 || geminiPool.count() > 0;
}

/**
 * Labels in, kinds out.
 *
 * Groq first: this is a short classification with no vision needed, and it
 * is the fastest of the free pools — the person is waiting on a form with
 * the page open. Gemini covers a Groq outage.
 */
export async function resolveFields(fields: UnknownField[]): Promise<Resolution[]> {
  const asked = fields.filter((f) => f.label.trim()).slice(0, MAX_FIELDS);
  if (!asked.length) return [];
  if (!resolversAvailable()) throw new Error("No key that can classify form fields is set.");

  const user = describeFields(asked);
  const failures: string[] = [];

  if (groqPool.count() > 0) {
    try {
      const raw = await askGroqJson(`${RESOLVE_SYSTEM_PROMPT}\n\n${RESOLVE_SHAPE}`, user);
      const resolved = parseResolutions(raw, asked);
      if (resolved.length) return resolved;
      failures.push("groq: unreadable answer");
    } catch (err) {
      failures.push(`groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (geminiPool.count() > 0) {
    try {
      const raw = await askGeminiJson(RESOLVE_SYSTEM_PROMPT, user, GEMINI_RESOLVE_SCHEMA);
      const resolved = parseResolutions(raw, asked);
      if (resolved.length) return resolved;
      failures.push("gemini: unreadable answer");
    } catch (err) {
      failures.push(`gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Could not classify these fields. ${failures.join(" — ")}`);
}

"use client";

import type { Facts } from "./llm/prompt";
import { cleanRecipients } from "./email";
import { normalizePlainText } from "./signature";
import { localExtract } from "./localExtract";
import { ocrImage } from "./ocr";
import {
  findRecipe,
  hashInput,
  loadRecipes,
  noteRecipeUse,
  readExtractCache,
  recordSend,
  rememberRecipe,
  renderRecipe,
  familyKey,
} from "./recipes";
import type { Draft, DraftSource, Profile, SourceItem } from "./types";

/** Serverless request bodies are capped at 4.5 MB; stay clear of the edge. */
const MAX_PAYLOAD_BYTES = 3.8 * 1024 * 1024;

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * auto        — cache and recipes, model for anything they cannot cover.
 * local-first — also try on-device OCR and rules, model only when they fail.
 * local-only  — never call the model; say so when local cannot do the job.
 */
export type RunMode = "auto" | "local-first" | "local-only";

export type GroupOutcome = {
  groupId: string;
  drafts: Draft[];
  error: string;
  /** What the run actually cost, for the progress line. */
  usedCache: boolean;
  usedOcr: boolean;
  readCalls: number;
  writeCalls: number;
};

type ApiJob = Facts & { subject?: string; body?: string };

function toDraft(
  groupId: string,
  facts: Facts,
  subject: string,
  body: string,
  source: DraftSource,
): Draft {
  const cleanSubject = normalizePlainText(subject);
  const cleanBody = normalizePlainText(body);

  return {
    id: newId(),
    groupId,
    company: facts.company,
    role: facts.role,
    location: facts.location,
    seniority: facts.seniority,
    reqId: facts.reqId,
    recipients: facts.recipients,
    contactName: facts.contactName,
    highlights: facts.highlights,
    subject: cleanSubject,
    body: cleanBody,
    originalSubject: cleanSubject,
    originalBody: cleanBody,
    confidence: facts.confidence,
    notes: facts.notes,
    source,
    recipeKey: familyKey(facts),
    include: facts.recipients.length > 0,
    status: "idle",
    error: "",
    sentAt: "",
  };
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

/**
 * Turns one group of pasted items into drafts, doing as little paid work as
 * possible:
 *
 *   1. identical input seen before  → cached facts, no call
 *   2. text-only and rules suffice  → local extraction, no call
 *   3. otherwise                    → one read call
 *
 * then, per posting found:
 *
 *   4. a recipe exists for its family → rendered locally, no call
 *   5. otherwise                      → one write call, and the result becomes
 *                                       the recipe for next time
 */
export async function processGroup(
  groupId: string,
  items: SourceItem[],
  profile: Profile,
  mode: RunMode,
  onStage?: (stage: string) => void,
): Promise<GroupOutcome> {
  const tryLocal = mode !== "auto";
  const localOnly = mode === "local-only";
  const images = items
    .filter((i) => i.kind === "image")
    .map((i) => ({ mediaType: i.mediaType, data: i.data }));
  const texts = items.filter((i) => i.kind === "text").map((i) => i.text);

  const outcome: GroupOutcome = {
    groupId,
    drafts: [],
    error: "",
    usedCache: false,
    usedOcr: false,
    readCalls: 0,
    writeCalls: 0,
  };

  try {
    const hash = hashInput(images, texts);
    let jobs: ApiJob[] | null = readExtractCache(hash);
    if (jobs) outcome.usedCache = true;

    // Try to read it here on the device: OCR any screenshots, then apply rules
    // to the combined text. Only used when the result is actually convincing.
    if (!jobs && tryLocal) {
      const parts = [...texts];

      for (const item of items) {
        if (item.kind !== "image") continue;
        onStage?.("Reading screenshot on device…");
        try {
          const ocr = await ocrImage(item.preview);
          outcome.usedOcr = true;
          if (ocr.usable) parts.push(ocr.text);
        } catch {
          /* OCR unavailable — the model path below still covers it */
        }
      }

      const guessed = parts.map((t) => localExtract(t)).filter((f): f is Facts => f !== null);
      if (guessed.length) jobs = guessed;
    }

    if (!jobs && localOnly) {
      outcome.error = images.length
        ? "Could not read this screenshot on the device — it is probably too blurry or low contrast. Switch off Local only to use AI for it."
        : "Could not find an email address and a role in this text. Switch off Local only to use AI for it.";
      return outcome;
    }

    if (!jobs) {
      const payloadBytes =
        images.reduce((n, i) => n + i.data.length, 0) + texts.reduce((n, t) => n + t.length, 0);

      if (payloadBytes > MAX_PAYLOAD_BYTES) {
        outcome.error = `This job has ${images.length} screenshots, which is too much to send in one request. Split it with the Split button, or use Local first so they are read on your device.`;
        return outcome;
      }

      const recipesExist = loadRecipes().length > 0;
      const mode = recipesExist ? "extract" : "full";
      const data = await postJson<{ jobs: ApiJob[] }>("/api/process", {
        profile,
        images,
        texts,
        mode,
      });
      jobs = data.jobs;
      outcome.readCalls = 1;
    }

    if (!jobs.length) {
      outcome.error = "Nothing in this one looked like a job posting.";
      return outcome;
    }

    for (const job of jobs) {
      // Strip icon artifacts and normalise case before anything is sent.
      const { addresses } = cleanRecipients(job.recipients ?? []);

      const facts: Facts = {
        company: job.company,
        role: job.role,
        location: job.location,
        reqId: job.reqId,
        recipients: addresses,
        contactName: job.contactName,
        highlights: job.highlights,
        seniority: job.seniority,
        confidence: job.confidence,
        notes: job.notes,
      };

      // The full-mode read already wrote the email.
      if (job.subject && job.body) {
        outcome.drafts.push(toDraft(groupId, facts, job.subject, job.body, "ai"));
        rememberRecipe(facts, job.subject, job.body);
        continue;
      }

      const recipe = findRecipe(loadRecipes(), facts);
      if (recipe) {
        const rendered = renderRecipe(recipe, facts);
        noteRecipeUse(recipe.key);
        outcome.drafts.push(toDraft(groupId, facts, rendered.subject, rendered.body, "recipe"));
        continue;
      }

      if (localOnly) {
        outcome.error =
          "No recipe matches this kind of role yet. Turn off Local only once so the first email can be written.";
        continue;
      }

      const written = await postJson<{ subject: string; body: string }>("/api/write", {
        profile,
        facts,
      });
      outcome.writeCalls += 1;
      outcome.drafts.push(toDraft(groupId, facts, written.subject, written.body, "ai"));
      rememberRecipe(facts, written.subject, written.body);
    }

    // Only cache a read that produced something usable.
    if (outcome.drafts.length && !outcome.usedCache) {
      const { writeExtractCache } = await import("./recipes");
      writeExtractCache(
        hash,
        jobs.map(({ subject: _s, body: _b, ...facts }) => facts),
      );
    }
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : "Something went wrong.";
  }

  return outcome;
}

/** Facts as they were extracted for this draft. */
export function draftFacts(draft: Draft): Facts {
  return {
    company: draft.company,
    role: draft.role,
    location: draft.location,
    reqId: draft.reqId,
    recipients: draft.recipients,
    contactName: draft.contactName,
    highlights: draft.highlights,
    seniority: draft.seniority,
    confidence: draft.confidence,
    notes: draft.notes,
  };
}

/**
 * After a send succeeds, feed the version that actually went out back into the
 * recipe for its family. Edited emails overwrite the template; clean ones build
 * the streak that marks a recipe as settled.
 */
export function learnFromSend(draft: Draft) {
  recordSend({
    facts: draftFacts(draft),
    originalSubject: draft.originalSubject,
    originalBody: draft.originalBody,
    sentSubject: draft.subject,
    sentBody: draft.body,
  });
}

/** Re-writes one existing draft with the model, bypassing the recipe. */
export async function rewriteDraft(draft: Draft, profile: Profile): Promise<Draft> {
  const facts: Facts = {
    company: draft.company,
    role: draft.role,
    location: draft.location,
    reqId: draft.reqId,
    recipients: draft.recipients,
    contactName: draft.contactName,
    highlights: draft.highlights,
    seniority: draft.seniority,
    confidence: draft.confidence,
    notes: draft.notes,
  };

  const written = await postJson<{ subject: string; body: string }>("/api/write", {
    profile,
    facts,
  });
  rememberRecipe(facts, written.subject, written.body);

  const subject = normalizePlainText(written.subject);
  const body = normalizePlainText(written.body);

  // A rewrite resets the baseline: edits are measured against this version.
  return { ...draft, subject, body, originalSubject: subject, originalBody: body, source: "ai" };
}

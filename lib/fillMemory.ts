import { isFillKind, type FillKind } from "./fillKinds";
import { kvConfigured, kvGet, kvSet } from "./kv";

/**
 * What the filler has been taught.
 *
 * The pattern list and the model between them get most fields right and
 * some wrong, and the wrong ones are wrong the same way every time: a
 * portal that calls notice period "Availability (Days)" will mislabel it
 * on every application until something remembers otherwise. Correcting the
 * same field by hand once a week is the actual cost of this tool.
 *
 * So a correction is stored, and a stored correction outranks both the
 * pattern list and the model. The filler stops making a mistake once.
 *
 * Two maps per correction. The host map is authoritative, because a label
 * can genuinely mean different things on different sites. The global map
 * is the fallback, because label wording is mostly portable — "Present
 * Employer" means the same thing everywhere — so a correction made on one
 * portal helps on the next one, which is the difference between a lookup
 * table and something that learns.
 *
 * Keyed on the normalised label, matching extension/fields.js, so "Notice
 * Period *" and "notice_period" are the same lesson.
 */

const GLOBAL = "*";
const key = (host: string) => `fill:learned:${host || GLOBAL}`;
const TTL = 2 * 365 * 24 * 60 * 60;

/** Enough for years of applying; small enough to stay one cheap read. */
export const MAX_LEARNED = 300;

export type LearnedMap = Record<string, FillKind>;

/**
 * The same normaliser the extension uses, because the two have to agree on
 * what counts as the same label. "First Name *" and "firstName" and
 * "first_name" are one key.
 */
export function normalizeLabel(raw: string): string {
  return String(raw || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/[*:?]/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Just the hostname, so a correction is not filed under a query string. */
export function hostOf(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value.includes("//") ? value : `https://${value}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Drops anything that is not a label mapped to a kind we know. */
function clean(found: unknown): LearnedMap {
  if (!found || typeof found !== "object") return {};
  const out: LearnedMap = {};
  for (const [label, kind] of Object.entries(found as Record<string, unknown>)) {
    if (label && isFillKind(kind)) out[label] = kind;
  }
  return out;
}

export function fillMemoryAvailable(): boolean {
  return kvConfigured();
}

/**
 * Everything learned that applies to this host, global lessons included.
 *
 * The host's own corrections are applied last so they win: a label really
 * can mean one thing on one portal and something else on another, and the
 * person who corrected it on this site knew which site they were on.
 */
export async function learnedFor(host: string): Promise<LearnedMap> {
  if (!kvConfigured()) return {};
  const clean_host = hostOf(host);

  const [global, local] = await Promise.all([
    kvGet<LearnedMap>(key(GLOBAL)),
    clean_host ? kvGet<LearnedMap>(key(clean_host)) : Promise.resolve(null),
  ]);

  return { ...clean(global), ...clean(local) };
}

export type Correction = { label: string; kind: FillKind };

/**
 * Records corrections and reports what it actually took.
 *
 * Oldest entries are dropped once a map is full. A map that silently
 * stopped learning would be worse than one that forgets: the filler would
 * keep making a mistake that had been corrected, with no sign why.
 */
export async function learn(host: string, corrections: Correction[]): Promise<number> {
  if (!kvConfigured()) return 0;

  const usable = corrections.filter((c) => normalizeLabel(c.label) && isFillKind(c.kind));
  if (!usable.length) return 0;

  const clean_host = hostOf(host);
  const targets = clean_host ? [clean_host, GLOBAL] : [GLOBAL];

  for (const target of targets) {
    const existing = clean(await kvGet<LearnedMap>(key(target)));
    for (const { label, kind } of usable) existing[normalizeLabel(label)] = kind;

    const entries = Object.entries(existing);
    const trimmed = entries.length > MAX_LEARNED ? entries.slice(entries.length - MAX_LEARNED) : entries;

    await kvSet(key(target), Object.fromEntries(trimmed), TTL);
  }

  return usable.length;
}

/** Removes a lesson that turned out to be wrong, on this host and globally. */
export async function unlearn(host: string, label: string): Promise<boolean> {
  if (!kvConfigured()) return false;
  const normalized = normalizeLabel(label);
  if (!normalized) return false;

  const clean_host = hostOf(host);
  let removed = false;

  for (const target of clean_host ? [clean_host, GLOBAL] : [GLOBAL]) {
    const existing = clean(await kvGet<LearnedMap>(key(target)));
    if (!(normalized in existing)) continue;
    delete existing[normalized];
    await kvSet(key(target), existing, TTL);
    removed = true;
  }

  return removed;
}

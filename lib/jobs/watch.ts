import { kvClaim, kvConfigured, kvHas } from "../kv";
import type { Profile } from "../types";
import { COMPANIES } from "./companies";
import { collapseDuplicates, indiaTier, passesRoleGates, rank } from "./match";
import { fetchAll, resolveLocation } from "./sources";
import type { Match, Posting } from "./types";

/**
 * The morning run: look at every watched board, keep what fits, and show
 * only what has not been shown before.
 *
 * The dedupe is the part that makes this usable day after day. Without it
 * the same forty postings arrive every morning, you stop opening the
 * message, and the whole thing may as well not exist.
 *
 * Nothing here sends an email or touches the Gmail account. A watcher finds
 * openings; applying stays a deliberate tap, exactly as drafting does.
 */

/** Long enough that a posting cannot come back around while still open. */
const SEEN_TTL = 45 * 24 * 60 * 60;

/** A phone screen holds a handful. More than this and none get read. */
export const DIGEST_LIMIT = 8;

/**
 * Some boards publish no location at all. Those postings are worth seeing
 * but could be anywhere, so they never take more than a corner of a digest
 * that has real Indian openings to show.
 */
const UNKNOWN_LOCATION_LIMIT = 2;

/**
 * How many unplaced postings to look up per run.
 *
 * Each costs a request, and the whole run has to finish inside a serverless
 * window shared with everything else. Candidates are looked up strongest
 * first, so the cap falls on the ones least likely to be shown anyway.
 */
const RESOLVE_BUDGET = 40;

/**
 * One employer should not own the morning. Two is enough to show that a
 * company is hiring; the rest of the digest is better spent on variety,
 * and anything held back is still there tomorrow.
 */
const PER_COMPANY_LIMIT = 2;

const seenKey = (id: string) => `jobseen:${id}`;

/** Has this posting already been in a digest? */
async function alreadySeen(posting: Posting): Promise<boolean> {
  if (!kvConfigured()) return false;
  return kvHas(seenKey(posting.id));
}

/**
 * Records a posting as shown.
 *
 * Deliberately called after delivery, not before. Claiming first means a
 * Telegram call that fails halfway through a digest silently buries those
 * jobs for forty-five days, and they are never offered again.
 */
export async function markSeen(match: Match): Promise<void> {
  if (!kvConfigured()) return;
  await kvClaim(seenKey(match.posting.id), SEEN_TTL);
}

/**
 * Fills in locations for postings whose board would not say.
 *
 * Only runs on postings that already cleared the role gates, which turns
 * thousands of candidates into a few dozen lookups.
 */
async function resolveUnplaced(postings: Posting[]): Promise<void> {
  const unplaced = postings.filter((p) => indiaTier(p) === "unknown").slice(0, RESOLVE_BUDGET);
  const queue = [...unplaced];

  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (;;) {
      const posting = queue.shift();
      if (!posting) return;
      const found = await resolveLocation(posting);
      if (found) posting.location = found;
    }
  });

  await Promise.all(workers);
}

export type WatchResult = {
  /** New, unseen, ranked best first, capped at the digest limit. */
  fresh: Match[];
  /** How many postings every board returned in total. */
  scanned: number;
  /** How many survived the filter, before the seen-check. */
  matched: number;
  /** True when there is no store, so repeats are expected. */
  forgetful: boolean;
};

export async function runWatch(profile: Profile, limit = DIGEST_LIMIT): Promise<WatchResult> {
  const postings = await fetchAll(COMPANIES);

  // Cheap gates first, so the expensive step sees a short list.
  const candidates = collapseDuplicates(postings.filter((p) => passesRoleGates(p.role)));
  await resolveUnplaced(candidates);

  const ranked = rank(candidates, profile);

  const fresh: Match[] = [];
  const perCompany = new Map<string, number>();
  let unknown = 0;
  for (const match of ranked) {
    if (fresh.length >= limit) break;

    const company = match.posting.company;
    if ((perCompany.get(company) ?? 0) >= PER_COMPANY_LIMIT) continue;

    const located = match.tier !== "unknown";
    if (!located && unknown >= UNKNOWN_LOCATION_LIMIT) continue;

    // Checked last: it is the only test that costs a round trip.
    if (await alreadySeen(match.posting)) continue;

    if (!located) unknown += 1;
    perCompany.set(company, (perCompany.get(company) ?? 0) + 1);
    fresh.push(match);
  }

  return {
    fresh,
    scanned: postings.length,
    matched: ranked.length,
    forgetful: !kvConfigured(),
  };
}

const NL = String.fromCharCode(10);

/** Days since posting, in the shortest honest words. */
function age(postedAt: number): string {
  if (!postedAt) return "";
  const days = Math.round((Date.now() - postedAt) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

/** One posting, as it appears in the chat. */
export function jobCard(match: Match, index: number, total: number): string {
  const { posting } = match;
  const where =
    match.tier === "unknown"
      ? `${posting.location || "Location not listed"} — check before applying`
      : posting.location;
  const lines = [
    `${index}/${total}  ${posting.role}`,
    posting.company,
    [where, age(posting.postedAt)].filter(Boolean).join(" · "),
  ];
  return lines.join(NL);
}

/** The tap that applies. A url button opens the employer's own form. */
export function jobKeyboard(match: Match) {
  return {
    inline_keyboard: [[{ text: "🔗 Open & apply", url: match.posting.applyUrl }]],
  };
}

/** The line that goes above the cards. */
export function digestHeader(result: WatchResult): string {
  if (!result.fresh.length) {
    return [
      "No new matches right now.",
      `Checked ${result.scanned} openings across ${COMPANIES.length} companies; ${result.matched} fit your filter, all seen before.`,
    ].join(NL);
  }
  const plural = result.fresh.length === 1 ? "opening" : "openings";
  return [
    `${result.fresh.length} new ${plural} worth a look`,
    `from ${result.scanned} scanned across ${COMPANIES.length} companies`,
  ].join(NL);
}

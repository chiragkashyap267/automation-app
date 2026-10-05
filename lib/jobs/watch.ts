import { kvClaim, kvConfigured } from "../kv";
import type { Profile } from "../types";
import { COMPANIES } from "./companies";
import { rank } from "./match";
import { fetchAll } from "./sources";
import type { Match } from "./types";

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

const seenKey = (id: string) => `jobseen:${id}`;

/**
 * Claims a posting as shown. Returns true the first time only.
 *
 * With no store configured there is nothing to remember with, so every run
 * would repeat itself — better to say so than to quietly spam.
 */
async function claimUnseen(match: Match): Promise<boolean> {
  if (!kvConfigured()) return true;
  return kvClaim(seenKey(match.posting.id), SEEN_TTL);
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

/**
 * Some boards publish no location at all. Those postings are worth seeing
 * but could be anywhere, so they never take more than a corner of a digest
 * that has real Indian openings to show.
 */
const UNKNOWN_LOCATION_LIMIT = 2;

export async function runWatch(profile: Profile, limit = DIGEST_LIMIT): Promise<WatchResult> {
  const postings = await fetchAll(COMPANIES);
  const ranked = rank(postings, profile);

  const fresh: Match[] = [];
  let unknown = 0;
  for (const match of ranked) {
    if (fresh.length >= limit) break;
    const located = match.tier !== "unknown";
    if (!located && unknown >= UNKNOWN_LOCATION_LIMIT) continue;
    if (!(await claimUnseen(match))) continue;
    if (!located) unknown += 1;
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

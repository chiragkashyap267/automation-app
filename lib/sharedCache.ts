import type { Facts } from "./llm/prompt";
import { kvConfigured, kvGet, kvSet } from "./kv";

/**
 * Facts already extracted from an identical input.
 *
 * The web app has had this since the beginning; the bot never did, so
 * re-sending the same screenshot — which happens constantly when a batch is
 * retried or a posting is shared twice — paid for the same read again.
 *
 * Only the facts are stored, never the written email: the wording depends on
 * the profile, and a cached email would outlive an edit to it.
 */

const TTL = 30 * 24 * 60 * 60;
const key = (hash: string) => `extract:${hash}`;

export async function readSharedExtract(hash: string): Promise<Facts[] | null> {
  if (!kvConfigured()) return null;
  return kvGet<Facts[]>(key(hash));
}

export async function writeSharedExtract(hash: string, jobs: Facts[]): Promise<void> {
  if (!kvConfigured() || !jobs.length) return;
  await kvSet(key(hash), jobs, TTL);
}

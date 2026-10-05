import { kvConfigured, kvGet, kvSet } from "../kv";

/**
 * Key cooldowns, remembered across serverless invocations.
 *
 * The key pool lives in module memory, and every Vercel invocation starts
 * with a fresh copy of it. So a key that hit its daily quota on one request
 * looked perfectly healthy on the next, and a spent provider was tried first
 * again — and again — for as long as the user kept working. Ten pasted job
 * descriptions meant ten wasted round trips to the same dead key, and the
 * error the user saw was always that provider's, never the real one.
 *
 * Writing the cooldowns somewhere shared fixes that. A store failure only
 * costs the old behaviour, so nothing here is allowed to throw.
 */

const KEY = "llm:cooldowns";
const TTL = 24 * 60 * 60;

/** label (e.g. "GEMINI_API_KEY_3") → epoch ms the cooldown expires. */
export type CooldownMap = Record<string, number>;

let cache: { at: number; map: CooldownMap } | null = null;

/** Re-reading on every call inside one request would be pure latency. */
const CACHE_MS = 10_000;

export async function loadCooldowns(): Promise<CooldownMap> {
  if (!kvConfigured()) return {};
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;

  const stored = (await kvGet<CooldownMap>(KEY)) ?? {};
  const now = Date.now();

  // Expired entries would otherwise accumulate forever.
  const live: CooldownMap = {};
  for (const [label, until] of Object.entries(stored)) {
    if (typeof until === "number" && until > now) live[label] = until;
  }

  cache = { at: now, map: live };
  return live;
}

export async function publishCooldown(label: string, until: number): Promise<void> {
  if (!kvConfigured()) return;

  try {
    const current = await loadCooldowns();
    // Never shorten a cooldown another invocation already set.
    if ((current[label] ?? 0) >= until) return;

    const next = { ...current, [label]: until };
    cache = { at: Date.now(), map: next };
    await kvSet(KEY, next, TTL);
  } catch (err) {
    console.error("[cooldown] could not share", err instanceof Error ? err.message : err);
  }
}

/** Tests and the status endpoint need a way to start clean. */
export function forgetCooldownCache(): void {
  cache = null;
}

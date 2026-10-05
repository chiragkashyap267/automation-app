/**
 * Rotating pools of API keys, one pool per provider.
 *
 * Keys are tried in round-robin order so load spreads evenly instead of
 * hammering key 1 until it dies. A key that reports a quota or auth problem is
 * put on cooldown and skipped until it expires, so the next request does not
 * pay the latency of failing on it again.
 *
 * State lives in module memory. On a warm server that means cooldowns persist
 * across requests; on a cold serverless instance the pool simply starts fresh,
 * which costs one wasted attempt and nothing else.
 */

export type KeyFailure = "rate-limit" | "daily-quota" | "invalid" | "server";

export type KeyState = {
  key: string;
  label: string;
  cooldownUntil: number;
  consecutiveFailures: number;
  lastError: string;
};

export type KeyPoolStatus = {
  total: number;
  available: number;
  cooling: { label: string; secondsLeft: number; reason: string }[];
};

import { publishCooldown } from "./cooldown";

const MINUTE = 60_000;
const COOLDOWN: Record<KeyFailure, number> = {
  "rate-limit": 65 * 1000, // free tier limits are per-minute
  "daily-quota": 6 * 60 * MINUTE,
  invalid: 24 * 60 * MINUTE, // a bad key will not fix itself
  server: 15 * 1000, // the provider's problem, not the key's
};

const MAX_SLOTS = 20;

export type KeyPool = {
  count: () => number;
  /** Keys not currently cooling down. This is what ordering should use. */
  available: () => number;
  /** Applies cooldowns recorded by other invocations. */
  applyCooldowns: (map: Record<string, number>) => void;
  status: () => KeyPoolStatus;
  keysToTry: () => KeyState[];
  reset: () => void;
};

/**
 * @param prefix env var base name, e.g. "GEMINI_API_KEY" — reads that name
 *   plus the numbered slots `${prefix}_1` … `${prefix}_20`.
 */
export function createKeyPool(prefix: string): KeyPool {
  let pool: KeyState[] | null = null;
  let cursor = 0;

  function collect(): KeyState[] {
    const found = new Map<string, string>();

    const primary = process.env[prefix]?.trim();
    if (primary) found.set(primary, prefix);

    for (let i = 1; i <= MAX_SLOTS; i++) {
      const name = `${prefix}_${i}`;
      const value = process.env[name]?.trim();
      // Keys duplicated across slots would double-count a single quota.
      if (value && !found.has(value)) found.set(value, name);
    }

    return [...found.entries()].map(([key, label]) => ({
      key,
      label,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastError: "",
    }));
  }

  function get(): KeyState[] {
    if (!pool) pool = collect();
    return pool;
  }

  return {
    count: () => get().length,

    available() {
      const now = Date.now();
      return get().filter((k) => k.cooldownUntil <= now).length;
    },

    applyCooldowns(map) {
      for (const state of get()) {
        const until = map[state.label];
        // Only ever extend: this invocation may know about a failure
        // the shared copy has not caught up with.
        if (typeof until === "number" && until > state.cooldownUntil) {
          state.cooldownUntil = until;
        }
      }
    },

    reset() {
      pool = null;
      cursor = 0;
    },

    status() {
      const now = Date.now();
      const keys = get();
      return {
        total: keys.length,
        available: keys.filter((k) => k.cooldownUntil <= now).length,
        cooling: keys
          .filter((k) => k.cooldownUntil > now)
          .map((k) => ({
            label: k.label,
            secondsLeft: Math.ceil((k.cooldownUntil - now) / 1000),
            reason: k.lastError,
          })),
      };
    },

    /**
     * Keys to try for one request, best first: available keys in round-robin
     * order, then cooled-down keys soonest-to-recover as a last resort. The
     * fallback tail matters — when every key is rate limited, one stale attempt
     * beats failing without trying.
     */
    keysToTry() {
      const keys = get();
      if (!keys.length) return [];

      const now = Date.now();
      const start = cursor % keys.length;
      cursor = (cursor + 1) % keys.length;

      const rotated = [...keys.slice(start), ...keys.slice(0, start)];
      const available = rotated.filter((k) => k.cooldownUntil <= now);
      const cooling = rotated
        .filter((k) => k.cooldownUntil > now)
        .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

      return [...available, ...cooling];
    },
  };
}

export function markFailure(
  state: KeyState,
  failure: KeyFailure,
  detail: string,
  retryAfterMs?: number,
) {
  state.consecutiveFailures += 1;
  state.lastError = detail.slice(0, 120);
  state.cooldownUntil = Date.now() + Math.max(retryAfterMs ?? 0, COOLDOWN[failure]);

  // The next invocation starts with a blank pool, so a cooldown only means
  // anything if it is written somewhere shared.
  void publishCooldown(state.label, state.cooldownUntil);
}

export function markSuccess(state: KeyState) {
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.lastError = "";
}

export const geminiPool = createKeyPool("GEMINI_API_KEY");
export const groqPool = createKeyPool("GROQ_API_KEY");
export const cerebrasPool = createKeyPool("CEREBRAS_API_KEY");

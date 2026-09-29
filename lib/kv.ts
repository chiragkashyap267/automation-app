/**
 * Tiny Upstash Redis client over their REST API.
 *
 * Telegram delivers every screenshot as its own request, and a serverless
 * function remembers nothing between them — so batching several drafts behind
 * one Send-all button needs somewhere shared to put them.
 *
 * Deliberately no SDK: two env vars and fetch. Everything degrades gracefully
 * when it is not configured, and the bot falls back to one button per draft.
 */

const URL_ENV = "UPSTASH_REDIS_REST_URL";
const TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";

export function kvConfigured(): boolean {
  return Boolean(process.env[URL_ENV]?.trim() && process.env[TOKEN_ENV]?.trim());
}

async function command<T>(args: (string | number)[]): Promise<T | null> {
  const url = process.env[URL_ENV]?.trim();
  const token = process.env[TOKEN_ENV]?.trim();
  if (!url || !token) return null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args.map(String)),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[kv]", res.status, (await res.text()).slice(0, 160));
      return null;
    }
    const body = (await res.json()) as { result?: T; error?: string };
    if (body.error) {
      console.error("[kv]", body.error.slice(0, 160));
      return null;
    }
    return (body.result ?? null) as T | null;
  } catch (err) {
    // The store being down must never stop an email being drafted.
    console.error("[kv] unreachable", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const raw = await command<string>(["GET", key]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  const ok = await command<string>(["SET", key, JSON.stringify(value), "EX", ttlSeconds]);
  return ok === "OK";
}

export async function kvDelete(key: string): Promise<void> {
  await command(["DEL", key]);
}

/** Increments a counter and gives it a TTL on first use. Returns the new value. */
export async function kvIncrement(key: string, ttlSeconds: number): Promise<number | null> {
  const value = await command<number>(["INCR", key]);
  if (value === null) return null;
  if (value === 1) await command(["EXPIRE", key, ttlSeconds]);
  return value;
}

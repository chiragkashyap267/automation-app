import { kvConfigured, kvIncrement } from "./kv";

/**
 * Guards the endpoints that spend API quota.
 *
 * A browser app cannot hold a secret — anything in the bundle is public — so
 * this is a password the user types once and the browser remembers. The
 * password itself lives only in an environment variable on the server.
 *
 * Rate limiting by IP runs regardless, as a second line: it caps the damage
 * from a leaked password and from a mistake in the app's own retry logic.
 */

export const PASSWORD_HEADER = "x-app-password";

const HOURLY_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR ?? 60);
const WINDOW_SECONDS = 60 * 60;

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

export function passwordRequired(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

async function withinRateLimit(request: Request): Promise<boolean> {
  if (!kvConfigured()) return true; // nothing to count with

  const ip = clientIp(request);
  const bucket = `rl:${ip}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
  const used = await kvIncrement(bucket, WINDOW_SECONDS);

  // A store failure must not lock the owner out of their own app.
  if (used === null) return true;
  return used <= HOURLY_LIMIT;
}

/** Call at the top of any route that spends tokens. */
export async function guard(request: Request): Promise<AuthResult> {
  const expected = process.env.APP_PASSWORD?.trim();

  if (expected) {
    const given = request.headers.get(PASSWORD_HEADER)?.trim();
    if (given !== expected) {
      return { ok: false, status: 401, error: "Wrong or missing app password." };
    }
  } else {
    // Unset means the deployment is open to anyone who finds the URL.
    console.warn("[auth] APP_PASSWORD is not set — AI endpoints are unprotected");
  }

  if (!(await withinRateLimit(request))) {
    return {
      ok: false,
      status: 429,
      error: `More than ${HOURLY_LIMIT} requests in an hour from this address. Try again later.`,
    };
  }

  return { ok: true };
}

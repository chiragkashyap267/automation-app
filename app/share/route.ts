import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A safety net under the share target.
 *
 * Shares are meant to be caught by the service worker, which keeps the
 * screenshot and redirects. This only runs when the worker is not active
 * yet — the very first share after installing, or after the browser has
 * evicted it. Without it that share would land on a 404, which looks like
 * the app is broken rather than merely not ready.
 *
 * The files cannot be recovered here, so it says so rather than pretending.
 */
export async function POST(request: Request) {
  return NextResponse.redirect(new URL("/?shared=cold", request.url), 303);
}

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/", request.url), 307);
}

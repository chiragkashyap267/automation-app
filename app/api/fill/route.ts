import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { isFillKind } from "@/lib/fillKinds";
import {
  fillMemoryAvailable,
  learn,
  learnedFor,
  normalizeLabel,
  unlearn,
  type Correction,
} from "@/lib/fillMemory";
import { MAX_FIELDS, UnknownFieldSchema, resolveFields, resolversAvailable } from "@/lib/fillResolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The part of the form filler that is not in the browser.
 *
 * Two jobs, and they are the difference between a lookup table and
 * something that gets better: classify a label nobody wrote a rule for,
 * and remember a correction so the same mistake is not made twice.
 *
 * Note what does not cross this boundary. The extension sends labels and
 * receives field names. It never sends the values it is about to type,
 * and it never asks what to type — the profile stays in the browser, and
 * a form being filled on a careers page is not described to anyone.
 */

const ResolveBody = z.object({
  /** The page being filled, so a lesson can be filed against the site. */
  host: z.string().default(""),
  fields: z.array(UnknownFieldSchema).default([]),
});

export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const body = ResolveBody.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "Unexpected request shape." }, { status: 400 });

  const { host, fields } = body.data;

  // What has already been learned, first: it is free, instant, and it
  // outranks the model because a person corrected it on purpose.
  const learned = await learnedFor(host);

  const unresolved = fields.filter((field) => !learned[normalizeLabel(field.label)]);

  if (!unresolved.length) {
    return NextResponse.json({ learned, resolved: [], asked: 0 });
  }
  if (!resolversAvailable()) {
    return NextResponse.json({
      learned,
      resolved: [],
      asked: 0,
      note: "No key that can classify fields is set, so only learned labels were used.",
    });
  }

  try {
    const resolved = await resolveFields(unresolved);
    return NextResponse.json({
      learned,
      resolved,
      asked: Math.min(unresolved.length, MAX_FIELDS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The learned map is still worth returning: a model outage should
    // degrade the fill, not stop it.
    return NextResponse.json({ learned, resolved: [], asked: 0, error: message });
  }
}

const LearnBody = z.object({
  host: z.string().default(""),
  corrections: z
    .array(z.object({ label: z.string(), kind: z.string() }))
    .default([]),
  /** Labels whose stored lesson turned out to be wrong. */
  forget: z.array(z.string()).default([]),
});

/** Records what you corrected, so it is not got wrong again. */
export async function PUT(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  if (!fillMemoryAvailable()) {
    return NextResponse.json({ ok: false, reason: "no-store" });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const body = LearnBody.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "Unexpected request shape." }, { status: 400 });

  const { host, corrections, forget } = body.data;

  const usable: Correction[] = corrections
    .filter((c) => isFillKind(c.kind))
    .map((c) => ({ label: c.label, kind: c.kind as Correction["kind"] }));

  const remembered = await learn(host, usable);
  let forgotten = 0;
  for (const label of forget) {
    if (await unlearn(host, label)) forgotten++;
  }

  return NextResponse.json({ ok: true, remembered, forgotten });
}

/** Everything learned for a host, for showing what it has picked up. */
export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const host = new URL(request.url).searchParams.get("host") ?? "";
  return NextResponse.json({
    learned: await learnedFor(host),
    canLearn: fillMemoryAvailable(),
    canResolve: resolversAvailable(),
  });
}

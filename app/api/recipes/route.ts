import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { loadSharedRecipes, saveSharedRecipes, sharedRecipesAvailable } from "@/lib/sharedRecipes";
import type { Recipe } from "@/lib/recipeCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mirrors the browser's learned recipes so the Telegram bot can render from
 * them instead of paying for a write every time.
 */
export async function POST(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  if (!sharedRecipesAvailable()) return NextResponse.json({ ok: false, reason: "no-store" });

  let body: { recipes?: Recipe[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const recipes = Array.isArray(body.recipes) ? body.recipes : [];
  // An empty list would wipe the bot's only copy; that is never an edit the
  // user meant to make from here.
  if (!recipes.length) return NextResponse.json({ ok: false, reason: "empty" });

  return NextResponse.json({ ok: await saveSharedRecipes(recipes) });
}

export async function GET(request: Request) {
  const allowed = await guard(request);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  return NextResponse.json({ recipes: await loadSharedRecipes() });
}

import { kvConfigured, kvGet, kvSet } from "./kv";
import type { Recipe } from "./recipeCore";

/**
 * The browser's recipes, mirrored where the bot can read them.
 *
 * Recipes are learned in the web app — that is where drafts get edited, and
 * an edit is the signal a recipe learns from. The bot has no browser, so
 * until now it re-wrote every email from scratch and the whole caching layer
 * did nothing for the surface actually being used.
 *
 * The browser stays the owner. This is a one-way mirror, so a bot that
 * cannot reach the store simply pays for a write, which is what it did
 * before anyway.
 */

const KEY = "recipes:v1";
const TTL = 180 * 24 * 60 * 60;
const MAX = 40;

export const sharedRecipesAvailable = kvConfigured;

export async function saveSharedRecipes(recipes: Recipe[]): Promise<boolean> {
  if (!kvConfigured()) return false;

  const trimmed = [...recipes]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX);

  return kvSet(KEY, trimmed, TTL);
}

export async function loadSharedRecipes(): Promise<Recipe[]> {
  if (!kvConfigured()) return [];
  return (await kvGet<Recipe[]>(KEY)) ?? [];
}

"use client";

import { authHeaders } from "./appPassword";
import type { Facts } from "./llm/prompt";
import {
  CLEAN_THRESHOLD,
  deriveRecipe,
  editRatio,
  familyKey,
  findRecipe,
  hashInput,
  isSettled,
  profileFingerprint,
  RECIPE_DEFAULTS,
  renderRecipe,
  describeFamily,
  type Recipe,
} from "./recipeCore";

// The rules live in recipeCore so the bot can use them too; this module adds
// the browser's storage on top and re-exports them unchanged.
export {
  hashInput,
  deriveRecipe,
  editRatio,
  familyKey,
  findRecipe,
  isSettled,
  profileFingerprint,
  renderRecipe,
  describeFamily,
};
export type { Recipe };

export type CachedExtract = {
  hash: string;
  jobs: Facts[];
  at: number;
};

const RECIPES_KEY = "jdmailer.recipes.v1";
const CACHE_KEY = "jdmailer.extractcache.v1";
const MAX_RECIPES = 40;
const MAX_CACHE = 60;
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

export type SendRecord = {
  facts: Facts;
  originalSubject: string;
  originalBody: string;
  sentSubject: string;
  sentBody: string;
};

/**
 * Called after an email actually goes out. The version that was sent is the
 * verified one, so it — not the model's first attempt — becomes the recipe.
 * That is what makes the templates converge on how the user actually writes.
 */
export function recordSend(record: SendRecord): Recipe | null {
  const { facts, originalBody, sentSubject, sentBody } = record;
  const ratio = editRatio(originalBody, sentBody);
  const clean = ratio <= CLEAN_THRESHOLD;

  const recipes = loadRecipes();
  const key = familyKey(facts);
  const fresh = deriveRecipe(facts, sentSubject, sentBody);
  const existing = recipes.find((r) => r.key === key);
  const now = Date.now();

  if (!existing) {
    const created: Recipe = {
      ...fresh,
      sends: 1,
      sentClean: clean ? 1 : 0,
      sentEdited: clean ? 0 : 1,
      cleanStreak: clean ? 1 : 0,
      lastEditRatio: ratio,
      lastRefinedAt: now,
    };
    recipes.push(created);
    saveRecipes(recipes);
    return created;
  }

  existing.sends += 1;
  existing.lastEditRatio = ratio;
  existing.lastUsedAt = now;

  if (clean) {
    existing.sentClean += 1;
    existing.cleanStreak += 1;
  } else {
    // The user corrected it, so adopt their wording and start the streak again.
    existing.sentEdited += 1;
    existing.cleanStreak = 0;
    existing.subjectTemplate = fresh.subjectTemplate;
    existing.bodyTemplate = fresh.bodyTemplate;
    existing.sourceCompany = facts.company;
    existing.sourceRole = facts.role;
    existing.lastRefinedAt = now;
  }

  saveRecipes(recipes);
  return existing;
}

export function deleteRecipe(key: string) {
  saveRecipes(loadRecipes().filter((r) => r.key !== key));
}



/**
 * The recipe layer: once the model has written one email for, say, a mid-level
 * React frontend role, the next posting in that same family is rendered from
 * the stored template locally — no API call, no wait, no quota.
 *
 * Everything here runs in the browser and persists in localStorage.
 */

/* ───────────────────────── storage ───────────────────────── */

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — the feature degrades to "no cache" */
  }
}

export function loadRecipes(): Recipe[] {
  // Recipes saved by an earlier version lack the stats fields.
  return readJson<Recipe[]>(RECIPES_KEY, []).map((r) => ({ ...RECIPE_DEFAULTS, ...r }));
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Pushes the recipes to the server so the bot can render from them rather
 * than paying for a write. Debounced, because a single run of the pipeline
 * refines several of them in a row.
 */
function queueRecipeMirror(recipes: Recipe[]) {
  if (typeof window === "undefined" || !recipes.length) return;
  if (mirrorTimer) clearTimeout(mirrorTimer);

  mirrorTimer = setTimeout(() => {
    void fetch("/api/recipes", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ recipes }),
      // Failing to mirror only costs the bot an API call.
    }).catch(() => {});
  }, 3000);
}

export function saveRecipes(recipes: Recipe[]) {
  const trimmed = [...recipes]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECIPES);
  writeJson(RECIPES_KEY, trimmed);
  queueRecipeMirror(trimmed);
}

export function rememberRecipe(
  facts: Facts,
  subject: string,
  body: string,
  fingerprint = "",
): Recipe[] {
  const recipes = loadRecipes();
  const fresh = deriveRecipe(facts, subject, body, fingerprint);
  const existing = recipes.find((r) => r.key === fresh.key);

  if (existing) {
    existing.subjectTemplate = fresh.subjectTemplate;
    existing.bodyTemplate = fresh.bodyTemplate;
    existing.lastUsedAt = Date.now();
    // Rewritten from a newer profile: the streak it built no longer
    // describes this wording.
    if (existing.profileFingerprint !== fingerprint) {
      existing.profileFingerprint = fingerprint;
      existing.cleanStreak = 0;
    }
  } else {
    recipes.push(fresh);
  }

  saveRecipes(recipes);
  return loadRecipes();
}

export function noteRecipeUse(key: string) {
  const recipes = loadRecipes();
  const hit = recipes.find((r) => r.key === key);
  if (!hit) return;
  hit.uses += 1;
  hit.lastUsedAt = Date.now();
  saveRecipes(recipes);
}

/* ───────────────────────── input cache ───────────────────────── */

/** FNV-1a — fast, dependency-free, and good enough to key a local cache. */
export function readExtractCache(hash: string): Facts[] | null {
  const entries = readJson<CachedExtract[]>(CACHE_KEY, []);
  const hit = entries.find((e) => e.hash === hash);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) return null;
  return hit.jobs;
}

export function writeExtractCache(hash: string, jobs: Facts[]) {
  const entries = readJson<CachedExtract[]>(CACHE_KEY, []).filter((e) => e.hash !== hash);
  entries.unshift({ hash, jobs, at: Date.now() });
  writeJson(CACHE_KEY, entries.slice(0, MAX_CACHE));
}

export function clearRecipeData() {
  try {
    window.localStorage.removeItem(RECIPES_KEY);
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

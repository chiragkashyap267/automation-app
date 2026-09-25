"use client";

import type { Facts } from "./llm/prompt";

/**
 * The recipe layer: once the model has written one email for, say, a mid-level
 * React frontend role, the next posting in that same family is rendered from
 * the stored template locally — no API call, no wait, no quota.
 *
 * Everything here runs in the browser and persists in localStorage.
 */

export type Recipe = {
  key: string;
  subjectTemplate: string;
  bodyTemplate: string;
  sourceCompany: string;
  sourceRole: string;
  /** Times this recipe was used to render a draft. */
  uses: number;
  /** Emails actually sent from this recipe. */
  sends: number;
  /** Of those, how many went out exactly as generated. */
  sentClean: number;
  sentEdited: number;
  /** Consecutive sends with no edit — three in a row means settled. */
  cleanStreak: number;
  /** How much of the last sent email the user rewrote, 0-1. */
  lastEditRatio: number;
  createdAt: number;
  lastUsedAt: number;
  lastRefinedAt: number;
};

const RECIPE_DEFAULTS = {
  uses: 0,
  sends: 0,
  sentClean: 0,
  sentEdited: 0,
  cleanStreak: 0,
  lastEditRatio: 0,
  lastRefinedAt: 0,
};

/** Three clean sends in a row: the wording has stopped needing changes. */
export function isSettled(recipe: Recipe): boolean {
  return recipe.cleanStreak >= 3;
}

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

/* ───────────────────────── family classification ───────────────────────── */

const FAMILIES: [string, RegExp][] = [
  ["frontend", /\b(frontend|front-end|front end|ui engineer|react|angular|vue|svelte)\b/i],
  ["backend", /\b(backend|back-end|back end|api engineer|server[- ]side|microservice)\b/i],
  ["fullstack", /\b(full[- ]?stack|mern|mean)\b/i],
  ["mobile", /\b(android|ios|mobile|flutter|react native|kotlin|swift)\b/i],
  ["ml", /\b(machine learning|ml engineer|deep learning|nlp|computer vision|ai engineer)\b/i],
  ["data", /\b(data (engineer|analyst|scientist)|analytics|etl|bi |power bi|tableau)\b/i],
  ["devops", /\b(devops|sre|site reliability|infrastructure|platform engineer|cloud engineer)\b/i],
  ["qa", /\b(qa|quality assurance|test(ing)? engineer|sdet|automation tester)\b/i],
  ["security", /\b(security|infosec|penetration|soc analyst|appsec)\b/i],
  ["design", /\b(designer|ux|ui\/ux|product design|graphic)\b/i],
  ["product", /\b(product manager|product owner|program manager|business analyst)\b/i],
];

const STACKS =
  /\b(react native|react|angular|vue|svelte|next\.?js|node\.?js|node|express|django|flask|fastapi|spring|laravel|rails|dotnet|\.net|python|java|golang|go|rust|php|ruby|typescript|javascript|kotlin|swift|flutter|kubernetes|docker|aws|azure|gcp|postgres(ql)?|mysql|mongodb|sql)\b/gi;

function normalizeSeniority(value: string): string {
  const v = value.toLowerCase();
  if (/intern|trainee|fresher/.test(v)) return "intern";
  if (/junior|entry|associate|0-2|1-2/.test(v)) return "junior";
  if (/lead|principal|staff|head|manager|architect/.test(v)) return "lead";
  if (/senior|sr\b|5\+|6\+|7\+/.test(v)) return "senior";
  return "mid";
}

/** Two postings sharing this key get the same email skeleton. */
export function familyKey(facts: Facts): string {
  const haystack = `${facts.role} ${facts.highlights.join(" ")}`;

  let family = "other";
  for (const [name, pattern] of FAMILIES) {
    if (pattern.test(haystack)) {
      family = name;
      break;
    }
  }

  const stacks = [...new Set((haystack.match(STACKS) ?? []).map((s) => s.toLowerCase()))]
    .sort()
    .slice(0, 2);

  return `${family}|${stacks.join("+") || "general"}|${normalizeSeniority(
    `${facts.seniority} ${facts.role}`,
  )}`;
}

/* ───────────────────────── template derivation ───────────────────────── */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slotify(text: string, facts: Facts): string {
  let out = text;

  const swaps: [string, string][] = [
    // Longest first: a req id can contain the company name, and role text can
    // contain the location, so a shorter swap must not eat the longer one.
    [facts.reqId, "{{reqId}}"],
    [facts.company, "{{company}}"],
    [facts.role, "{{role}}"],
    [facts.location, "{{location}}"],
  ];
  for (const [value, slot] of swaps) {
    const trimmed = value.trim();
    if (trimmed.length < 2) continue;
    out = out.replace(new RegExp(escapeRegex(trimmed), "gi"), slot);
  }

  // The salutation is the one line that must always match the new posting.
  const contact = facts.contactName.trim();
  if (contact.length >= 2) {
    out = out.replace(new RegExp(escapeRegex(contact), "gi"), "{{contact}}");
  } else {
    out = out.replace(/\bHiring Team\b/gi, "{{contact}}");
  }

  return out;
}

export function deriveRecipe(facts: Facts, subject: string, body: string): Recipe {
  const now = Date.now();
  return {
    ...RECIPE_DEFAULTS,
    key: familyKey(facts),
    subjectTemplate: slotify(subject, facts),
    bodyTemplate: slotify(body, facts),
    sourceCompany: facts.company,
    sourceRole: facts.role,
    createdAt: now,
    lastUsedAt: now,
  };
}

/**
 * How much of `before` was rewritten to get `after`, 0 (identical) to 1
 * (nothing in common). Compared word by word via a longest-common-subsequence,
 * which is cheap at email length and ignores pure reflowing.
 */
export function editRatio(before: string, after: string): number {
  const a = before.trim().split(/\s+/).filter(Boolean);
  const b = after.trim().split(/\s+/).filter(Boolean);
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 1;

  // Rolling two-row LCS table.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }

  const common = prev[b.length];
  return 1 - (2 * common) / (a.length + b.length);
}

/** Below this, a difference is whitespace or a word — not a real rewrite. */
const CLEAN_THRESHOLD = 0.02;

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

const FAMILY_LABEL: Record<string, string> = {
  frontend: "Frontend",
  backend: "Backend",
  fullstack: "Full-stack",
  mobile: "Mobile",
  ml: "ML / AI",
  data: "Data",
  devops: "DevOps",
  qa: "QA",
  security: "Security",
  design: "Design",
  product: "Product",
  other: "Other",
};

/** Turns "frontend|react+typescript|mid" into "Frontend · React, TypeScript · Mid". */
export function describeFamily(key: string): string {
  const [family, stacks, seniority] = key.split("|");
  const parts = [FAMILY_LABEL[family] ?? family];
  if (stacks && stacks !== "general") {
    parts.push(stacks.split("+").map((s) => s.replace(/^./, (c) => c.toUpperCase())).join(", "));
  }
  if (seniority) parts.push(seniority.replace(/^./, (c) => c.toUpperCase()));
  return parts.join(" · ");
}

export function deleteRecipe(key: string) {
  saveRecipes(loadRecipes().filter((r) => r.key !== key));
}

export function renderRecipe(recipe: Recipe, facts: Facts): { subject: string; body: string } {
  const fill = (template: string) =>
    template
      .replace(/\{\{company\}\}/g, facts.company || "your team")
      .replace(/\{\{role\}\}/g, facts.role || "the role")
      .replace(/\{\{location\}\}/g, facts.location || "")
      .replace(/\{\{contact\}\}/g, facts.contactName.trim() || "Hiring Team")
      .replace(/\{\{reqId\}\}/g, facts.reqId || "")
      // An empty slot can leave "Engineer ()" or "based in  ." behind.
      .replace(/\(\s*\)/g, "")
      .replace(/\[\s*\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([.,])/g, "$1")
      .replace(/[ \t]*[-–—][ \t]*$/gm, "")
      .trimEnd();

  return { subject: fill(recipe.subjectTemplate), body: fill(recipe.bodyTemplate) };
}

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

export function saveRecipes(recipes: Recipe[]) {
  const trimmed = [...recipes]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECIPES);
  writeJson(RECIPES_KEY, trimmed);
}

export function findRecipe(recipes: Recipe[], facts: Facts): Recipe | null {
  const key = familyKey(facts);
  return recipes.find((r) => r.key === key) ?? null;
}

/** Newly written email becomes (or refreshes) the recipe for its family. */
export function rememberRecipe(facts: Facts, subject: string, body: string): Recipe[] {
  const recipes = loadRecipes();
  const fresh = deriveRecipe(facts, subject, body);
  const existing = recipes.find((r) => r.key === fresh.key);

  if (existing) {
    existing.subjectTemplate = fresh.subjectTemplate;
    existing.bodyTemplate = fresh.bodyTemplate;
    existing.lastUsedAt = Date.now();
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
export function hashInput(images: { data: string }[], texts: string[]): string {
  const payload = [...images.map((i) => i.data), ...texts].join("\u0000");
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${payload.length.toString(36)}`;
}

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

import type { Facts } from "./llm/prompt";

/**
 * The recipe logic itself: classification, slotting, rendering, matching.
 *
 * Split out from lib/recipes because that module is "use client" and keeps
 * its recipes in localStorage. The bot has no browser and no localStorage,
 * so anything it needs to reuse has to live in a module a route handler can
 * import. The storage of recipes differs between the two halves; the rules
 * for what a recipe is and when it applies must not.
 */

/** Three clean sends in a row: the wording has stopped needing changes. */
export const CLEAN_THRESHOLD = 0.02;

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
  /**
   * Which version of the profile this wording came from. A recipe stores the
   * prose verbatim, so anything the profile says about the candidate — years
   * of experience, the headline, the resume itself — is frozen into it. When
   * the profile changes the recipe is stale, and reusing it would quietly
   * send last month's claims.
   */
  profileFingerprint: string;
};

export const RECIPE_DEFAULTS = {
  profileFingerprint: "",
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
/**
 * A short digest of everything in the profile that shapes the wording.
 *
 * Contact details and the Gmail password are left out: changing a phone
 * number does not make a stored email wrong, and throwing away every recipe
 * over it would cost API calls for nothing.
 */
export function profileFingerprint(profile: {
  fullName?: string;
  headline?: string;
  yearsExperience?: string;
  skills?: string;
  resumeText?: string;
  extraNotes?: string;
  tone?: string;
  signOff?: string;
}): string {
  const material = [
    profile.fullName,
    profile.headline,
    profile.yearsExperience,
    profile.skills,
    profile.resumeText,
    profile.extraNotes,
    profile.tone,
    profile.signOff,
  ]
    .map((v) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");

  // djb2: short, stable across reloads, and collisions only cost a stale
  // recipe surviving one edit.
  let hash = 5381;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

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

export function deriveRecipe(
  facts: Facts,
  subject: string,
  body: string,
  fingerprint = "",
): Recipe {
  const now = Date.now();
  return {
    ...RECIPE_DEFAULTS,
    profileFingerprint: fingerprint,
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

export function findRecipe(
  recipes: Recipe[],
  facts: Facts,
  fingerprint?: string,
): Recipe | null {
  const key = familyKey(facts);
  const match = recipes.find((r) => r.key === key);
  if (!match) return null;

  // A recipe written from a different profile is not free, it is wrong.
  // Letting it through is how an edited profile keeps sending old claims.
  if (fingerprint !== undefined && match.profileFingerprint !== fingerprint) return null;

  return match;
}

/** Newly written email becomes (or refreshes) the recipe for its family. */

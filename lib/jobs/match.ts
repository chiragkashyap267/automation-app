import type { Profile } from "../types";
import type { Match, Posting, Tier } from "./types";

/**
 * Deciding which of several thousand openings are worth your morning.
 *
 * A watcher that forwards everything is worse than no watcher: you stop
 * reading it inside a week. So the default is to reject, and a posting has
 * to earn its way in on three counts — a technical role, a seniority band
 * you could actually be hired into, and somewhere in India.
 *
 * All of it is heuristic and all of it is tunable. The scoring is kept
 * legible rather than clever so that a wrong call can be argued with.
 */

/** The band being hired into. Narrow on purpose: 1-3 years. */
export const MIN_YEARS = 1;
export const MAX_YEARS = 3;

/** Delhi NCR first, then the southern hubs, then anywhere in India. */
const NCR = ["noida", "gurgaon", "gurugram", "delhi", "ncr", "faridabad", "ghaziabad"];
const SOUTH = ["bengaluru", "bangalore", "hyderabad", "chennai", "pune", "kochi", "coimbatore", "trivandrum", "thiruvananthapuram", "mysuru", "mysore"];
const REST_OF_INDIA = ["india", "mumbai", "kolkata", "ahmedabad", "jaipur", "indore", "chandigarh", "mohali", "bhubaneswar", "nagpur", "vadodara"];
const INDIAN_PLACES = [...NCR, ...SOUTH, ...REST_OF_INDIA];

/**
 * A role has to look like one of these to get through at all.
 *
 * An allowlist rather than a keyword score, because the failure that
 * actually matters is a digest full of sales and warehouse jobs from a
 * company whose board happens to be public.
 */
const TECH_TITLES = [
  "software engineer",
  "software developer",
  "software development engineer",
  "sde",
  "associate engineer",
  "engineer trainee",
  "graduate engineer",
  "member of technical staff",
  "programmer",
  "developer",
  "frontend",
  "front end",
  "front-end",
  "backend",
  "back end",
  "back-end",
  "full stack",
  "fullstack",
  "full-stack",
  "web developer",
  "application developer",
  "ui developer",
  "ui engineer",
  "ux engineer",
  "mobile developer",
  "android",
  "ios engineer",
  "react native",
  "qa engineer",
  "quality engineer",
  "test engineer",
  "automation engineer",
  "sdet",
  "devops",
  "site reliability",
  "platform engineer",
  "cloud engineer",
  "infrastructure engineer",
  "data engineer",
  "data analyst",
  "analytics engineer",
  "machine learning engineer",
  "ml engineer",
  "ai engineer",
  "security engineer",
  "network engineer",
  "systems engineer",
  "support engineer",
  "technical support",
  "database",
  "salesforce developer",
  "technical analyst",
  "system analyst",
  "integration engineer",

  // --- named stacks, which is how smaller firms advertise ---
  "react developer",
  "angular developer",
  "vue developer",
  "node developer",
  "java developer",
  "python developer",
  "php developer",
  "laravel",
  "wordpress",
  "shopify developer",
  ".net developer",
  "dotnet",
  "golang",
  "mern",
  "mean stack",
  "flutter",
  "unity developer",

  // --- IT operations and infrastructure ---
  "it support",
  "it executive",
  "it engineer",
  "it analyst",
  "it administrator",
  "it operations",
  "service desk",
  "help desk",
  "helpdesk",
  "desktop support",
  "system administrator",
  "systems administrator",
  "sysadmin",
  "network administrator",
  "server administrator",
  "linux administrator",
  "windows administrator",
  "cloud administrator",
  "database administrator",
  "noc engineer",
  "soc analyst",
  "security analyst",
  "implementation engineer",
  "deployment engineer",
  "production support",
  "application support",
  "product support",

  // --- testing, data and the analyst track ---
  "software tester",
  "manual tester",
  "qa analyst",
  "quality analyst",
  "test analyst",
  "business analyst",
  "data scientist",
  "bi developer",
  "etl developer",
  "mis executive",
  "technical writer",

  // --- design roles that sit next to the front end ---
  "web designer",
  "ui designer",
  "ux designer",
  "ui/ux",
  "product designer",
];

/**
 * Never a technical job, however the title is dressed up.
 *
 * Matched on whole words. A substring test rejected every "Salesforce
 * Developer" on the strength of the "sales" inside it.
 */
const WRONG_FUNCTION = new RegExp(
  "\\b(" +
    [
      "sales",
      "account executive",
      "business development",
      "pre-?sales",
      "warehouse",
      "driver",
      "accountant",
      "accounts payable",
      "collections",
      "payroll",
      "recruiter",
      "recruitment",
      "talent acquisition",
      "legal",
      "paralegal",
      "facilities",
      "marketing",
      "content writer",
      "copywriter",
      "customer success",
      "test employee",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * Seniority words, and the years of experience each one really wants.
 *
 * The most senior word in a title wins, so "Senior Associate" is read as
 * senior rather than talked down by the "associate" next to it.
 */
const SENIORITY: [RegExp, number][] = [
  [/\b(intern|internship|apprentice)\b/i, 0],
  [/\b(trainee|graduate|fresher|entry[- ]level)\b/i, 0],
  [/\b(junior|jr\.?|associate)\b/i, 1],
  [/\b(senior|sr\.?|sse)\b/i, 5],
  // Indian IT grades for an experienced individual contributor.
  [/\b(specialist|consultant)\b/i, 5],
  [/\b(staff|principal|architect)\b/i, 8],
  [/\b(lead|tl|stl|manager|mgr|head of|director|vp|vice president|chief)\b/i, 8],
];

/** "3-5 years" or "5+ years" written into the title itself. */
const YEARS_IN_TITLE = /(\d+)\s*(?:\+|\s*-\s*\d+)?\s*(?:years?|yrs?)/i;

/** Roman and arabic grades: "Engineer II" is still junior, "IV" is not. */
const GRADE: [RegExp, number][] = [
  [/\b(?:i|1)\b/i, 0],
  [/\b(?:ii|2)\b/i, 2],
  [/\b(?:iii|3)\b/i, 4],
  [/\b(?:iv|4|v|5)\b/i, 7],
];

/**
 * Skills rarely appear in a job title, so each one vouches for the title
 * words that do. "react" on the resume is what lifts "Frontend Engineer"
 * above a generic match.
 */
const FAMILIES: Record<string, string[]> = {
  react: ["frontend", "front end", "react", "ui", "web developer"],
  "next.js": ["frontend", "react", "full stack", "web developer"],
  nextjs: ["frontend", "react", "full stack"],
  javascript: ["frontend", "javascript", "web developer", "full stack"],
  typescript: ["frontend", "typescript", "full stack"],
  node: ["backend", "node", "full stack", "api"],
  "node.js": ["backend", "node", "full stack"],
  html: ["frontend", "web developer", "ui developer"],
  css: ["frontend", "web developer", "ui developer"],
  tailwind: ["frontend", "ui developer"],
  python: ["backend", "python", "data", "automation"],
  java: ["backend", "java", "software engineer"],
  sql: ["data", "analyst", "database"],
  mongodb: ["backend", "database", "node"],
  git: [],
};

function lower(value: string): string {
  return value.toLowerCase();
}

/** Years from a free-text field like "1.5 years" or "2-3". */
export function parseYears(raw: string): number {
  const match = /(\d+(?:\.\d+)?)/.exec(raw ?? "");
  return match ? Number(match[1]) : 0;
}

/** Terms from the resume that make a matching title score higher. */
export function wantedTerms(profile: Profile): string[] {
  const terms = new Set<string>();

  for (const raw of (profile.skills ?? "").split(/[,;\n]/)) {
    const skill = lower(raw).trim();
    if (!skill) continue;
    terms.add(skill);
    for (const extra of FAMILIES[skill] ?? []) terms.add(extra);
  }

  for (const word of lower(profile.headline ?? "").split(/[^a-z.+#]+/)) {
    if (word.length > 3) terms.add(word);
  }

  return [...terms];
}

/** Is this a technical role at all? */
export function isTechRole(role: string): boolean {
  if (WRONG_FUNCTION.test(role)) return false;
  const r = lower(role);
  return TECH_TITLES.some((good) => r.includes(good));
}

/**
 * Words that describe how you work rather than where, plus the punctuation
 * boards glue locations together with. What is left after removing them is
 * a real place or nothing at all.
 */
const NOT_A_PLACE = /\b(remote|hybrid|on[- ]?site|onsite|work from home|wfh|anywhere|global|flexible|multiple locations|various)\b/gi;

/** Which tier the posting sits in, or null when it is definitely not India. */
export function indiaTier(posting: Posting): Tier | null {
  const where = lower(posting.location);

  if (NCR.some((p) => where.includes(p))) return "ncr";
  if (SOUTH.some((p) => where.includes(p))) return "south";
  if (REST_OF_INDIA.some((p) => where.includes(p))) return "india";

  // Everything left either names a place that is not in India, or says
  // nothing about place at all. "Bengaluru; Remote" was caught above;
  // "Hybrid" and "" tell us nothing, and a bare city tells us it is
  // somewhere else. Only the first of those is worth keeping.
  const residue = where.replace(NOT_A_PLACE, " ").replace(/[^a-z]+/g, " ").trim();
  return residue ? null : "unknown";
}

/** Words that mark a role as entry level whatever else the title says. */
const JUNIOR_MARKER = /\b(associate|junior|jr\.?|trainee|graduate|fresher|entry)\b/i;
/** Words no junior marker can talk down. */
const TRULY_SENIOR = /\b(senior|sr\.?|sse|staff|principal|architect|lead|tl|stl|manager|mgr|head of|director|vp|vice president|chief)\b/i;

/**
 * The experience a title implies: the most senior reading of it.
 *
 * "Senior Associate" is senior. "Associate Technical Consultant" is not a
 * consultant's job — the grade word in front of it is the real one.
 */
export function impliedYears(role: string): number {
  // A grade is only a grade once the years phrase is out of the way,
  // otherwise "3 years" reads as "Engineer III".
  const withoutYears = role.replace(new RegExp(YEARS_IN_TITLE, "gi"), " ");

  let years = 0;
  for (const [pattern, wants] of SENIORITY) {
    if (pattern.test(role)) years = Math.max(years, wants);
  }
  for (const [pattern, wants] of GRADE) {
    if (pattern.test(withoutYears)) years = Math.max(years, wants);
  }

  if (JUNIOR_MARKER.test(role) && !TRULY_SENIOR.test(role)) return Math.min(years, 2);
  return years;
}

/** Does the title imply experience inside the band being hired into? */
export function seniorityFits(role: string, maxYears = MAX_YEARS): boolean {
  const explicit = YEARS_IN_TITLE.exec(role);
  if (explicit && Number(explicit[1]) > maxYears) return false;
  return impliedYears(role) <= maxYears;
}

/**
 * Score a posting, or reject it.
 *
 * Returns null for anything that should never reach the digest, so the
 * caller never has to re-apply the rules.
 */
export function scorePosting(posting: Posting, profile: Profile, terms: string[]): Match | null {
  if (!isTechRole(posting.role)) return null;

  const tier = indiaTier(posting);
  if (!tier) return null;

  if (!seniorityFits(posting.role)) return null;

  const role = lower(posting.role);
  let score = 20; // cleared every gate

  const hits = terms.filter((t) => t.length > 2 && role.includes(t));
  score += hits.length * 10;

  // Explicitly junior titles are the target, not a consolation.
  if (/\b(associate|junior|jr\.?|graduate|trainee|entry)\b/i.test(posting.role)) score += 20;

  if (tier === "ncr") score += 30;
  else if (tier === "south") score += 15;

  // A posting whose board never says where the work is could be anywhere
  // on earth. Worth showing, never worth showing first.
  if (tier === "unknown") score -= 35;

  // Freshness is the whole point of a watcher: a month-old posting has
  // already been seen by everyone who was going to see it.
  const ageDays = posting.postedAt ? (Date.now() - posting.postedAt) / 86_400_000 : 99;
  if (ageDays <= 3) score += 25;
  else if (ageDays <= 7) score += 15;
  else if (ageDays <= 21) score += 5;

  if (/\bremote\b/.test(lower(posting.location))) score += 10;
  if (posting.description) score += 5;

  const reason = [
    hits.slice(0, 3).join(", ") || "tech role",
    posting.location || "location not stated",
    ageDays < 90 ? `${Math.max(0, Math.round(ageDays))}d old` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return { posting, score, tier, reason };
}

/**
 * The gates that depend only on the title.
 *
 * Separated out because they are free, while learning where a job really
 * is can cost a request. Thousands of postings are rejected here so that
 * only a handful ever need looking up.
 */
export function passesRoleGates(role: string): boolean {
  return isTechRole(role) && seniorityFits(role);
}

/** Big employers post one role against many requisition numbers. */
export function dedupeKey(posting: Posting): string {
  return `${lower(posting.company)}|${lower(posting.role).replace(/[^a-z0-9]+/g, " ").trim()}`;
}

/** One row per real opening, newest copy of each, nothing scored yet. */
export function collapseDuplicates(postings: Posting[]): Posting[] {
  const best = new Map<string, Posting>();
  for (const posting of postings) {
    const key = dedupeKey(posting);
    const seen = best.get(key);
    if (!seen || posting.postedAt > seen.postedAt) best.set(key, posting);
  }
  return [...best.values()];
}

/**
 * One row per real opening, best first.
 *
 * Duplicate requisitions collapse to the best-scoring copy, so a company
 * advertising the same role eight times takes one line, not eight.
 */
export function rank(postings: Posting[], profile: Profile): Match[] {
  const terms = wantedTerms(profile);

  const best = new Map<string, Match>();
  for (const posting of postings) {
    const match = scorePosting(posting, profile, terms);
    if (!match) continue;
    const key = dedupeKey(posting);
    const seen = best.get(key);
    if (!seen || match.score > seen.score) best.set(key, match);
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

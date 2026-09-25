import type { Facts } from "./llm/prompt";

/**
 * Rule-based reader for pasted job text. No API call, no wait, no quota.
 *
 * It only claims a result when the signals are strong — an email address plus
 * something that looks like a role — and returns null otherwise so the caller
 * falls back to the model. Everything it produces is shown in the preview for
 * the user to correct before anything is sent.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Postings routinely write addresses as "name [at] co [dot] com" to dodge scrapers. */
function deobfuscate(text: string): string {
  // Bracketed forms are unambiguous: "name [at] co [dot] com".
  const bracketed = text
    .replace(/\s*[[({<]\s*(at|@)\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[[({<]\s*(dot|\.)\s*[\])}>]\s*/gi, ".");

  // The bare-word forms are not. "Email your CV to Rahul Mehta at
  // rahul.mehta@cloudmint.io" would otherwise become "Mehta@rahul.mehta",
  // which is a real address shape and would actually be mailed. So only fall
  // back to them when the text holds no usable address yet.
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(bracketed)) return bracketed;

  return bracketed
    .replace(/(^|\s)([A-Za-z0-9._%+-]+)\s+\bat\b\s+(?=[A-Za-z0-9-]+(?:\s+\bdot\b\s+|\.)[A-Za-z]{2,})/gi, "$1$2@")
    .replace(/\s+\bdot\b\s+/gi, ".");
}

const JUNK_EMAIL =
  /(example|test|yourname|youremail|domain|company)\.(com|org|net)$|\.(png|jpg|jpeg|gif|webp|svg)$|^(noreply|no-reply|donotreply)@/i;

const LABEL_PATTERNS: Record<string, RegExp> = {
  role: /^\s*(?:job\s*)?(?:role|position|title|designation|profile|opening|vacancy)\s*[:\-–]\s*(.+)$/im,
  company: /^\s*(?:company|organi[sz]ation|employer|firm|startup)\s*(?:name)?\s*[:\-–]\s*(.+)$/im,
  location: /^\s*(?:location|place|city|base|work\s*location)\s*[:\-–]\s*(.+)$/im,
  experience: /^\s*(?:experience|exp|yoe)\s*[:\-–]\s*(.+)$/im,
};

const ROLE_WORDS =
  /\b(engineer|developer|designer|analyst|manager|architect|consultant|specialist|administrator|scientist|intern|lead|associate|executive|tester|programmer)\b/i;

const TECH =
  /\b(react native|react|angular|vue|svelte|next\.?js|node\.?js|node|express|django|flask|fastapi|spring boot|spring|laravel|rails|\.net|dotnet|python|java|golang|go|rust|php|ruby|typescript|javascript|kotlin|swift|flutter|android|ios|kubernetes|docker|aws|azure|gcp|postgresql|postgres|mysql|mongodb|redis|graphql|rest api|sql|figma|tailwind|git)\b/gi;

/** Requisition IDs: "REQ-4471", "JR12345", "Job ID: 8891", "#8891". */
const REQ_ID =
  /\b(?:req(?:uisition)?[ .#:-]*(?:id|no\.?|number)?|job[ .#:-]*(?:id|code|ref(?:erence)?)|position[ .#:-]*id)[ .#:-]*([A-Z0-9][A-Z0-9-]{2,15})\b/i;
const REQ_ID_BARE = /\b((?:REQ|JR|JOB|RQ)-?\d{3,10})\b/i;

const SENIORITY: [string, RegExp][] = [
  ["intern", /\b(intern|internship|trainee|fresher)\b/i],
  ["lead", /\b(lead|principal|staff|head of|architect)\b/i],
  ["senior", /\b(senior|sr\.?)\b/i],
  ["junior", /\b(junior|jr\.?|entry[- ]level|graduate)\b/i],
];

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** A recruiting address rarely names the company; the domain almost always does. */
function companyFromEmail(email: string): string {
  const domain = email.split("@")[1] ?? "";
  const generic = /^(gmail|yahoo|outlook|hotmail|protonmail|icloud|rediffmail|zoho)\./i;
  if (!domain || generic.test(domain)) return "";

  const label = domain.split(".")[0];
  if (!label || label.length < 2 || /^(mail|jobs|careers|hr|info|apply)$/i.test(label)) return "";
  return titleCase(label.replace(/[-_]/g, " "));
}

/** "backend engineer with 2-5 years of experience" is a sentence, not a title. */
function trimRole(value: string): string {
  return value
    .split(/\s+(?:with|who|to|having|for|that|and)\s+/i)[0]
    .trim()
    .replace(/[.,;:]$/, "")
    .slice(0, 60)
    .trim();
}

function findRole(text: string, lines: string[]): string {
  const labelled = text.match(LABEL_PATTERNS.role);
  if (labelled) return labelled[1].trim().replace(/[.,;]$/, "").slice(0, 80);

  const hiringFor = text.match(
    /\b(?:hiring|looking|searching|urgent(?:ly)? (?:hiring|required))\s+(?:for\s+)?(?:an?\s+)?([A-Za-z0-9/+.\- ]{4,60})/i,
  );
  if (hiringFor && ROLE_WORDS.test(hiringFor[1])) {
    return trimRole(hiringFor[1]);
  }

  // Otherwise the first short line that reads like a job title.
  const candidate = lines.find((l) => l.length <= 70 && ROLE_WORDS.test(l) && !EMAIL_RE.test(l));
  return candidate ? candidate.replace(/[.,;:]$/, "").trim() : "";
}

export function localExtract(rawText: string): Facts | null {
  const text = deobfuscate(rawText);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const recipients = [...new Set(text.match(EMAIL_RE) ?? [])]
    .map((e) => e.toLowerCase().replace(/[.,;]$/, ""))
    .filter((e) => !JUNK_EMAIL.test(e));

  const role = findRole(text, lines);

  // Without both an address and a role there is nothing worth guessing at.
  if (!recipients.length || !role) return null;

  const company =
    text.match(LABEL_PATTERNS.company)?.[1]?.trim().replace(/[.,;]$/, "").slice(0, 60) ||
    companyFromEmail(recipients[0]);

  const location =
    text.match(LABEL_PATTERNS.location)?.[1]?.trim().replace(/[.,;]$/, "").slice(0, 60) ||
    (/\bremote\b/i.test(text) ? "Remote" : "") ||
    (/\bhybrid\b/i.test(text) ? "Hybrid" : "");

  const highlights = [...new Set((text.match(TECH) ?? []).map((t) => t.toLowerCase()))]
    .slice(0, 5)
    .map(titleCase);

  const reqId = (text.match(REQ_ID_BARE)?.[1] ?? text.match(REQ_ID)?.[1] ?? "")
    .trim()
    .toUpperCase();

  const experience = text.match(LABEL_PATTERNS.experience)?.[1]?.trim() ?? "";
  let seniority = "";
  for (const [name, pattern] of SENIORITY) {
    if (pattern.test(`${role} ${experience} ${text.slice(0, 400)}`)) {
      seniority = name;
      break;
    }
  }

  const missing: string[] = [];
  if (!company) missing.push("company name");
  if (!highlights.length) missing.push("required skills");

  return {
    company,
    role,
    location,
    reqId,
    recipients,
    contactName: "",
    highlights,
    seniority,
    confidence: company && highlights.length ? "medium" : "low",
    notes: missing.length
      ? `Read locally without AI — could not find the ${missing.join(" or ")}. Check before sending.`
      : "Read locally without AI. Check the details before sending.",
  };
}

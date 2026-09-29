import type { Draft, Profile } from "./types";

/**
 * Checks every draft before it can go out.
 *
 * Errors block Send all — they are things that would embarrass you if they
 * landed in a recruiter's inbox. Warnings are shown and can be ignored.
 *
 * Most issues carry a `fix`, so the UI can repair them in one tap.
 */

export type Issue = {
  id: string;
  severity: "error" | "warning";
  message: string;
  /** Literal find/replace that repairs this issue in the body. */
  fix?: { find: string; replace: string };
};

/** Misspellings that survive a spell-checker-free workflow. */
const MISSPELLINGS: Record<string, string> = {
  teh: "the",
  thier: "their",
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperately: "separately",
  definately: "definitely",
  occured: "occurred",
  occuring: "occurring",
  accomodate: "accommodate",
  acheive: "achieve",
  acheived: "achieved",
  achive: "achieve",
  beleive: "believe",
  buisness: "business",
  calender: "calendar",
  collegue: "colleague",
  collegues: "colleagues",
  comming: "coming",
  commited: "committed",
  concious: "conscious",
  dependant: "dependent",
  developement: "development",
  enviroment: "environment",
  enviroments: "environments",
  experiance: "experience",
  experiances: "experiences",
  familier: "familiar",
  flexable: "flexible",
  garantee: "guarantee",
  goverment: "government",
  greatful: "grateful",
  immediatly: "immediately",
  independant: "independent",
  knowlege: "knowledge",
  liason: "liaison",
  maintainance: "maintenance",
  managment: "management",
  neccessary: "necessary",
  necesary: "necessary",
  occassion: "occasion",
  oppurtunity: "opportunity",
  opertunity: "opportunity",
  oppertunity: "opportunity",
  particulary: "particularly",
  perseverence: "perseverance",
  personel: "personnel",
  posession: "possession",
  practicle: "practical",
  prefered: "preferred",
  priviledge: "privilege",
  proffesional: "professional",
  profesional: "professional",
  programing: "programming",
  recomend: "recommend",
  recomended: "recommended",
  refered: "referred",
  relevent: "relevant",
  responsable: "responsible",
  sucessful: "successful",
  succesful: "successful",
  sucessfully: "successfully",
  suprise: "surprise",
  tommorrow: "tomorrow",
  truely: "truly",
  untill: "until",
  useage: "usage",
  wich: "which",
  writting: "writing",
  alot: "a lot",
  ofcourse: "of course",
  atleast: "at least",
  eventhough: "even though",
  incharge: "in charge",
  inspite: "in spite",
  goodfit: "good fit",
};

/** Technology names that look sloppy in lower case. */
const TECH_CASING: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  nodejs: "Node.js",
  reactjs: "React",
  react: "React",
  nextjs: "Next.js",
  angular: "Angular",
  vue: "Vue",
  github: "GitHub",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  mongodb: "MongoDB",
  postgresql: "PostgreSQL",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  graphql: "GraphQL",
  kubernetes: "Kubernetes",
  docker: "Docker",
  devops: "DevOps",
  python: "Python",
  django: "Django",
  flask: "Flask",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  flutter: "Flutter",
  android: "Android",
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  api: "API",
  apis: "APIs",
  css: "CSS",
  html: "HTML",
  sql: "SQL",
  json: "JSON",
  saas: "SaaS",
  ui: "UI",
  ux: "UX",
};

const PLACEHOLDER = /\[(?:your|company|role|name|position|title|insert|add|x{2,})[^\]]*\]|\bTODO\b|\bTBD\b|\bXXX\b/i;
const UNRENDERED_SLOT = /\{\{\s*\w+\s*\}\}/;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;
const SALUTATION = /^\s*(dear|hi|hello|greetings)\b/i;

function hostOf(value: string): string {
  const raw = value.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return raw.split(/[/?#]/)[0].toLowerCase();
}

/** Every host the candidate legitimately links to. */
function ownHosts(profile: Profile): Set<string> {
  const hosts = new Set<string>();
  for (const link of [profile.linkedin, profile.github, profile.portfolio]) {
    const host = hostOf(link);
    if (host) hosts.add(host);
  }
  const domain = profile.email.split("@")[1];
  if (domain) hosts.add(domain.toLowerCase());
  return hosts;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateDraft(draft: Draft, profile: Profile): Issue[] {
  const issues: Issue[] = [];
  const body = draft.body;
  const push = (i: Issue) => issues.push(i);

  /* ── blocking ── */

  if (!draft.recipients.length) {
    push({ id: "no-recipient", severity: "error", message: "No recipient address." });
  }
  if (!draft.subject.trim()) {
    push({ id: "no-subject", severity: "error", message: "Subject is empty." });
  }
  if (!body.trim()) {
    push({ id: "no-body", severity: "error", message: "The email body is empty." });
  }

  const placeholder = body.match(PLACEHOLDER) ?? draft.subject.match(PLACEHOLDER);
  if (placeholder) {
    push({
      id: "placeholder",
      severity: "error",
      message: `Unfilled placeholder: ${placeholder[0]}`,
    });
  }

  const slot = body.match(UNRENDERED_SLOT) ?? draft.subject.match(UNRENDERED_SLOT);
  if (slot) {
    push({
      id: "unrendered-slot",
      severity: "error",
      message: `A recipe slot did not fill in: ${slot[0]}`,
    });
  }

  // A link the candidate does not own is almost always invented.
  const mine = ownHosts(profile);
  for (const url of body.match(URL_IN_TEXT) ?? []) {
    const host = hostOf(url);
    if (host && !mine.has(host)) {
      push({
        id: `foreign-link:${host}`,
        severity: "error",
        message: `"${url}" is not one of your links. Remove it or fix it in Details.`,
      });
    }
  }

  /* ── advisory ── */

  if (!SALUTATION.test(body)) {
    push({
      id: "no-salutation",
      severity: "warning",
      message: 'The email does not open with a greeting such as "Dear ...".',
    });
  }

  if (draft.contactName.trim() && /\bHiring Team\b/i.test(body)) {
    push({
      id: "generic-salutation",
      severity: "warning",
      message: `The posting names ${draft.contactName} but the email says "Hiring Team".`,
      fix: { find: "Hiring Team", replace: draft.contactName.trim() },
    });
  }

  if (draft.company.trim() && !body.toLowerCase().includes(draft.company.trim().toLowerCase())) {
    push({
      id: "no-company",
      severity: "warning",
      message: `The email never mentions ${draft.company}.`,
    });
  }

  // Thresholds bracket the 60-90 words the writer is asked for.
  const words = countWords(body);
  if (words && words < 40) {
    push({ id: "too-short", severity: "warning", message: `Only ${words} words — quite thin.` });
  }
  if (words > 150) {
    push({
      id: "too-long",
      severity: "warning",
      message: `${words} words — long for a cold email. Aim for under 100.`,
    });
  }
  if (draft.subject.length > 90) {
    push({
      id: "long-subject",
      severity: "warning",
      message: `Subject is ${draft.subject.length} characters — it will be cut off on mobile.`,
    });
  }

  const haystack = `${draft.subject}\n${body}`;

  for (const [wrong, right] of Object.entries(MISSPELLINGS)) {
    const re = new RegExp(`\\b${wrong}\\b`, "i");
    const hit = haystack.match(re);
    if (hit) {
      push({
        id: `spelling:${wrong}`,
        severity: "warning",
        message: `"${hit[0]}" → "${right}"`,
        fix: { find: hit[0], replace: right },
      });
    }
  }

  // Only flag lower-case tech names in running prose, never inside a URL or address.
  for (const [lower, proper] of Object.entries(TECH_CASING)) {
    const re = new RegExp(`(^|[^\\w./@-])(${lower})(?![\\w./@-])`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      if (match[2] !== proper) {
        push({
          id: `casing:${lower}`,
          severity: "warning",
          message: `"${match[2]}" → "${proper}"`,
          fix: { find: match[0], replace: `${match[1]}${proper}` },
        });
        break;
      }
    }
  }

  // "had had" and "that that" are grammatical; every other repeat is a slip.
  const LEGITIMATE_DOUBLES = new Set(["had", "that"]);
  const doubled = body.match(/\b(\w{2,})\s+\1\b/i);
  if (doubled && !LEGITIMATE_DOUBLES.has(doubled[1].toLowerCase())) {
    push({
      id: "doubled-word",
      severity: "warning",
      message: `Repeated word: "${doubled[0]}"`,
      fix: { find: doubled[0], replace: doubled[1] },
    });
  }

  const spaceBefore = body.match(/\s+[,.;:!?]/);
  if (spaceBefore) {
    push({
      id: "space-before-punctuation",
      severity: "warning",
      message: "There is a space before a punctuation mark.",
      fix: { find: spaceBefore[0], replace: spaceBefore[0].trim() },
    });
  }

  const shout = body.match(/[!?]{2,}/);
  if (shout) {
    push({
      id: "repeated-punctuation",
      severity: "warning",
      message: `"${shout[0]}" reads as shouting.`,
      fix: { find: shout[0], replace: shout[0][0] },
    });
  }

  const lowerStart = body.match(/(?:^|[.!?]\s+)([a-z]\w{2,})/);
  if (lowerStart) {
    push({
      id: "lowercase-sentence",
      severity: "warning",
      message: `A sentence starts in lower case: "${lowerStart[1]}"`,
      fix: {
        find: lowerStart[0],
        replace: lowerStart[0].replace(lowerStart[1], lowerStart[1][0].toUpperCase() + lowerStart[1].slice(1)),
      },
    });
  }

  if ((body.match(/\(/g) ?? []).length !== (body.match(/\)/g) ?? []).length) {
    push({ id: "unbalanced-parens", severity: "warning", message: "Unbalanced brackets." });
  }

  return issues;
}

/** Applies every repairable issue, in order, and returns the new body. */
export function applyFixes(body: string, issues: Issue[]): string {
  let out = body;
  for (const issue of issues) {
    if (!issue.fix) continue;
    out = out.replace(issue.fix.find, issue.fix.replace);
  }
  return out;
}

export function countBySeverity(issues: Issue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    fixable: issues.filter((i) => i.fix).length,
  };
}

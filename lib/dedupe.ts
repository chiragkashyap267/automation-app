import type { ReadJob } from "./llm";

/**
 * Collapses entries the reader split out of what was really one posting.
 *
 * Over-splitting is the damaging direction: several near-identical emails to
 * the same company in the same minute is what a recruiter sees as spam, and
 * what a mail provider sees as a sending pattern worth flagging. Two entries
 * that share a recipient, or share a company and role, are the same job.
 */
function sameCompanyAndRole(a: ReadJob, b: ReadJob): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const company = norm(a.company);
  return Boolean(company) && company === norm(b.company) && norm(a.role) === norm(b.role);
}

function sharesRecipient(a: ReadJob, b: ReadJob): boolean {
  const left = new Set(a.recipients.map((r) => r.toLowerCase()));
  return b.recipients.some((r) => left.has(r.toLowerCase()));
}

function merge(into: ReadJob, extra: ReadJob): ReadJob {
  return {
    ...into,
    // Keep whichever entry actually found each field.
    company: into.company || extra.company,
    role: into.role || extra.role,
    location: into.location || extra.location,
    reqId: into.reqId || extra.reqId,
    contactName: into.contactName || extra.contactName,
    recipients: [...new Set([...into.recipients, ...extra.recipients])],
    highlights: [...new Set([...into.highlights, ...extra.highlights])].slice(0, 6),
    notes: into.notes || extra.notes,
  };
}

export function dedupeJobs(jobs: ReadJob[]): ReadJob[] {
  const out: ReadJob[] = [];

  for (const job of jobs) {
    const existing = out.find((k) => sharesRecipient(k, job) || sameCompanyAndRole(k, job));
    if (existing) {
      Object.assign(existing, merge(existing, job));
      continue;
    }
    out.push({ ...job });
  }

  return out;
}

import type { Company, Posting, SourceKind } from "./types";

/**
 * Adapters for the job boards companies actually run on.
 *
 * Five adapters cover most of the market, so adding the hundredth company
 * is a config row rather than a hundredth scraper. Every one of these is a
 * public endpoint a careers page already calls from the browser: no key, no
 * login, and nothing that could put the Gmail or LinkedIn account at risk.
 *
 * Each adapter is written to fail quietly. One company changing its board
 * must not take the morning digest down with it.
 */

const TIMEOUT_MS = 15_000;

/** A browser-ish agent. Some boards refuse the default fetch signature. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Epoch ms from whatever shape the board uses, or 0 when it says nothing. */
function when(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
};

async function greenhouse(c: Company): Promise<Posting[]> {
  const data = await getJson<{ jobs?: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`,
  );
  return (data?.jobs ?? []).map((j) => ({
    id: `greenhouse:${c.slug}:${j.id}`,
    source: "greenhouse" as const,
    company: c.name,
    role: j.title?.trim() ?? "",
    location: j.location?.name?.trim() ?? "",
    postedAt: when(j.first_published ?? j.updated_at),
    applyUrl: j.absolute_url,
  }));
}

type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  categories?: { location?: string; allLocations?: string[] };
};

async function lever(c: Company): Promise<Posting[]> {
  const data = await getJson<LeverJob[]>(
    `https://api.lever.co/v0/postings/${c.slug}?mode=json`,
  );
  if (!Array.isArray(data)) return [];
  return data.map((j) => ({
    id: `lever:${c.slug}:${j.id}`,
    source: "lever" as const,
    company: c.name,
    role: j.text?.trim() ?? "",
    location: (j.categories?.allLocations ?? []).join("; ") || (j.categories?.location ?? ""),
    postedAt: when(j.createdAt),
    applyUrl: j.hostedUrl,
    // The only source that hands over the whole posting free.
    description: j.descriptionPlain?.trim() || undefined,
  }));
}

type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  isListed?: boolean;
  isRemote?: boolean;
  /** Ashby often files India as a second location, not the first. */
  secondaryLocations?: { location?: string }[];
};

async function ashby(c: Company): Promise<Posting[]> {
  const data = await getJson<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${c.slug}`,
  );
  return (data?.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: `ashby:${c.slug}:${j.id}`,
      source: "ashby" as const,
      company: c.name,
      role: j.title?.trim() ?? "",
      location: [
        j.location?.trim(),
        ...(j.secondaryLocations ?? []).map((s) => s.location?.trim()),
        j.isRemote ? "Remote" : "",
      ]
        .filter(Boolean)
        .join("; "),
      postedAt: when(j.publishedAt),
      applyUrl: j.jobUrl || j.applyUrl || "",
      description: j.descriptionPlain?.trim() || undefined,
    }));
}

type SmartJob = {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  company?: { identifier?: string };
};

/**
 * The one source that filters by country on the server, so we ask it to.
 * Everything else is filtered after the fetch.
 */
async function smartrecruiters(c: Company): Promise<Posting[]> {
  const out: Posting[] = [];
  // Paged, 100 at a time, capped so one huge employer cannot stall the run.
  for (let offset = 0; offset < 400; offset += 100) {
    const data = await getJson<{ content?: SmartJob[]; totalFound?: number }>(
      `https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?country=in&limit=100&offset=${offset}`,
    );
    const page = data?.content ?? [];
    for (const j of page) {
      const loc = j.location ?? {};
      const bits = [loc.city, loc.region].filter(Boolean).join(", ");
      out.push({
        id: `smartrecruiters:${c.slug}:${j.id}`,
        source: "smartrecruiters" as const,
        company: c.name,
        role: j.name?.trim() ?? "",
        location: loc.remote ? `${bits || "India"} (remote)` : bits || "India",
        postedAt: when(j.releasedDate),
        applyUrl: `https://jobs.smartrecruiters.com/${j.company?.identifier ?? c.slug}/${j.id}`,
      });
    }
    if (page.length < 100) break;
  }
  return out;
}

/**
 * SAP SuccessFactors sites (HCLTech and many other Indian employers) publish
 * every live job in sitemap.xml, titled in the URL slug and dated. No API,
 * but the sitemap is the employer's own index, kept current for Google.
 */
async function successfactors(c: Company): Promise<Posting[]> {
  const xml = await getText(`https://${c.slug}/sitemap.xml`);
  if (!xml) return [];

  const out: Posting[] = [];
  const entry = /<url>(.*?)<\/url>/gs;
  for (const m of xml.matchAll(entry)) {
    const block = m[1];
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (!loc) continue;
    const job = /\/job\/([^/]+)\/(\d+)\/?$/.exec(loc);
    if (!job) continue;
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1];
    out.push({
      id: `successfactors:${c.slug}:${job[2]}`,
      source: "successfactors" as const,
      company: c.name,
      // The slug is the title, hyphenated by the board.
      role: decodeURIComponent(job[1]).replace(/-/g, " ").trim(),
      // Sitemaps carry no location. The title often does; the filter copes.
      location: "",
      postedAt: when(lastmod),
      applyUrl: loc,
    });
  }
  return out;
}

const ADAPTERS: Record<SourceKind, (c: Company) => Promise<Posting[]>> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  successfactors,
};

/** Everything one company currently has open. Never throws. */
export async function fetchCompany(c: Company): Promise<Posting[]> {
  try {
    const found = await ADAPTERS[c.via](c);
    return found.filter((p) => p.role && p.applyUrl);
  } catch (err) {
    console.error(`[jobs] ${c.name} (${c.via}) failed`, err);
    return [];
  }
}

/**
 * All companies, a few at a time.
 *
 * Serverless gives us one CPU and a wall clock, so the limit that matters is
 * concurrent sockets, not cores. Eight keeps a hundred companies inside a
 * cron window without any one board seeing a burst it could call abuse.
 */
export async function fetchAll(companies: Company[], concurrency = 8): Promise<Posting[]> {
  const out: Posting[] = [];
  const queue = [...companies];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      out.push(...(await fetchCompany(next)));
    }
  });

  await Promise.all(workers);
  return out;
}

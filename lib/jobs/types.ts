/**
 * Openings found by watching company career pages, rather than sent to you.
 *
 * Deliberately not a `ReadJob`. A posting found this way has no recipient —
 * a big company's portal is the only way in, and inventing an address to
 * write to would produce a dead letter and burn sending reputation for
 * nothing. What a posting carries instead is a link that applies.
 */
export type Posting = {
  /** Stable across runs. The dedupe key, so you never see one job twice. */
  id: string;
  /** Which adapter found it, for debugging a source that goes quiet. */
  source: SourceKind;
  company: string;
  role: string;
  /** As the employer writes it, e.g. "Bengaluru, India; Remote". */
  location: string;
  /** Epoch ms. Zero when the source does not say. */
  postedAt: number;
  /** Goes straight to the employer's own application form. */
  applyUrl: string;
  /**
   * Full posting text where the source gives it away free — Lever does.
   * Enough to draft from when an email address turns up inside it.
   */
  description?: string;
};

export type SourceKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "successfactors";

/** One row per company. Adding a company is adding one of these. */
export type Company = {
  /** Shown to you. The adapter's slug is often uglier than the real name. */
  name: string;
  via: SourceKind;
  /** Board slug for the API sources, hostname for sitemap ones. */
  slug: string;
};

/**
 * Where a posting sits, best to worst. "unknown" means the board never
 * said — the job may well be in India, but nothing here claims it is.
 */
export type Tier = "ncr" | "south" | "india" | "unknown";

/** A posting plus why it was kept, so a bad filter can be argued with. */
export type Match = {
  posting: Posting;
  score: number;
  tier: Tier;
  /** Human readable, e.g. "React, TypeScript · Noida". */
  reason: string;
};

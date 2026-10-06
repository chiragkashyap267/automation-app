/**
 * Deciding whether a share is worth anything.
 *
 * Sharing a LinkedIn post hands over a link, not the post. The page behind
 * that link shows a login wall to anyone who is not signed in — verified,
 * not assumed: a logged-out fetch returns the same boilerplate description
 * for every job on the site. So a bare link is a dead end, and saying so
 * immediately is better than sending it to a model that will invent a job
 * out of a URL.
 *
 * The test is deliberately crude, because the cost of being wrong is small
 * in both directions: a rejected share costs one screenshot, and an
 * accepted thin one is visible on screen before anything is sent.
 */

import { isReadableLinkedIn } from "./linkedin";

export type Share =
  | { kind: "usable"; text: string }
  /** A LinkedIn job or feed post: both readable, see lib/linkedin.ts. */
  | { kind: "linkedin"; url: string }
  | { kind: "link-only" }
  | { kind: "empty" };

/** A share that is nothing but a URL, with at most a word or two around it. */
const BARE_LINK = /^\s*\S*https?:\/\/\S+\s*$/;

/** Below this, there is not enough to write an application from. */
const ENOUGH_WORDS = 12;

export function classifyShare(...parts: (string | null | undefined)[]): Share {
  const text = parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) return { kind: "empty" };

  // Checked before the bare-link test. LinkedIn links are the ones worth
  // following: job listings and feed posts are both served to everyone.
  const link = /https?:\/\/\S+/.exec(text)?.[0];
  if (link && isReadableLinkedIn(link)) return { kind: "linkedin", url: link };

  if (BARE_LINK.test(text)) return { kind: "link-only" };

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < ENOUGH_WORDS) return { kind: "link-only" };

  return { kind: "usable", text };
}

/** What to tell someone whose share could not be used. */
export const LINK_ONLY_NOTE =
  "That share was only a link, and the page behind it needs a login. Screenshot the post and share that instead — it works the same way, in one tap.";

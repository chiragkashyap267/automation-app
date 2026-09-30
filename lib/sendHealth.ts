/**
 * Whether it is still safe to keep sending.
 *
 * Bounces are the signal mail providers weigh most heavily: a sender whose
 * mail keeps hitting dead addresses looks like someone working from a
 * scraped list, which is exactly what a run of misread screenshot addresses
 * produces. Nothing was using this before — the function existed and no
 * caller ever called it — so a bad run could quietly continue all day.
 *
 * Storage-free so both halves can ask: the browser over its history, the bot
 * over the server-side outbox.
 */

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

/** Below this there is not enough evidence to act on. */
const MIN_SAMPLE = 10;

/** Providers start reacting well before this; stopping here is generous. */
const HIGH_RATE = 0.2;

export type BounceHealth = {
  bounced: number;
  sent: number;
  rate: number;
  /** Bad enough to stop for. */
  high: boolean;
  message: string;
};

export function bounceHealth(
  rows: { sentAt: number; bounced?: boolean }[],
  now = Date.now(),
): BounceHealth {
  const recent = rows.filter((r) => now - r.sentAt <= WINDOW_DAYS * DAY);
  const bounced = recent.filter((r) => r.bounced).length;
  const rate = recent.length ? bounced / recent.length : 0;
  const high = recent.length >= MIN_SAMPLE && rate > HIGH_RATE;

  return {
    bounced,
    sent: recent.length,
    rate: Math.round(rate * 100),
    high,
    message: high
      ? `${bounced} of your last ${recent.length} emails bounced. That ratio is what makes a ` +
        `sender look like a scraped list, and it is the account at risk rather than the ` +
        `applications. Check the addresses that failed before sending more.`
      : "",
  };
}

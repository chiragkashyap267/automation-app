/**
 * Cleaning recipient addresses read off screenshots.
 *
 * OCR routinely glues the little envelope or contact icon next to an address
 * onto the address itself — "✉naincy.goel@x.com" comes back as
 * "Jnaincy.goel@x.com" or "画career@x.com". Sending to that address fails
 * silently: no bounce the user notices, no reply, no idea why.
 */

const NON_ASCII_EDGE = /^[^\x21-\x7E]+|[^\x21-\x7E]+$/g;
// A valid address never begins or ends with punctuation, trailing dot included.
const PUNCT_EDGE = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

export type CleanedRecipient = {
  address: string;
  /** True when the original looked like it carried an icon artifact. */
  suspicious: boolean;
};

export function cleanRecipient(raw: string): CleanedRecipient | null {
  let value = raw.trim().replace(NON_ASCII_EDGE, "").replace(PUNCT_EDGE, "");
  if (!value.includes("@")) return null;

  const local = value.split("@")[0];

  // Real addresses are almost always lower case. A single capital at the very
  // front, followed by lower case, is the signature of a glued-on icon —
  // and unlike a non-ASCII character it cannot be stripped with confidence,
  // because it might genuinely be part of the name. So it is flagged, not cut.
  const capitalPrefix = /^[A-Z][a-z]/.test(local) && !/[A-Z]/.test(local.slice(1));

  value = value.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return null;

  return { address: value, suspicious: capitalPrefix };
}

/** Cleans a list, drops what cannot be salvaged, and de-duplicates. */
export function cleanRecipients(raw: string[]): {
  addresses: string[];
  suspicious: string[];
} {
  const addresses: string[] = [];
  const suspicious: string[] = [];

  for (const entry of raw) {
    const cleaned = cleanRecipient(entry);
    if (!cleaned) continue;
    if (addresses.includes(cleaned.address)) continue;
    addresses.push(cleaned.address);
    if (cleaned.suspicious) suspicious.push(cleaned.address);
  }

  return { addresses, suspicious };
}

/** Generic mailboxes are the safe fallback when a personal one looks wrong. */
export function isGenericMailbox(address: string): boolean {
  const local = address.split("@")[0];
  return /^(careers?|jobs?|hr|hiring|recruit(ing|ment)?|apply|info|contact|talent|resume|cv)$/.test(
    local,
  );
}

/**
 * "careers@freshbite.in" -> "Freshbite". Generic hosts and role mailboxes
 * give nothing, because "Hr" is not a company name.
 */
export function companyFromEmail(email: string): string {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const generic = /^(gmail|yahoo|outlook|hotmail|protonmail|icloud|rediffmail|zoho)\./;
  if (!domain || generic.test(domain)) return "";

  const label = domain.split(".")[0];
  if (!label || label.length < 2 || /^(mail|jobs|careers|hr|info|apply|contact|recruit)$/.test(label)) {
    return "";
  }
  return label.replace(/[-_]/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

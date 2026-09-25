import type { Profile } from "./types";

const SIGNOFF_LINE =
  /^(best regards|warm regards|kind regards|regards|sincerely|yours sincerely|yours faithfully|thanks|thank you|best|cheers)[,.!]?\s*$/i;

/**
 * Models reach for typographic characters that plain-text email handles badly:
 * non-breaking hyphens render as boxes in some clients, and narrow no-break
 * spaces turn "40k" into "40 k". Curly quotes are left alone — they are fine in
 * UTF-8 mail and look more natural than straight ones.
 */
export function normalizePlainText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Narrow/non-breaking spaces vanish between a number and its unit,
      // and become ordinary spaces everywhere else.
      .replace(/(\d)[    ](?=[a-zA-Z](?![a-zA-Z]))/g, "$1")
      .replace(/[    ⁠]/g, " ")
      .replace(/[​-‍﻿]/g, "")
      .replace(/[‐‑]/g, "-")
      // The prompt forbids markdown, but strip any that slips through.
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^[ \t]*[*+]\s+/gm, "- ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Bare domains paste in constantly; make them clickable. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

/**
 * The signature is assembled here rather than by the model, so every email
 * carries the same correct phone, address and links — and editing the profile
 * updates every unsent draft without regenerating anything.
 */
export function buildSignature(profile: Profile): string {
  const lines: string[] = [];

  lines.push(`${profile.signOff.trim() || "Best regards"},`);
  if (profile.fullName.trim()) lines.push(profile.fullName.trim());
  if (profile.phone.trim()) lines.push(profile.phone.trim());
  if (profile.email.trim()) lines.push(profile.email.trim());

  const links: [string, string][] = [
    ["LinkedIn", profile.linkedin],
    ["GitHub", profile.github],
    ["Portfolio", profile.portfolio],
  ];
  for (const [label, value] of links) {
    const url = normalizeUrl(value);
    if (url) lines.push(`${label}: ${url}`);
  }

  return lines.join("\n");
}

/**
 * Drops a sign-off the model wrote anyway. Only looks in the tail of the body,
 * so a "Thanks" in the middle of a sentence is never mistaken for a sign-off.
 */
export function stripSignature(body: string): string {
  const lines = body.split("\n");
  const searchFrom = Math.max(0, Math.floor(lines.length * 0.5));

  for (let i = lines.length - 1; i >= searchFrom; i--) {
    if (SIGNOFF_LINE.test(lines[i])) {
      return lines.slice(0, i).join("\n").trimEnd();
    }
  }
  return body.trimEnd();
}

/** The exact text that gets sent. */
export function composeEmail(body: string, profile: Profile): string {
  return `${stripSignature(body)}\n\n${buildSignature(profile)}`;
}

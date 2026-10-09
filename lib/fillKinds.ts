/**
 * The vocabulary the form filler works in.
 *
 * The extension classifies a field by matching the words beside it against
 * a list of patterns, which handles the forms people have already seen. It
 * cannot handle the ones they have not: a portal that asks "Present
 * Employer Name" or "Total Relevant Exp. (Yrs)" falls through the list and
 * is reported as unrecognised.
 *
 * So an unrecognised label is sent to a model, which answers only the
 * question "what is this field asking for?" — and the answer has to be one
 * of these names. A free-text answer would be unusable: the extension has
 * to look the kind up in a table to know what to type.
 *
 * Kept here rather than in the extension because both sides need the same
 * list, and the server is the side that can be tested.
 */

/** Every kind a field can be. Must stay in step with extension/fields.js. */
export const FILL_KINDS = [
  // name
  "firstName",
  "lastName",
  "middleName",
  "preferredName",
  "fullName",
  // contact
  "email",
  "phone",
  "linkedin",
  "github",
  "portfolio",
  // where you are
  "location",
  "city",
  "state",
  "country",
  "postcode",
  "nationality",
  // work
  "experience",
  "currentCompany",
  "currentDesignation",
  "currentCtc",
  "expectedCtc",
  "noticePeriod",
  // education
  "tenthMarks",
  "tenthYear",
  "tenthBoard",
  "twelfthMarks",
  "twelfthYear",
  "twelfthBoard",
  "degree",
  "branch",
  "college",
  "gradMarks",
  "gradYear",
  // personal
  "dob",
  "gender",
  // documents and long answers
  "resume",
  "coverLetter",
  // things to recognise so they can be refused by name
  "pan",
  "aadhaar",
  "passport",
  "bank",
  "uan",
  "password",
  "captcha",
] as const;

export type FillKind = (typeof FILL_KINDS)[number];

const KIND_SET = new Set<string>(FILL_KINDS);

export function isFillKind(value: unknown): value is FillKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/**
 * Kinds that are never typed in, even when recognised.
 *
 * Two different reasons, and both matter. Money and notice periods are
 * decisions rather than recollections, and a salary figure cannot be
 * un-said once it is submitted. Government numbers and credentials are not
 * in the profile at all, and a wrong PAN can invalidate an application
 * outright — recognising one is still worth doing, because a field skipped
 * by name is a field you know to go back to.
 *
 * Mirrors NEVER_FILL in extension/fields.js, which is what enforces it.
 */
export const NEVER_FILL = new Set<FillKind>([
  "currentCtc",
  "expectedCtc",
  "noticePeriod",
  "pan",
  "aadhaar",
  "passport",
  "bank",
  "uan",
  "password",
  "captcha",
]);

/** Why a kind is left alone, for a report that can be acted on. */
export function refusalReason(kind: FillKind): string | null {
  if (!NEVER_FILL.has(kind)) return null;
  if (kind === "currentCtc" || kind === "expectedCtc") return "a salary figure cannot be un-said";
  if (kind === "noticePeriod") return "yours to decide";
  if (kind === "captcha") return "not something to automate";
  if (kind === "password") return "never stored here";
  return "a wrong one is worse than a blank";
}

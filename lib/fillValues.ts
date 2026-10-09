import { FILL_KINDS, NEVER_FILL, type FillKind } from "./fillKinds";
import type { Profile } from "./types";

/**
 * What to put in a field of each kind.
 *
 * Mirrors valueFor() in extension/fields.js, which is the copy that runs
 * in the page. Two implementations of the same rules is not ideal, but a
 * content script cannot import a TypeScript module and the alternative —
 * asking the server what to type into every box — would send the profile
 * to the server and back on every form. The tests check the two agree on
 * the cases that matter.
 */

/** First word of a name, and everything after it. */
export function splitName(fullName: string): { first: string; middle: string; last: string } {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", middle: "", last: "" };
  if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
  return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
}

/** The first recognisable city in a free-text location. */
export function cityFrom(location: string): string {
  return String(location || "").split(",")[0].trim();
}

/**
 * Country from a home address that rarely names one.
 *
 * "Noida, Uttar Pradesh" is an Indian address that never says India, and
 * every form asks for the country regardless.
 */
const INDIAN_HINT =
  /\b(india|andhra|arunachal|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|ncr|noida|gurgaon|gurugram|faridabad|ghaziabad|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|lucknow|indore|chandigarh|kochi|coimbatore|nagpur|bhopal|surat|visakhapatnam)\b/i;

export function countryFrom(location: string): string {
  return INDIAN_HINT.test(String(location || "")) ? "India" : "";
}

/**
 * Answers a form asks for that the app does not keep.
 *
 * Gender, date of birth and the whole education block are asked by nearly
 * every Indian portal and by nothing else in this app, so they are typed
 * once and stored on the device — in the extension's own storage on a
 * desktop, in the browser's on a phone. They are not sent anywhere.
 */
export const EXTRA_FIELDS = [
  "gender",
  "nationality",
  "country",
  "dob",
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
  "currentCompany",
  "currentDesignation",
] as const satisfies readonly FillKind[];

export type Extras = Partial<Record<FillKind, string>>;

export function valueFor(kind: FillKind, profile: Profile, extras: Extras = {}): string {
  const name = splitName(profile.fullName);

  // What the profile knows. Anything absent here falls through to the
  // extras, and three of them fall back the other way: an answer typed on
  // the device beats one worked out from the address.
  const fromProfile: Partial<Record<FillKind, string>> = {
    firstName: name.first,
    lastName: name.last,
    middleName: name.middle,
    preferredName: name.first,
    fullName: profile.fullName,
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.linkedin,
    github: profile.github,
    portfolio: profile.portfolio,
    experience: profile.yearsExperience,
    location: profile.location,
    city: cityFrom(profile.location),
    country: countryFrom(profile.location),
    nationality: countryFrom(profile.location),
    currentDesignation: profile.headline,
  };

  const value = extras[kind]?.trim() || fromProfile[kind] || "";
  return value.trim();
}

/** How a form would name each kind, for a sheet read beside one. */
export const KIND_LABELS: Record<FillKind, string> = {
  firstName: "First name",
  lastName: "Last name",
  middleName: "Middle name",
  preferredName: "Preferred name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn",
  github: "GitHub",
  portfolio: "Portfolio",
  location: "Location",
  city: "City",
  state: "State",
  country: "Country",
  postcode: "PIN code",
  nationality: "Nationality",
  experience: "Years of experience",
  currentCompany: "Current employer",
  currentDesignation: "Current designation",
  currentCtc: "Current CTC",
  expectedCtc: "Expected CTC",
  noticePeriod: "Notice period",
  tenthMarks: "10th marks",
  tenthYear: "10th passing year",
  tenthBoard: "10th board",
  twelfthMarks: "12th marks",
  twelfthYear: "12th passing year",
  twelfthBoard: "12th board",
  degree: "Degree",
  branch: "Branch",
  college: "College",
  gradMarks: "Graduation marks",
  gradYear: "Graduation year",
  dob: "Date of birth",
  gender: "Gender",
  resume: "Resume",
  coverLetter: "Cover letter",
  pan: "PAN",
  aadhaar: "Aadhaar",
  passport: "Passport",
  bank: "Bank details",
  uan: "UAN",
  password: "Password",
  captcha: "Captcha",
};

/**
 * The order a form asks for things.
 *
 * Not alphabetical and not the order they are stored: a sheet is read
 * while scrolling a form, so it is worth the little effort to put them in
 * the order the form will want them.
 */
const SHEET_ORDER: FillKind[] = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "dob",
  "gender",
  "location",
  "city",
  "state",
  "country",
  "nationality",
  "linkedin",
  "github",
  "portfolio",
  "experience",
  "currentCompany",
  "currentDesignation",
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
];

export type Answer = { kind: FillKind; label: string; value: string };

/**
 * Every answer there is something to say for, in form order.
 *
 * Blanks are left out rather than shown empty: a sheet of mostly nothing
 * is harder to use than a short one, and an empty row invites pasting an
 * empty string over a field that had a default.
 */
export function buildAnswers(profile: Profile, extras: Extras = {}): Answer[] {
  return SHEET_ORDER.filter((kind) => !NEVER_FILL.has(kind))
    .map((kind) => ({ kind, label: KIND_LABELS[kind], value: valueFor(kind, profile, extras) }))
    .filter((answer) => answer.value !== "");
}

/** Which answers are missing, so the sheet can say what to go and fill in. */
export function missingAnswers(profile: Profile, extras: Extras = {}): FillKind[] {
  return SHEET_ORDER.filter(
    (kind) => !NEVER_FILL.has(kind) && !valueFor(kind, profile, extras),
  );
}

/** Guards against a kind being added to the vocabulary and never labelled. */
export function unlabelledKinds(): FillKind[] {
  return FILL_KINDS.filter((kind) => !KIND_LABELS[kind]);
}

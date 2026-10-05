/**
 * Working out what a form field is asking for.
 *
 * Deliberately not a list of CSS selectors per employer. Application forms
 * are rendered by JavaScript and their markup changes without notice, but
 * the words next to a box do not: a field labelled "First Name" wants a
 * first name on every site there has ever been. Matching on the label is
 * what lets this work on a form nobody has seen before.
 *
 * Kept free of DOM access so it can be tested without a browser.
 */
(function (root) {
  "use strict";

  /** Turns "legalNameSection_firstName" or "First Name *" into "first name". */
  function normalizeLabel(raw) {
    return String(raw || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase
      .replace(/[_\-.]+/g, " ") // snake_case, kebab-case, dotted ids
      .replace(/[*:?]/g, " ")
      .replace(/\(.*?\)/g, " ") // "(optional)"
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * Field kinds, most specific first.
   *
   * Order is the whole trick: "first name" and "last name" both contain
   * "name", so a plain "name" test has to come last or it swallows them.
   */
  const KINDS = [
    ["firstName", /\b(first|given|fore)\s*name\b/],
    ["lastName", /\b(last|sur|family)\s*name\b/],
    ["middleName", /\bmiddle\s*name\b/],
    ["preferredName", /\b(preferred|nick)\s*name\b/],
    // The normaliser has already turned "E-Mail" into "e mail".
    ["email", /\be\s?mail\b/],
    ["phone", /\b(phone|mobile|telephone|contact number)\b/],
    ["linkedin", /\blinked\s*in\b/],
    ["github", /\bgit\s*hub\b/],
    ["portfolio", /\b(portfolio|personal (web)?site|website|personal url)\b/],
    ["noticePeriod", /\bnotice period\b/],
    ["currentCtc", /\b(current)\b.*\b(ctc|salary|compensation)\b/],
    ["expectedCtc", /\b(expected|desired)\b.*\b(ctc|salary|compensation)\b/],
    ["experience", /\b(years?|total)\b.*\bexperience\b|\bexperience\b.*\byears?\b/],
    ["city", /\b(city|town)\b/],
    ["state", /\b(state|province|region)\b/],
    ["country", /\bcountry\b/],
    ["postcode", /\b(post(al)? code|zip|pin code)\b/],
    ["location", /\b(location|address|where are you based|current location)\b/],
    ["coverLetter", /\b(cover letter|why do you want|tell us|message|additional information)\b/],
    ["resume", /\b(resume|cv|curriculum vitae)\b/],
    // Last: a bare "name" only after every more specific name has missed.
    ["fullName", /\bname\b/],
  ];

  /** What is this field asking for? Null when nothing is recognised. */
  function classify(rawLabel) {
    const label = normalizeLabel(rawLabel);
    if (!label) return null;
    for (const [kind, pattern] of KINDS) {
      if (pattern.test(label)) return kind;
    }
    return null;
  }

  /** First word of a name, and everything after it. */
  function splitName(fullName) {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: "", middle: "", last: "" };
    if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
    return {
      first: parts[0],
      middle: parts.slice(1, -1).join(" "),
      last: parts[parts.length - 1],
    };
  }

  /** The first recognisable city in a free-text location. */
  function cityFrom(location) {
    return String(location || "").split(",")[0].trim();
  }

  /**
   * Country from a home address that rarely names one.
   *
   * "Noida, Uttar Pradesh" is an Indian address that never says India,
   * and a Workday form will ask for the country regardless. Matching the
   * states and the larger cities covers how people actually write it.
   */
  const INDIAN_HINT =
    /\b(india|andhra|arunachal|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|ncr|noida|gurgaon|gurugram|faridabad|ghaziabad|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|lucknow|indore|chandigarh|kochi|coimbatore|nagpur|bhopal|surat|visakhapatnam)\b/i;

  function countryFrom(location) {
    return INDIAN_HINT.test(String(location || "")) ? "India" : "";
  }

  /**
   * What to type into a field of each kind.
   *
   * Returns null where the profile has nothing to offer, which leaves the
   * field alone rather than filling it with an empty string.
   */
  function valueFor(kind, profile) {
    const p = profile || {};
    const name = splitName(p.fullName);

    const map = {
      firstName: name.first,
      lastName: name.last,
      middleName: name.middle,
      preferredName: name.first,
      fullName: p.fullName,
      email: p.email,
      phone: p.phone,
      linkedin: p.linkedin,
      github: p.github,
      portfolio: p.portfolio,
      experience: p.yearsExperience,
      city: cityFrom(p.location),
      location: p.location,
      country: countryFrom(p.location),
      coverLetter: "",
    };

    const value = map[kind];
    return value && String(value).trim() ? String(value).trim() : null;
  }

  /**
   * Kinds we will never fill.
   *
   * A consent box, a salary expectation and a notice period are answers
   * only you can give, and a wrong one submitted in your name is worse
   * than an empty field. Salary in particular cannot be un-said.
   */
  const NEVER_FILL = new Set([
    "currentCtc",
    "expectedCtc",
    "noticePeriod",
    "coverLetter",
  ]);

  root.JDFields = {
    normalizeLabel,
    classify,
    splitName,
    cityFrom,
    countryFrom,
    valueFor,
    NEVER_FILL,
    KINDS,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

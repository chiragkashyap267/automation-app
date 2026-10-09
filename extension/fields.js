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
    // --- things no autofill should ever answer ---
    // Indian portals ask for these, and a wrong government number is worse
    // than a blank one: it can invalidate an application outright. These
    // are classified so they can be refused by name rather than silently
    // missed, which is how you learn they were skipped.
    ["pan", /\bpan\b.*\b(number|no|card)\b|\bpan\s?(number|no|card)\b/],
    ["aadhaar", /\b(aadha?ar|uid)\b/],
    ["passport", /\bpassport\b/],
    ["bank", /\b(bank account|account number|ifsc|upi)\b/],
    ["uan", /\b(uan|pf number|provident fund)\b/],
    ["password", /\bpassword\b/],
    ["captcha", /\bcaptcha\b/],

    ["email", /\be\s?mail\b/],
    ["phone", /\b(phone|mobile|telephone|contact number)\b/],
    ["linkedin", /\blinked\s*in\b/],
    ["github", /\bgit\s*hub\b/],
    ["portfolio", /\b(portfolio|personal (web)?site|website|personal url)\b/],
    // --- education, which every Indian IT portal asks for in full ---
    // Most specific first: "10th percentage" must not be read as a bare
    // "percentage", and the graduation row must not catch the school ones.
    ["tenthYear", /\b(10th|tenth|ssc|sslc|matriculation)\b.*\b(year|passing|yop)\b/],
    ["tenthBoard", /\b(10th|tenth|ssc|sslc|matriculation)\b.*\bboard\b/],
    ["tenthMarks", /\b(10th|tenth|ssc|sslc|matriculation)\b/],
    ["twelfthYear", /\b(12th|twelfth|hsc|intermediate|senior secondary)\b.*\b(year|passing|yop)\b/],
    ["twelfthBoard", /\b(12th|twelfth|hsc|intermediate|senior secondary)\b.*\bboard\b/],
    ["twelfthMarks", /\b(12th|twelfth|hsc|intermediate|senior secondary)\b/],
    ["gradYear", /\b(graduation|degree|ug|bachelor|b tech|btech|bca|bsc|bcom)\b.*\b(year|passing|yop)\b/],
    ["college", /\b(college|university|institute|institution|school name)\b/],
    ["branch", /\b(branch|specialisation|specialization|stream|discipline|major)\b/],
    ["degree", /\b(degree|qualification|course)\b/],
    ["gradMarks", /\b(graduation|ug|bachelor|aggregate|cgpa|percentage|marks)\b/],

    // --- current employment ---
    ["currentCompany", /\bcurrent\b.*\b(employer|company|organisation|organization)\b/],
    ["currentDesignation", /\bcurrent\b.*\b(designation|role|title|position)\b/],
    ["dob", /\b(date of birth|dob|birth date|birthday)\b/],

    ["noticePeriod", /\bnotice period\b/],
    ["currentCtc", /\b(current)\b.*\b(ctc|salary|compensation)\b/],
    ["expectedCtc", /\b(expected|desired)\b.*\b(ctc|salary|compensation)\b/],
    ["experience", /\b(years?|total)\b.*\bexperience\b|\bexperience\b.*\byears?\b/],
    // "sex" does not match "sexual orientation": the word boundary after
    // "sex" fails against "sexual", and that is a different question.
    ["gender", /\b(gender|sex)\b/],
    ["nationality", /\b(nationality|citizenship)\b/],
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

  /**
   * What is this field asking for? Null when nothing is recognised.
   *
   * `overrides` maps a normalised label to a kind, and wins outright. It
   * carries two things: what you corrected by hand on this site before,
   * and what the model worked out for labels no pattern here covers.
   * A correction has to beat the patterns, or correcting one would do
   * nothing on a label the list already has an opinion about.
   */
  function classify(rawLabel, overrides) {
    const label = normalizeLabel(rawLabel);
    if (!label) return null;

    if (overrides && overrides[label]) return overrides[label];

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
      // Answered once in the extension's own options, because the app does
      // not track them and a form asks for them on every application.
      gender: p.gender,
      nationality: p.nationality || p.country,
      // What you set wins; otherwise work it out from where you live.
      country: p.country || countryFrom(p.location),
      // Empty unless a letter has been written for this application. The
      // field is no longer refused outright, but nothing generic goes in
      // it either: a cover letter that could have been sent to anyone is
      // worse than a blank box.
      coverLetter: p.coverLetter || "",

      dob: p.dob,
      tenthMarks: p.tenthMarks,
      tenthYear: p.tenthYear,
      tenthBoard: p.tenthBoard,
      twelfthMarks: p.twelfthMarks,
      twelfthYear: p.twelfthYear,
      twelfthBoard: p.twelfthBoard,
      degree: p.degree,
      branch: p.branch,
      college: p.college,
      gradMarks: p.gradMarks,
      gradYear: p.gradYear,
      currentCompany: p.currentCompany,
      currentDesignation: p.currentDesignation || p.headline,
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
    // Money and dates you have to decide, not recall.
    "currentCtc",
    "expectedCtc",
    "noticePeriod",
    // Identity and credentials. A government number filled in wrongly can
    // invalidate an application, and none of these belong in a browser
    // extension's storage in the first place.
    "pan",
    "aadhaar",
    "passport",
    "bank",
    "uan",
    "password",
    "captcha",
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

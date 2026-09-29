// Catching invented experience attributed to a real employer.
const { unsupportedClaims, SEED_PROFILE, EMPTY_PROFILE } = await import("./.claims.bundle.mjs");
const profile = { ...EMPTY_PROFILE, ...SEED_PROFILE };

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const d = (body) => ({ body, recipients: ["a@b.com"], subject: "s", company: "", contactName: "" });

// The exact sentence Groq produced.
const groq = d(
  "Dear Hiring Team,\n\nI am applying for the QA Professional position in Noida.\n\n" +
  "My recent work as an Associate Software Engineer at Labhyansh involved building cross-platform " +
  "React Native apps and manually testing each release, performing functional and regression checks " +
  "to ensure stability.\n\nCould we schedule a brief call?",
);
check("catches invented testing at a real employer", unsupportedClaims(groq, profile).length > 0, true);
check("names what it caught", unsupportedClaims(groq, profile).some((t) => t.includes("test")), true);

// The honest Gemini version must not be flagged.
const gemini = d(
  "Dear Hiring Team,\n\nI am writing to apply for the QA Professional role at Kulsys.\n\n" +
  "My background is in full-stack development rather than dedicated QA, but I have built and " +
  "deployed multiple web applications, including shipping AI-integrated features into production " +
  "at Labhyansh.\n\nI would appreciate the opportunity to discuss this.",
);
check("does not flag an honest pivot", unsupportedClaims(gemini, profile), []);

// Wanting to do something is not claiming to have done it.
check(
  "aspiration is not a claim",
  unsupportedClaims(d("At Labhyansh I built React Native apps and am eager to move into manual testing."), profile).length,
  0,
);

// Things genuinely in the resume must pass.
check(
  "real experience passes",
  unsupportedClaims(d("At Growthpandit I deployed 4+ full-stack apps using React and Firebase."), profile),
  [],
);

// No employer named means no attribution to check.
check(
  "generic sentences are left alone",
  unsupportedClaims(d("I have experience with manual testing and JIRA."), profile),
  [],
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

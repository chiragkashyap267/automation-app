// One screenshot split into several postings means duplicate mail to one company.
const { dedupeJobs } = await import("./.dedupe.bundle.mjs");
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const j = (o) => ({ company: "", role: "", location: "", reqId: "", recipients: [], contactName: "", highlights: [], seniority: "", confidence: "high", notes: "", ...o });

check("a single posting is untouched", dedupeJobs([j({ company: "Acme" })]).length, 1);

// The real failure: one advert read as three.
const split = [
  j({ company: "Kulsys", role: "QA Professional", recipients: ["career@kulsys.com"], highlights: ["Manual testing"] }),
  j({ company: "Kulsys", role: "QA Professional", recipients: ["naincy.goel@kulsys.com"], highlights: ["JIRA"] }),
  j({ company: "Kulsys", role: "QA Professional", recipients: [], highlights: ["SDLC"] }),
];
const merged = dedupeJobs(split);
check("three slices of one advert become one", merged.length, 1);
check("every address is kept", merged[0].recipients.sort(), ["career@kulsys.com", "naincy.goel@kulsys.com"]);
check("requirements are combined", merged[0].highlights.length, 3);

check(
  "a shared address merges even when the role text differs",
  dedupeJobs([
    j({ company: "A", role: "Dev", recipients: ["hr@a.com"] }),
    j({ company: "A Ltd", role: "Developer", recipients: ["hr@a.com"] }),
  ]).length,
  1,
);

// Genuinely different postings must survive.
check(
  "two real postings stay separate",
  dedupeJobs([
    j({ company: "Acme", role: "Backend", recipients: ["hr@acme.com"] }),
    j({ company: "Globex", role: "Frontend", recipients: ["jobs@globex.io"] }),
  ]).length,
  2,
);
check(
  "same company, different roles stay separate",
  dedupeJobs([
    j({ company: "Acme", role: "Backend Engineer", recipients: ["a@acme.com"] }),
    j({ company: "Acme", role: "QA Engineer", recipients: ["b@acme.com"] }),
  ]).length,
  2,
);
check(
  "missing fields are filled from the other half",
  dedupeJobs([
    j({ company: "Acme", role: "Dev", recipients: ["hr@acme.com"], location: "" }),
    j({ company: "Acme", role: "Dev", recipients: ["hr@acme.com"], location: "Pune", reqId: "R1" }),
  ])[0].location,
  "Pune",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

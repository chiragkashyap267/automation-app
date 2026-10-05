// The career-board watcher: what reaches the digest, and what never should.
const {
  impliedYears, indiaTier, isTechRole, parseYears, rank, scorePosting,
  seniorityFits, wantedTerms, digestHeader, jobCard, jobKeyboard, COMPANIES, EMPTY_PROFILE,
  collapseDuplicates, dedupeKey, passesRoleGates, mergeLocations,
} = await import("./.jobs.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const DAY = 86400000;
const posting = (over = {}) => ({
  id: "x:1", source: "greenhouse", company: "Acme", role: "Software Engineer",
  location: "Noida, India", postedAt: Date.now() - DAY, applyUrl: "https://acme.example/job/1",
  ...over,
});

const me = {
  ...EMPTY_PROFILE,
  location: "Noida, Uttar Pradesh",
  headline: "Frontend Developer",
  yearsExperience: "2",
  skills: "React, JavaScript, TypeScript, Next.js, HTML, CSS, Node.js",
};

section("is it a technical job at all");
check("a software engineer is", isTechRole("Software Engineer"), true);
check("an associate software engineer is", isTechRole("Associate Software Engineer"), true);
check("a frontend developer is", isTechRole("Frontend Developer"), true);
check("an SDET is", isTechRole("SDET II"), true);
check("a sales engineer is not", isTechRole("Sales Engineer"), false);
check("a warehouse lead is not", isTechRole("Warehouse Executive"), false);
check("a recruiter is not", isTechRole("Technical Recruiter"), false);
check("a content writer is not", isTechRole("Content Writer"), false);
check("a chef is not", isTechRole("Head Chef"), false);
// The filter is an allowlist, so an unfamiliar title is refused rather than guessed at.
check("an unrecognised title is not", isTechRole("Growth Associate"), false);

section("seniority: the band is 1-3 years");
check("a plain engineer fits", seniorityFits("Software Engineer"), true);
check("an associate fits", seniorityFits("Associate Software Engineer"), true);
check("a graduate trainee fits", seniorityFits("Graduate Engineer Trainee"), true);
check("a junior fits", seniorityFits("Junior Java Developer"), true);
check("a senior does not", seniorityFits("Senior Software Engineer"), false);
check("an SSE does not", seniorityFits("SSE - Backend"), false);
check("a lead does not", seniorityFits("Backend Lead"), false);
check("a TL does not", seniorityFits("Backend - TL/STL"), false);
check("a principal does not", seniorityFits("Principal Engineer"), false);
check("an architect does not", seniorityFits("Solution Architect"), false);
check("a manager does not", seniorityFits("Engineering Manager"), false);
check("a specialist does not", seniorityFits("Technical Specialist"), false);

section("seniority: the most senior word in a title wins");
check("a senior associate is senior", impliedYears("Senior Associate Engineer") > 3, true);
// A grade word in front of "consultant" is the real grade.
check("an associate consultant is not a consultant", impliedYears("Associate Technical Consultant") <= 3, true);
check("a junior support engineer is junior", impliedYears("Junior Network Support Engineer") <= 3, true);

section("seniority: grades and written-out years");
check("engineer I fits", seniorityFits("Software Engineer I"), true);
check("engineer II fits", seniorityFits("Technical Support Engineer 2"), true);
check("engineer III does not", seniorityFits("Software Engineer 3 - Architecture"), false);
check("engineer IV does not", seniorityFits("Software Engineer IV"), false);
check("5+ years in the title does not", seniorityFits("Developer (5+ years)"), false);
check("2-4 years in the title fits", seniorityFits("Developer (2-4 years)"), true);
// Without this the "3" in "3 years" would read as the grade "Engineer III".
check("a years phrase is not read as a grade", seniorityFits("Engineer, 3 years exp"), true);

section("where the job is");
check("Noida is NCR", indiaTier(posting({ location: "Noida, India" })), "ncr");
check("Gurugram is NCR", indiaTier(posting({ location: "Gurugram" })), "ncr");
check("Bengaluru is south", indiaTier(posting({ location: "Bengaluru, KA" })), "south");
check("IN-Pune is south", indiaTier(posting({ location: "IN-Pune" })), "south");
check("Mumbai is the rest of India", indiaTier(posting({ location: "Mumbai" })), "india");
check("remote in India counts", indiaTier(posting({ location: "Remote - India" })), "india");
check("a mixed list with India counts", indiaTier(posting({ location: "Hyderabad, India; Remote" })), "south");

section("where the job is not");
check("San Francisco is rejected", indiaTier(posting({ location: "San Francisco, California" })), null);
// The leak that mattered: a foreign city plus "Remote" is still foreign.
check("San Francisco plus remote is still rejected", indiaTier(posting({ location: "San Francisco, California; Remote" })), null);
check("Warsaw plus remote is rejected", indiaTier(posting({ location: "PL-Warsaw-Lixa C; Remote" })), null);
check("remote in the UK is rejected", indiaTier(posting({ location: "Remote, United Kingdom" })), null);

section("where the job might be");
check("no location at all is unknown", indiaTier(posting({ location: "" })), "unknown");
check("'Hybrid' says nothing, so unknown", indiaTier(posting({ location: "Hybrid" })), "unknown");
check("bare 'Remote' is unknown", indiaTier(posting({ location: "Remote" })), "unknown");

section("scoring");
const terms = wantedTerms(me);
check("react is a wanted term", terms.includes("react"), true);
check("react vouches for frontend titles", terms.includes("frontend"), true);
const ncr = scorePosting(posting({ role: "Associate Frontend Developer" }), me, terms);
const blr = scorePosting(posting({ role: "Associate Frontend Developer", location: "Bengaluru, India" }), me, terms);
check("an NCR job outscores the same job in Bengaluru", ncr.score > blr.score, true);
const fresh = scorePosting(posting({ postedAt: Date.now() }), me, terms);
const stale = scorePosting(posting({ postedAt: Date.now() - 60 * DAY }), me, terms);
check("a new posting outscores an old one", fresh.score > stale.score, true);
const unknown = scorePosting(posting({ location: "" }), me, terms);
check("an unplaced job scores below a placed one", unknown.score < blr.score, true);
check("the tier is carried on the match", ncr.tier, "ncr");

section("rejection returns nothing at all");
check("a sales job", scorePosting(posting({ role: "Account Executive" }), me, terms), null);
check("a senior job", scorePosting(posting({ role: "Senior Software Engineer" }), me, terms), null);
check("a job in Berlin", scorePosting(posting({ location: "Berlin, Germany" }), me, terms), null);

section("ranking collapses duplicate requisitions");
const dupes = [
  posting({ id: "a", role: "Full Stack Developer", postedAt: Date.now() - 30 * DAY }),
  posting({ id: "b", role: "Full Stack Developer", postedAt: Date.now() }),
  posting({ id: "c", role: "Full Stack  Developer ", postedAt: Date.now() - 2 * DAY }),
  posting({ id: "d", role: "Backend Developer" }),
];
const ranked = rank(dupes, me);
check("three copies of one role become one", ranked.length, 2);
check("and the best-scoring copy is the one kept", ranked[0].posting.id, "b");
// Two companies may legitimately advertise the same title.
const twoFirms = rank([posting({ id: "p", company: "Acme" }), posting({ id: "q", company: "Globex" })], me);
check("the same title at two companies is two jobs", twoFirms.length, 2);

section("what the digest looks like");
const match = rank([posting({ role: "Associate Software Engineer" })], me)[0];
const card = jobCard(match, 1, 3);
check("the card is numbered", card.startsWith("1/3  Associate Software Engineer"), true);
check("it names the company", card.includes("Acme"), true);
check("it gives the location", card.includes("Noida, India"), true);
check("it says how old the posting is", card.includes("yesterday"), true);
const unplaced = rank([posting({ role: "Associate Software Engineer", location: "" })], me)[0];
check("an unplaced job warns you to check", jobCard(unplaced, 1, 1).includes("check before applying"), true);

section("the apply button");
const kb = jobKeyboard(match);
check("it is a url button, not a callback", "url" in kb.inline_keyboard[0][0], true);
check("it points at the employer's own form", kb.inline_keyboard[0][0].url, "https://acme.example/job/1");

section("the header");
check("nothing new says so", digestHeader({ fresh: [], scanned: 9, matched: 4, forgetful: false }).startsWith("No new matches"), true);
check("one match is singular", digestHeader({ fresh: [match], scanned: 9, matched: 4, forgetful: false }).includes("1 new opening worth"), true);
check("two are plural", digestHeader({ fresh: [match, match], scanned: 9, matched: 4, forgetful: false }).includes("2 new openings worth"), true);

section("years on the profile");
check("a plain number", parseYears("2"), 2);
check("words around it", parseYears("about 1.5 years"), 1.5);
check("a range takes the lower bound", parseYears("2-3"), 2);
check("nothing at all", parseYears(""), 0);

section("the watch list");
check("every company has a name, source and slug", COMPANIES.every((c) => c.name && c.via && c.slug), true);
check("no slug is registered twice for one source", new Set(COMPANIES.map((c) => `${c.via}:${c.slug}`)).size, COMPANIES.length);

section("the wider IT field, not just software engineering");
check("a web developer is in", isTechRole("Web Developer"), true);
check("a React developer is in", isTechRole("React Developer"), true);
check("a WordPress developer is in", isTechRole("WordPress Developer"), true);
check("a MERN stack developer is in", isTechRole("MERN Stack Developer"), true);
check("IT support is in", isTechRole("IT Support Executive"), true);
check("a desktop support engineer is in", isTechRole("Desktop Support Engineer"), true);
check("a system administrator is in", isTechRole("System Administrator"), true);
check("a software tester is in", isTechRole("Software Tester"), true);
check("a QA analyst is in", isTechRole("QA Analyst"), true);
check("a business analyst is in", isTechRole("Business Analyst"), true);
check("a data scientist is in", isTechRole("Data Scientist"), true);
check("a UI/UX designer is in", isTechRole("UI/UX Designer"), true);
check("a web designer is in", isTechRole("Web Designer"), true);

section("whole words, so a stack name is not read as a function");
// "sales" inside "Salesforce" was rejecting every Salesforce job.
check("a Salesforce developer is not a sales job", isTechRole("Salesforce Developer"), true);
check("a sales engineer still is", isTechRole("Sales Engineer"), false);
check("an account executive still is", isTechRole("Account Executive"), false);
check("a technical recruiter still is", isTechRole("Technical Recruiter"), false);

section("the cheap gates run before anything costly");
check("a junior tech role passes", passesRoleGates("Associate Software Engineer"), true);
check("a senior one does not", passesRoleGates("Senior Software Engineer"), false);
check("a sales one does not", passesRoleGates("Sales Engineer"), false);

section("merging what two fields say about one place");
check("the same place twice is said once", mergeLocations(["Noida", "Noida"]), "Noida");
check("the fuller phrasing wins", mergeLocations(["Bangalore", "Bangalore, Karnataka, India"]), "Bangalore, Karnataka, India");
check("order does not matter", mergeLocations(["Bangalore, Karnataka, India", "Bangalore"]), "Bangalore, Karnataka, India");
// A URL drops the macron the label keeps; it is still one place, not two.
check("accents do not split a place in two", mergeLocations(["Bengaluru Karnataka India", "Bengaluru, Karnātaka, India"]).includes(";"), false);
check("genuinely different places are both kept", mergeLocations(["Noida", "Pune"]), "Noida; Pune");
check("blanks are dropped", mergeLocations(["", undefined, "Noida"]), "Noida");
check("whitespace is tidied", mergeLocations(["India   Hyderabad"]), "India Hyderabad");

section("collapsing duplicate requisitions keeps the newest");
const copies = collapseDuplicates([
  posting({ id: "old", role: "Full Stack Developer", postedAt: Date.now() - 10 * DAY }),
  posting({ id: "new", role: "Full Stack  Developer", postedAt: Date.now() }),
]);
check("two requisitions become one", copies.length, 1);
check("and it is the newest", copies[0].id, "new");
check(
  "the key ignores spacing and case",
  dedupeKey(posting({ role: "Full  Stack DEVELOPER" })),
  dedupeKey(posting({ role: "full stack developer" })),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

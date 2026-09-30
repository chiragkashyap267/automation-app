// Run with: npm test
// Exercises the key pools, provider failover, signature handling, the recipe
// layer, and the local extractor — all against stubs, so no API key is needed.

for (let i = 1; i <= 11; i++) process.env[`GEMINI_API_KEY_${i}`] = `gem-${i}`;
for (let i = 1; i <= 3; i++) process.env[`GROQ_API_KEY_${i}`] = `groq-${i}`;

// recipes.ts persists through localStorage; give it one.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const {
  geminiPool,
  groqPool,
  markFailure,
  markSuccess,
  runGemini,
  writeWithGroq,
  readWithGroq,
  buildSignature,
  stripSignature,
  composeEmail,
  normalizePlainText,
  familyKey,
  deriveRecipe,
  renderRecipe,
  rememberRecipe,
  findRecipe,
  loadRecipes,
  hashInput,
  readExtractCache,
  writeExtractCache,
  localExtract,
  validateDraft,
  applyFixes,
  countBySeverity,
  editRatio,
  recordSend,
  isSettled,
  describeFamily,
  profileFingerprint,
  recipeProblems,
  checkExperience,
  statedYearsIn,
  findPriorApplication,
  describePriorApplication,
} = await import("./.bundle.mjs");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`),
  );
  ok ? pass++ : fail++;
}
function section(name) {
  console.log(`\n── ${name}`);
}

const FACTS = {
  reqId: "",
  company: "Acme",
  role: "Dev",
  location: "Remote",
  recipients: ["jobs@acme.io"],
  contactName: "",
  highlights: ["React"],
  seniority: "mid",
  confidence: "high",
  notes: "",
};
const okJob = { ...FACTS, subject: "Dev application", body: "Hi there" };

function geminiResponse(payload, status = 200) {
  if (status !== 200) return new Response(JSON.stringify(payload), { status });
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" },
      ],
    }),
    { status: 200 },
  );
}

/* ───────────────────────────── key pool ───────────────────────────── */
section("key pool");

check("discovers 11 gemini keys", geminiPool.count(), 11);
check("discovers 3 groq keys separately", groqPool.count(), 3);

const firstOfEach = [
  geminiPool.keysToTry()[0].label,
  geminiPool.keysToTry()[0].label,
  geminiPool.keysToTry()[0].label,
];
check("rotates start key across requests", firstOfEach, [
  "GEMINI_API_KEY_1",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
]);

geminiPool.reset();
const order = geminiPool.keysToTry();
markFailure(order[0], "rate-limit", "429");
check("benched key leaves the available set", geminiPool.status().available, 10);
const afterLimit = geminiPool.keysToTry();
check("benched key kept as last resort", afterLimit[afterLimit.length - 1].label, order[0].label);
markSuccess(order[0]);
check("success un-benches", geminiPool.status().available, 11);

geminiPool.reset();
const fresh = geminiPool.keysToTry();
markFailure(fresh[0], "invalid", "bad key");
markFailure(fresh[1], "rate-limit", "429");
const cooling = geminiPool.status().cooling;
check(
  "invalid cools far longer than rate-limited",
  cooling.find((c) => c.label === fresh[0].label).secondsLeft >
    cooling.find((c) => c.label === fresh[1].label).secondsLeft * 10,
  true,
);

geminiPool.reset();
process.env.GEMINI_API_KEY_5 = "gem-4";
check("deduplicates repeated keys", geminiPool.count(), 10);
process.env.GEMINI_API_KEY_5 = "gem-5";
geminiPool.reset();

/* ───────────────────────── gemini failover ───────────────────────── */
section("gemini failover");

let attempts = [];
globalThis.fetch = async (_url, init) => {
  attempts.push(init.headers["x-goog-api-key"]);
  if (attempts.length <= 3) return geminiResponse({ error: { code: 429, message: "quota" } }, 429);
  return geminiResponse({ jobs: [okJob] });
};
let read = await runGemini({ text: "read", images: [] }, "full");
check("fails over past 3 dead keys", attempts.length, 4);
check("returns the parsed job", read.jobs[0].company, "Acme");
check("3 keys now benched", geminiPool.status().available, 8);

geminiPool.reset();
attempts = [];
globalThis.fetch = async (_url, init) => {
  attempts.push(JSON.parse(init.body));
  return geminiResponse({ jobs: [FACTS] });
};
read = await runGemini({ text: "read", images: [] }, "extract");
check("extract mode omits the email fields", read.jobs[0].subject, undefined);
check(
  "extract mode asks for a smaller budget",
  attempts[0].generationConfig.maxOutputTokens < 4096,
  true,
);

geminiPool.reset();
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return geminiResponse({ error: { code: 400, message: "Invalid JSON payload" } }, 400);
};
await runGemini({ text: "x", images: [] }, "full").catch(() => {});
check("non-key 400 stops after one attempt", calls, 1);

geminiPool.reset();
globalThis.fetch = async () => geminiResponse({ error: { code: 429, message: "quota" } }, 429);
const exhausted = await runGemini({ text: "x", images: [] }, "full").then(
  () => null,
  (e) => e.message,
);
check("all-exhausted message names the count", /All 11 Gemini keys/.test(exhausted), true);

/* ───────────────────────────── groq ───────────────────────────── */
section("groq writer");

groqPool.reset();
let groqAttempts = [];
globalThis.fetch = async (_url, init) => {
  groqAttempts.push(init.headers.authorization);
  if (groqAttempts.length === 1) {
    return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
  }
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ subject: "Hello", body: "Body text" }) },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200 },
  );
};
const WRITER_PROFILE = {
  fullName: "A",
  tone: "warm",
  resumeText: "",
  skills: "",
  location: "",
  headline: "",
  yearsExperience: "",
  extraNotes: "",
  resumeFileName: "",
};
const written = await writeWithGroq(WRITER_PROFILE, FACTS);
check("groq fails over to its second key", groqAttempts.length, 2);
check("groq returns subject and body", [written.subject, written.body], ["Hello", "Body text"]);
check("groq pool benched one key", groqPool.status().available, 2);
check("gemini pool untouched by groq failures", geminiPool.count(), 11);

section("groq reader (text only)");

function groqResponse(payload, status = 200) {
  if (status !== 200) return new Response(JSON.stringify(payload), { status });
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
    }),
    { status: 200 },
  );
}

groqPool.reset();
let sentBody = null;
globalThis.fetch = async (_url, init) => {
  sentBody = JSON.parse(init.body);
  return groqResponse({ jobs: [FACTS] });
};
const groqRead = await readWithGroq("some pasted job text", "extract");
check("groq reads pasted text into facts", groqRead.jobs[0].company, "Acme");
check("groq extract omits the email fields", groqRead.jobs[0].subject, undefined);
check("groq asks for JSON object mode", sentBody.response_format.type, "json_object");
const groqExtractBudget = sentBody.max_tokens;

groqPool.reset();
globalThis.fetch = async (_url, init) => {
  sentBody = JSON.parse(init.body);
  return groqResponse({ jobs: [okJob] });
};
const groqFull = await readWithGroq("text", "full");
check("groq full mode returns the written email", groqFull.jobs[0].body, "Hi there");
check("groq extract asks for a smaller budget than full", groqExtractBudget < sentBody.max_tokens, true);
// Reasoning models spend tokens before the JSON, so both budgets need headroom.
check("both budgets leave room for reasoning", groqExtractBudget >= 4000, true);

groqPool.reset();
let groqReadTries = 0;
globalThis.fetch = async () => {
  groqReadTries++;
  if (groqReadTries === 1) {
    return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
  }
  return groqResponse({ jobs: [FACTS] });
};
await readWithGroq("text", "extract");
check("groq reading fails over between keys too", groqReadTries, 2);

/* ──────────────────────────── signature ──────────────────────────── */
section("signature");

const profile = {
  fullName: "Manish Kaushik",
  email: "me@gmail.com",
  phone: "+91 98765 43210",
  signOff: "Best regards",
  linkedin: "linkedin.com/in/manish",
  github: "https://github.com/manish",
  portfolio: "",
};

const sig = buildSignature(profile);
check("signature adds https to bare domains", sig.includes("https://linkedin.com/in/manish"), true);
check("signature keeps existing scheme once", sig.includes("https://https://"), false);
check("signature omits empty portfolio", sig.includes("Portfolio"), false);
check("signature has name, phone, email",
  sig.includes("Manish Kaushik") && sig.includes("+91 98765 43210") && sig.includes("me@gmail.com"),
  true);

const modelWroteOne = "Hi team,\n\nI would love to apply.\n\nBest regards,\nManish\n9999999999";
check(
  "strips a sign-off the model added anyway",
  stripSignature(modelWroteOne),
  "Hi team,\n\nI would love to apply.",
);
check(
  "leaves a body with no sign-off alone",
  stripSignature("Hi team,\n\nHappy to share more."),
  "Hi team,\n\nHappy to share more.",
);
check(
  "composed email has exactly one sign-off",
  (composeEmail(modelWroteOne, profile).match(/Best regards,/g) ?? []).length,
  1,
);
check(
  "a mid-body 'thanks' is not mistaken for a sign-off",
  stripSignature("Thanks to that project I learned Go.\n\nI can start in two weeks.").includes(
    "learned Go",
  ),
  true,
);

section("plain-text normalizer");

const NBSP = " ";
const NARROW = " ";
const NBHYPHEN = "‑";
const ZWSP = "​";
const RSQUO = "’";

check(
  "narrow space between number and unit is closed up",
  normalizePlainText(`served 40${NARROW}k users in 4.1${NARROW}s`),
  "served 40k users in 4.1s",
);
check(
  "non-breaking hyphen becomes a plain hyphen",
  normalizePlainText(`customer${NBHYPHEN}facing`),
  "customer-facing",
);
check(
  "stray non-breaking space becomes an ordinary space",
  normalizePlainText(`Northwind${NBSP}Labs`),
  "Northwind Labs",
);
check("zero-width characters are removed", normalizePlainText(`a${ZWSP}b`), "ab");
check(
  "curly quotes are left alone",
  normalizePlainText(`Northwind${RSQUO}s team`),
  `Northwind${RSQUO}s team`,
);
check(
  "stray bold markdown is unwrapped",
  normalizePlainText("I built **React** apps"),
  "I built React apps",
);
check("runs of blank lines collapse to one", normalizePlainText("a\n\n\n\nb"), "a\n\nb");
check("trailing spaces per line are trimmed", normalizePlainText("a   \nb"), "a\nb");
check("CRLF is normalised", normalizePlainText("a\r\nb"), "a\nb");

/* ───────────────────────────── recipes ───────────────────────────── */
section("recipe layer");

const reactMid = {
  ...FACTS,
  company: "Acme",
  role: "React Developer",
  highlights: ["React", "TypeScript"],
  seniority: "mid",
  contactName: "Priya",
};
const reactMidOther = {
  ...FACTS,
  company: "Globex",
  role: "React Developer",
  highlights: ["React", "TypeScript"],
  seniority: "mid",
  contactName: "",
};
const backendSenior = {
  ...FACTS,
  role: "Senior Backend Engineer",
  highlights: ["Node", "PostgreSQL"],
  seniority: "senior",
};

check("same family shares a key", familyKey(reactMid) === familyKey(reactMidOther), true);
check("different family differs", familyKey(reactMid) === familyKey(backendSenior), false);

const body =
  "Dear Priya,\n\nI saw the React Developer opening at Acme and would like to apply. Acme's work on React tooling matches what I do.\n\nCould we find time to talk?";
const recipe = deriveRecipe(reactMid, "React Developer at Acme", body);
check("company is slotted out of the template", recipe.bodyTemplate.includes("Acme"), false);
check("contact is slotted out of the template", recipe.bodyTemplate.includes("Priya"), false);

const rendered = renderRecipe(recipe, reactMidOther);
check("renders the new company", rendered.body.includes("Globex"), true);
check("old company is gone", rendered.body.includes("Acme"), false);
check("blank contact falls back to Hiring Team", rendered.body.includes("Dear Hiring Team"), true);
check("subject is rendered too", rendered.subject, "React Developer at Globex");

rememberRecipe(reactMid, "React Developer at Acme", body);
check("recipe persists", loadRecipes().length, 1);
check("a same-family posting finds it", findRecipe(loadRecipes(), reactMidOther) !== null, true);
check("a different family does not", findRecipe(loadRecipes(), backendSenior), null);
rememberRecipe(reactMidOther, "x", "y");
check("re-remembering the same family updates, not duplicates", loadRecipes().length, 1);

/* ─────────────────────────── input cache ─────────────────────────── */
section("input cache");

const h1 = hashInput([{ data: "abc" }], ["hello"]);
check("hash is stable", hashInput([{ data: "abc" }], ["hello"]), h1);
check("hash changes with content", hashInput([{ data: "abd" }], ["hello"]) === h1, false);
check("cold cache misses", readExtractCache(h1), null);
writeExtractCache(h1, [FACTS]);
check("warm cache hits", readExtractCache(h1)[0].company, "Acme");

/* ────────────────────────── local extractor ────────────────────────── */
section("local extractor");

const blurb = `Urgent hiring for Senior React Developer
Company: Acme Labs
Location: Bengaluru (Hybrid)
Experience: 4-6 years
Skills: React, TypeScript, Node.js, AWS
Send your CV to hr [at] acmelabs [dot] com`;

const local = localExtract(blurb);
check("de-obfuscates the address", local.recipients, ["hr@acmelabs.com"]);
check("reads the role", local.role, "Senior React Developer");
check("reads the company label", local.company, "Acme Labs");
check("reads the location", local.location, "Bengaluru (Hybrid)");
check("reads seniority", local.seniority, "senior");
check("finds skills", local.highlights.length >= 3, true);
check("flags that it was read without AI", /without AI/.test(local.notes), true);

// Regression: real OCR text where a name precedes the address on the line above.
const OCR_TEXT = [
  "Backend Engineer (Node.js)",
  "Cloudmint Technologies - Pune (Remote-friendly)",
  "Job ID: CMT-2291 | Posted 2 days ago",
  "We are looking for a backend engineer with 2-5 years of experience",
  "to own our order and payments services.",
  "- Strong Node.js and Express, written in TypeScript",
  "Email your CV to Rahul Mehta at",
  "rahul.mehta [at] cloudmint [dot] io",
].join("\n");

const fromOcr = localExtract(OCR_TEXT);
check('a preceding "... Mehta at" does not corrupt the address', fromOcr.recipients, [
  "rahul.mehta@cloudmint.io",
]);
check("company falls back to the real domain", fromOcr.company, "Cloudmint");
check("a sentence is trimmed down to a job title", fromOcr.role, "backend engineer");
check("the job id is picked up", fromOcr.reqId, "CMT-2291");

// The bare-word form still works when there is no real address to find.
check(
  "bare-word obfuscation still resolves",
  localExtract("Hiring a QA Engineer. Contact hr at acmelabs.com").recipients,
  ["hr@acmelabs.com"],
);

check("refuses when there is no address", localExtract("We are hiring a React Developer"), null);
check("refuses when there is no role", localExtract("Mail us at jobs@acme.io"), null);

const domainOnly = localExtract("Hiring for Backend Engineer\nApply: careers@globex.io");
check("falls back to the email domain for company", domainOnly.company, "Globex");
check("ignores a generic mailbox domain", localExtract("Hiring for QA Engineer\nMail me@gmail.com").company, "");

/* ───────────────────────────── validation ───────────────────────────── */
section("validation");

const PROFILE = {
  fullName: "Manish Kaushik",
  email: "me@gmail.com",
  phone: "+91 98765 43210",
  headline: "Full-stack developer",
  signOff: "Best regards",
  linkedin: "linkedin.com/in/manish",
  github: "https://github.com/manish",
  portfolio: "manish.dev",
};

function draft(over = {}) {
  return {
    id: "d1",
    groupId: "g1",
    company: "Acme",
    role: "Dev",
    location: "",
    seniority: "",
    reqId: "",
    recipients: ["jobs@acme.io"],
    contactName: "",
    highlights: [],
    subject: "Dev application at Acme",
    body:
      "Dear Hiring Team,\n\nI am applying for the Dev role at Acme. " +
      "I have spent three years building web products and would bring that to your team. " +
      "At my last job I shipped a storefront used daily by many thousands of people, and " +
      "I improved its load time substantially through careful profiling work.\n\n" +
      "Could we arrange a short call next week?",
    originalSubject: "",
    originalBody: "",
    confidence: "high",
    notes: "",
    source: "ai",
    recipeKey: "",
    include: true,
    status: "idle",
    error: "",
    sentAt: "",
    ...over,
  };
}

function ids(list) {
  return list.map((i) => i.id);
}

check("a clean draft raises no errors", countBySeverity(validateDraft(draft(), PROFILE)).errors, 0);
check(
  "missing recipient is an error",
  ids(validateDraft(draft({ recipients: [] }), PROFILE)).includes("no-recipient"),
  true,
);
check(
  "a leftover placeholder is an error",
  ids(validateDraft(draft({ body: "Dear [Company] team, hello there." }), PROFILE)).includes(
    "placeholder",
  ),
  true,
);
check(
  "an unfilled recipe slot is an error",
  ids(validateDraft(draft({ subject: "Role at {{company}}" }), PROFILE)).includes("unrendered-slot"),
  true,
);

const foreign = validateDraft(
  draft({ body: draft().body + "\n\nSee https://someone-elses-site.com for more." }),
  PROFILE,
);
check(
  "a link that is not yours is an error",
  foreign.some((i) => i.id.startsWith("foreign-link") && i.severity === "error"),
  true,
);
check(
  "your own links pass",
  validateDraft(draft({ body: draft().body + "\n\nMy work: https://manish.dev" }), PROFILE).some(
    (i) => i.id.startsWith("foreign-link"),
  ),
  false,
);
check(
  "a known misspelling is caught",
  ids(validateDraft(draft({ body: "Dear Team,\n\nI recieve your posting." }), PROFILE)).includes(
    "spelling:recieve",
  ),
  true,
);
check(
  "lower-case tech names are caught",
  ids(validateDraft(draft({ body: draft().body + " I use javascript daily." }), PROFILE)).includes(
    "casing:javascript",
  ),
  true,
);
check(
  "a URL is not mistaken for a casing error",
  ids(
    validateDraft(draft({ body: draft().body + " https://github.com/manish" }), PROFILE),
  ).includes("casing:github"),
  false,
);
check(
  "a doubled word is caught",
  ids(validateDraft(draft({ body: "Dear Team,\n\nI am am applying." }), PROFILE)).includes(
    "doubled-word",
  ),
  true,
);
check(
  "a grammatical double is left alone",
  ids(
    validateDraft(draft({ body: `Dear Team,\n\nI had had a good run there.` }), PROFILE),
  ).includes("doubled-word"),
  false,
);
check(
  "generic salutation is flagged when a contact is known",
  ids(validateDraft(draft({ contactName: "Priya" }), PROFILE)).includes("generic-salutation"),
  true,
);

const messy = "Dear Team,\n\nI recieve your posting and use javascript .";
const fixed = applyFixes(messy, validateDraft(draft({ body: messy }), PROFILE));
check("autofix corrects the spelling", fixed.includes("receive"), true);
check("autofix corrects the casing", fixed.includes("JavaScript"), true);
check("autofix removes the space before punctuation", /JavaScript\./.test(fixed), true);

/* ─────────────────────── learning from what you send ─────────────────────── */
section("recipe refinement");

check("identical text is a zero edit", editRatio("one two three", "one two three"), 0);
check("completely different text is a full edit", editRatio("aaa bbb", "xxx yyy"), 1);
check(
  "a one-word change is small",
  editRatio("the quick brown fox jumps over", "the quick brown cat jumps over") < 0.2,
  true,
);

const learnFacts = {
  ...FACTS,
  company: "Initech",
  role: "Platform Engineer",
  highlights: ["Kubernetes", "Go"],
  seniority: "senior",
  contactName: "",
};
const MINE = "Dear Hiring Team,\n\nMy own much better wording for Initech here.";

let r = recordSend({
  facts: learnFacts,
  originalSubject: "Platform Engineer at Initech",
  originalBody: "Dear Hiring Team,\n\nBland model wording.",
  sentSubject: "Platform Engineer at Initech",
  sentBody: MINE,
});
check("a first send creates the recipe", r.sends, 1);
check("an edited send is counted as edited", r.sentEdited, 1);
check("an edited send leaves the streak at zero", r.cleanStreak, 0);
check("the template adopts what was actually sent", r.bodyTemplate.includes("much better wording"), true);
check("the company is still slotted out of it", r.bodyTemplate.includes("Initech"), false);

for (let i = 0; i < 3; i++) {
  r = recordSend({
    facts: learnFacts,
    originalSubject: "s",
    originalBody: MINE,
    sentSubject: "s",
    sentBody: MINE,
  });
}
check("clean sends build the streak", r.cleanStreak, 3);
check("three clean sends settle the recipe", isSettled(r), true);
check("send count accumulates", r.sends, 4);
check("clean sends are counted", r.sentClean, 3);

r = recordSend({
  facts: learnFacts,
  originalSubject: "s",
  originalBody: MINE,
  sentSubject: "s",
  sentBody: "Dear Hiring Team,\n\nEntirely different text sharing almost nothing whatsoever.",
});
check("a later edit un-settles the recipe", isSettled(r), false);
check(
  "family keys read as English",
  describeFamily("frontend|react+typescript|mid"),
  "Frontend · React, Typescript · Mid",
);

section("experience that contradicts itself");
{
  // The reported bug: the years field was changed to 1 and every email kept
  // saying 2, because the prompt makes the resume the source of truth and
  // the resume summary still said "2+ years".
  const base = {
    fullName: "Chirag Kashyap", headline: "Full Stack Developer", skills: "React, Node",
    extraNotes: "", tone: "warm", signOff: "Best regards",
  };
  const clash = checkExperience({
    ...base, yearsExperience: "1",
    resumeText: "SUMMARY\nFull-stack developer with 2+ years of experience building web products.",
  });
  check("the contradiction is caught", clash.mismatch, true);
  check("it names what the resume says", clash.message.includes("2 years"), true);
  check("and what the field says", clash.message.includes("1 year"), true);
  check("it says which one wins", clash.message.includes("follow the resume"), true);

  check("agreement is silent", checkExperience({
    ...base, yearsExperience: "2",
    resumeText: "Developer with 2+ years of experience.",
  }).mismatch, false);

  check("no resume text, nothing to contradict", checkExperience({
    ...base, yearsExperience: "1", resumeText: "",
  }).mismatch, false);

  check("no field set, nothing to contradict", checkExperience({
    ...base, yearsExperience: "",
    resumeText: "Developer with 2+ years of experience.",
  }).mismatch, false);

  // A job that lasted three years is a duration, not a claim about total
  // experience; flagging those would make the warning worthless.
  check("a job duration is not a claim", statedYearsIn("Backend Engineer at Acme for 3 years."), []);
  check("the summary phrasing is", statedYearsIn("2+ years of experience in React"), [2]);
  check("reversed phrasing too", statedYearsIn("Experience: 4 years"), [4]);
}

section("recipes remember which profile wrote them");
{
  const oldProfile = { fullName: "C K", headline: "Dev", yearsExperience: "2", skills: "React", resumeText: "r", extraNotes: "", tone: "warm", signOff: "Best" };
  const edited = { ...oldProfile, yearsExperience: "1" };

  const a = profileFingerprint(oldProfile);
  const b = profileFingerprint(edited);
  check("a changed profile changes the fingerprint", a === b, false);
  check("the same profile is stable", profileFingerprint(oldProfile), a);
  // A different phone number does not make stored wording wrong.
  check("irrelevant fields are ignored", profileFingerprint({ ...oldProfile, phone: "999" }), a);
  check("whitespace is ignored", profileFingerprint({ ...oldProfile, skills: " React  " }), a);

  const facts = {
    company: "Acme", role: "Backend Engineer", location: "Noida", reqId: "", recipients: ["a@b.com"],
    contactName: "", highlights: [], seniority: "", confidence: "high", notes: "",
  };
  const recipe = deriveRecipe(facts, "Application for Backend Engineer", "I have 2 years of experience.", a);
  check("the fingerprint is stored", recipe.profileFingerprint, a);
  check("it is found for the same profile", findRecipe([recipe], facts, a)?.key, recipe.key);
  // This is the actual fix: a stale recipe is not a saving, it is last
  // month's claims sent for free.
  check("and refused after an edit", findRecipe([recipe], facts, b), null);
  check("no fingerprint given means no check", findRecipe([recipe], facts)?.key, recipe.key);
}

section("a rendered recipe is checked before it is trusted");
{
  const profile = {
    fullName: "C K", resumeText: "Built React and Node products at Freelance for two years.",
    skills: "React, Node", headline: "Dev", extraNotes: "", portfolio: "", linkedin: "", github: "", email: "",
  };
  check("a clean render passes", recipeProblems("I build React and Node products.", "Application", profile), []);
  check("an unfilled slot is caught", recipeProblems("Hello {{company}} team.", "Application", profile).length, 1);
  check("a placeholder is caught", recipeProblems("Hello [Company Name].", "Application", profile).length, 1);
  check(
    "a claim the resume lost is caught",
    recipeProblems("At Freelance I ran Selenium regression suites.", "Application", profile).length,
    1,
  );
}

section("writing to the same people twice");
{
  const DAY = 86400000;
  const now = Date.UTC(2026, 9, 10);
  const rows = [
    { company: "Kulsys", role: "QA Engineer", to: ["hr@kulsys.com"], sentAt: now - 4 * DAY, reply: "awaiting" },
    { company: "Acme", role: "Backend", to: ["jobs@acme.com"], sentAt: now - 40 * DAY, reply: "replied" },
  ];

  check("the same company is caught", findPriorApplication(rows, "Kulsys", ["other@kulsys.com"], now)?.daysAgo, 4);
  // The company name is often misread, so the address has to count too.
  check("the same address is caught", findPriorApplication(rows, "Totally Different Ltd", ["hr@kulsys.com"], now)?.company, "Kulsys");
  check("case and spacing do not matter", findPriorApplication(rows, "  kulsys ", [], now)?.company, "Kulsys");
  check("a stranger is not caught", findPriorApplication(rows, "Globex", ["x@globex.com"], now), null);
  // Beyond three weeks it is a fresh application, not a duplicate.
  check("an old one has expired", findPriorApplication(rows, "Acme", ["jobs@acme.com"], now), null);
  check("an empty history is fine", findPriorApplication([], "Acme", ["a@b.com"], now), null);

  const said = describePriorApplication({ company: "Kulsys", role: "QA Engineer", daysAgo: 1, reply: "replied" });
  check("it reads naturally", said, "You wrote to Kulsys 1 day ago about QA Engineer and they replied. Sending again may read as spam.");
  check("today is said as today", describePriorApplication({ company: "X", role: "", daysAgo: 0, reply: "awaiting" }).includes("today"), true);
}

section("the bot's own validation");
{
  // These ran only in the browser before, so the bot sent misspellings and
  // foreign links straight out.
  const profile = {
    fullName: "Chirag Kashyap", portfolio: "chiragkashyapwebdev.vercel.app",
    linkedin: "linkedin.com/in/chiragkashyap267", github: "github.com/chiragkashyap267",
    email: "me@gmail.com", resumeText: "Built React and Node products at Freelance.",
    skills: "React, Node", headline: "Developer", extraNotes: "", yearsExperience: "",
  };
  const draft = {
    subject: "Application for Backend Engineer",
    body: "Dear Hiring Team,\n\nI would like to apply to Acme. I recieve your posting and build React and Node products.",
    recipients: ["jobs@acme.com"], company: "Acme", contactName: "",
  };

  const issues = validateDraft(draft, profile, null);
  check("a misspelling is caught", issues.some((i) => i.id === "spelling:recieve"), true);
  check("and it carries a repair", Boolean(issues.find((i) => i.id === "spelling:recieve")?.fix), true);
  check("applying it fixes the text", applyFixes(draft.body, issues).includes("receive"), true);

  const linkErrors = (body) =>
    validateDraft({ ...draft, body }, profile, null).filter((i) => i.id.startsWith("foreign-link"));

  check("a link with a scheme is checked", linkErrors(draft.body + " See https://portfolio.example.com").length, 1);
  // The profile stores links bare, so the model writes them bare too — these
  // used to slip through entirely.
  check("a bare domain is checked as well", linkErrors(draft.body + " See portfolio.example.com").length, 1);
  check("and it blocks the send", linkErrors(draft.body + " See portfolio.example.com")[0].severity, "error");
  check("your own links are fine", linkErrors(draft.body + " chiragkashyapwebdev.vercel.app").length, 0);
  check("your linkedin is fine", linkErrors(draft.body + " linkedin.com/in/chiragkashyap267").length, 0);
  // The deny list is what stops a library name being read as a website.
  check("Node.js is not a website", linkErrors(draft.body + " I use Node.js and Express.js daily.").length, 0);
  check("a filename is not a website", linkErrors(draft.body + " See README.md for details.").length, 0);
  check("an email address is not a website", linkErrors(draft.body + " Reach me at me@gmail.com.").length, 0);

  // The prior-application warning is injected now, so both halves can use it.
  const withPrior = validateDraft(draft, profile, { company: "Acme", role: "Backend", daysAgo: 3, reply: "awaiting" });
  check("a repeat application warns", withPrior.some((i) => i.id === "already-applied"), true);
  check("and it is only a warning", withPrior.find((i) => i.id === "already-applied")?.severity, "warning");
  check("no prior means no warning", validateDraft(draft, profile, null).some((i) => i.id === "already-applied"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

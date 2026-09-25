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
check(
  "groq extract budget is smaller than full",
  sentBody.max_tokens < 6000,
  true,
);

groqPool.reset();
globalThis.fetch = async () => groqResponse({ jobs: [okJob] });
const groqFull = await readWithGroq("text", "full");
check("groq full mode returns the written email", groqFull.jobs[0].body, "Hi there");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

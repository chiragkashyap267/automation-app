// The form filler: its vocabulary, what it asks a model, what it remembers,
// and the two files it produces.
import { readFileSync } from "node:fs";

const M = await import("./.fill.bundle.mjs");
const {
  FILL_KINDS, NEVER_FILL, isFillKind, refusalReason,
  MAX_FIELDS, RESOLVE_SYSTEM_PROMPT, UnknownFieldSchema, describeFields, parseResolutions,
  hostOf, normalizeLabel,
  EXTRA_FIELDS, KIND_LABELS, buildAnswers, cityFrom, countryFrom, missingAnswers,
  splitName, unlabelledKinds, valueFor,
  COVER_SYSTEM_PROMPT, buildCoverText, coverProblems,
  coverLetterFilename, textToPdf, toLatin1, wrapLines,
  EMPTY_PROFILE,
} = M;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const me = {
  ...EMPTY_PROFILE,
  fullName: "Chirag Kashyap",
  email: "chirag@example.com",
  phone: "9876543210",
  location: "Noida, Uttar Pradesh",
  headline: "Software Engineer",
  linkedin: "linkedin.com/in/chirag",
  yearsExperience: "2",
  skills: "React, Next.js, Node.js",
  resumeText: "CHIRAG KASHYAP\nSoftware Engineer\nBuilt a React dashboard at Acme.\n",
};

section("the vocabulary both sides share");
check("every kind is unique", new Set(FILL_KINDS).size, FILL_KINDS.length);
check("a known kind is recognised", isFillKind("currentCompany"), true);
check("an invented one is not", isFillKind("favouriteColour"), false);
check("nor is a non-string", isFillKind(7), false);
// The model answers with one of these names; anything else is discarded,
// so the list is the only thing standing between it and a free-text guess.
check("none of them is empty", FILL_KINDS.every((k) => k.length > 0), true);
check("every kind has a label", unlabelledKinds(), []);

section("what is never typed in, and why");
check("salary is refused", NEVER_FILL.has("expectedCtc"), true);
check("so is a government number", NEVER_FILL.has("aadhaar"), true);
check("and a captcha", NEVER_FILL.has("captcha"), true);
// Recognising one is still worth doing: a field skipped by name is a
// field you know to go back to.
check("but it is still a kind", isFillKind("aadhaar"), true);
check("a refusal gives a reason", refusalReason("expectedCtc").includes("un-said"), true);
check("something fillable has none", refusalReason("email"), null);
// A cover letter used to be refused outright. It is written now.
check("the cover letter is no longer refused", NEVER_FILL.has("coverLetter"), false);

section("the extension's copy has not drifted");
// Two implementations of one set of rules: this is the thing that keeps
// them honest. The content script cannot import TypeScript, so the JS
// copy is loaded and compared directly.
const fieldsSrc = readFileSync("extension/fields.js", "utf8");
new Function(fieldsSrc)();
const F = globalThis.JDFields;

const jsKinds = F.KINDS.map(([kind]) => kind);
check("every kind the patterns produce is in the vocabulary",
  jsKinds.filter((k) => !isFillKind(k)), []);
check("both refuse the same things",
  [...F.NEVER_FILL].filter((k) => !NEVER_FILL.has(k)), []);
check("and the server refuses nothing extra that the page would fill",
  [...NEVER_FILL].filter((k) => !F.NEVER_FILL.has(k)), []);
check("the two normalisers agree on a label",
  F.normalizeLabel("Present_Employer Name *"), normalizeLabel("Present_Employer Name *"));
check("and on a camelCase id",
  F.normalizeLabel("legalNameSection_firstName"), normalizeLabel("legalNameSection_firstName"));
// classify() takes overrides now, and they have to beat the patterns or
// correcting a mislabelled field would do nothing.
check("an override wins over a pattern",
  F.classify("Full Name", { "full name": "currentCompany" }), "currentCompany");
check("without one the pattern still applies", F.classify("Full Name", {}), "fullName");
check("an override for another label is ignored",
  F.classify("Full Name", { "notice period": "noticePeriod" }), "fullName");

section("normalising a label");
check("stars and colons go", normalizeLabel("Notice Period *:"), "notice period");
// A parenthetical is dropped, not flattened: it is nearly always
// "(optional)" or "(required)", which says nothing about the field.
// It costs the odd useful one like "(Yrs)" — which is what the model
// and the learned corrections are there to cover.
check("a bracketed aside is dropped", normalizeLabel("Total Exp. (Yrs)"), "total exp");
check("and so is (optional)", normalizeLabel("Phone (optional)"), "phone");
check("camelCase is split", normalizeLabel("currentCTC"), "current ctc");
check("snake_case too", normalizeLabel("present_employer_name"), "present employer name");
check("nothing is nothing", normalizeLabel(""), "");

section("which site a lesson is filed under");
check("a full URL gives the host", hostOf("https://careers.tcs.com/jobs/123?x=1"), "careers.tcs.com");
check("www is dropped", hostOf("https://www.naukri.com/x"), "naukri.com");
check("a bare host works", hostOf("jobs.lever.co"), "jobs.lever.co");
check("rubbish is not a host", hostOf("   "), "");

section("what the model is asked");
const asked = [
  UnknownFieldSchema.parse({ label: "Present Employer Name", type: "text" }),
  UnknownFieldSchema.parse({ label: "Select", type: "select", options: ["Uttar Pradesh", "Karnataka"] }),
];
const described = describeFields(asked);
check("each field is numbered", described.includes("1. label: Present Employer Name"), true);
check("the type is given", described.includes("type: select"), true);
// A list of Indian states is a state field whatever it is labelled, so
// the options have to go up with it.
check("so are the options", described.includes("Uttar Pradesh | Karnataka"), true);
check("nothing is asked about nothing", describeFields([]), "");
// Long option lists are cut; six is plenty to recognise a dropdown by.
const many = UnknownFieldSchema.parse({ label: "x", options: Array.from({ length: 30 }, (_, i) => `o${i}`) });
check("a long list is trimmed and counted", describeFields([many]).includes("+24 more"), true);
check("the model is told none is a real answer", RESOLVE_SYSTEM_PROMPT.includes('"none"'), true);
check("and warned off guessing", RESOLVE_SYSTEM_PROMPT.toLowerCase().includes("do not guess"), true);
check("and told to name credential fields", RESOLVE_SYSTEM_PROMPT.includes("aadhaar"), true);

section("reading the answer back");
const answer = (fields) => ({ fields });
check("a good answer maps through",
  parseResolutions(answer([{ label: "x", kind: "currentCompany" }, { label: "y", kind: "state" }]), asked),
  [{ label: "Present Employer Name", kind: "currentCompany" }, { label: "Select", kind: "state" }]);
// The label reported is always the one we sent: a model rewrites a label
// far more often than it reorders a list.
check("the label we sent is the label we get back",
  parseResolutions(answer([{ label: "Employer name (rewritten)", kind: "currentCompany" }]), asked)[0].label,
  "Present Employer Name");
check("none means none, not a failure",
  parseResolutions(answer([{ label: "x", kind: "none" }]), asked)[0].kind, null);
check("a kind outside the list is dropped",
  parseResolutions(answer([{ label: "x", kind: "favouriteColour" }]), asked)[0].kind, null);
check("a short answer resolves what it covers",
  parseResolutions(answer([{ label: "x", kind: "email" }]), asked).length, 1);
check("a broken answer resolves nothing", parseResolutions({ nope: true }, asked), []);
check("so does no answer at all", parseResolutions(null, asked), []);
check("there is a cap on one request", MAX_FIELDS > 0 && MAX_FIELDS <= 60, true);

section("what goes in each box");
check("the first name is the first word", splitName("Chirag Kashyap").first, "Chirag");
check("and the last is the last", splitName("Chirag Kumar Kashyap").last, "Kashyap");
check("with the middle in between", splitName("Chirag Kumar Kashyap").middle, "Kumar");
check("one word is a first name", splitName("Chirag").last, "");
check("the city comes off the location", cityFrom("Noida, Uttar Pradesh"), "Noida");
// "Noida, Uttar Pradesh" is an Indian address that never says India.
check("the country is worked out", countryFrom("Noida, Uttar Pradesh"), "India");
check("somewhere else is not guessed", countryFrom("Warsaw, Poland"), "");
check("the profile answers what it knows", valueFor("email", me), "chirag@example.com");
check("the headline stands in for the designation", valueFor("currentDesignation", me), "Software Engineer");
check("an answer you typed wins", valueFor("country", me, { country: "Bharat" }), "Bharat");
check("a blank extra falls back", valueFor("country", me, { country: "  " }), "India");
check("nothing known is an empty string", valueFor("tenthBoard", me), "");

section("the sheet a form is filled from");
const sheet = buildAnswers(me, { gender: "Male", tenthMarks: "92%" });
const kinds = sheet.map((a) => a.kind);
check("it has the name", kinds.includes("fullName"), true);
check("and what you typed in", kinds.includes("gender"), true);
// A sheet of mostly blanks is harder to use than a short one.
check("nothing empty is listed", sheet.every((a) => a.value !== ""), true);
check("every row is labelled", sheet.every((a) => a.label.length > 0), true);
// Salary must not appear even as a prompt: it cannot be un-said.
check("salary is not on it", kinds.includes("expectedCtc"), false);
check("nor the notice period", kinds.includes("noticePeriod"), false);
check("the name comes before the marks", kinds.indexOf("fullName") < kinds.indexOf("tenthMarks"), true);
check("an empty profile gives an empty sheet", buildAnswers(EMPTY_PROFILE), []);
check("the gaps are reported", missingAnswers(me).includes("tenthBoard"), true);
check("what is filled is not", missingAnswers(me).includes("email"), false);
check("the extras are all real kinds", EXTRA_FIELDS.filter((k) => !isFillKind(k)), []);
check("and all labelled", EXTRA_FIELDS.filter((k) => !KIND_LABELS[k]), []);

section("what the cover letter is written from");
const prompt = buildCoverText(me, { company: "Acme", role: "Backend Engineer", jd: "Go and Postgres." });
check("the company is named", prompt.includes("COMPANY: Acme"), true);
check("and the role", prompt.includes("ROLE: Backend Engineer"), true);
check("the resume is included", prompt.includes("CHIRAG KASHYAP"), true);
check("and the posting", prompt.includes("Go and Postgres."), true);
// A missing posting must say so rather than leave a blank the model fills in.
check("a missing posting is admitted",
  buildCoverText(me, { company: "A", role: "B", jd: "" }).includes("none given"), true);
check("the model is given a length", COVER_SYSTEM_PROMPT.includes("120 to 180 words"), true);
check("and told not to invent", COVER_SYSTEM_PROMPT.toLowerCase().includes("never invent"), true);
check("and to skip the greeting", COVER_SYSTEM_PROMPT.toLowerCase().includes("no greeting"), true);

section("checking the letter before it is shown");
const good = `I am applying for the Backend Engineer role at Acme. ${"word ".repeat(120)}`;
check("a sound letter has no problems", coverProblems(good, me), []);
check("an empty one says so", coverProblems("   ", me).length, 1);
check("a short one is caught", coverProblems("Too short.", me)[0].includes("only"), true);
check("a greeting is caught",
  coverProblems(`Dear Hiring Manager, ${"word ".repeat(120)}`, me).some((p) => p.includes("greeting")), true);
check("a placeholder is caught",
  coverProblems(`I want to join [Company Name]. ${"word ".repeat(120)}`, me).some((p) => p.includes("placeholder")), true);
check("a very long one is caught",
  coverProblems("word ".repeat(300), me).some((p) => p.includes("words")), true);

section("folding text into a PDF's one typeface");
check("a curly quote becomes straight", toLatin1("don’t"), "don't");
check("an em dash becomes a hyphen", toLatin1("a — b"), "a - b");
check("an ellipsis is spelled out", toLatin1("wait…"), "wait...");
check("a rupee sign is spelled out", toLatin1("₹500"), "Rs.500");
check("something with no glyph is marked", toLatin1("你好"), "??");
check("plain text is untouched", toLatin1("Hello, world."), "Hello, world.");

section("wrapping it");
check("a short line stays one line", wrapLines("hello there", 40), ["hello there"]);
check("a long one is split", wrapLines("aaa bbb ccc ddd", 7), ["aaa bbb", "ccc ddd"]);
check("a blank line is kept", wrapLines("a\n\nb", 40), ["a", "", "b"]);
// A word longer than the line would otherwise run off the page.
check("an unbreakable word is cut", wrapLines("abcdefghij", 4), ["abcd", "efgh", "ij"]);
check("no line exceeds the width",
  wrapLines("the quick brown fox jumps over the lazy dog", 10).every((l) => l.length <= 10), true);

section("the PDF itself");
const pdf = textToPdf("Hello (world) \\ and a longer line that will need wrapping somewhere along it.");
const raw = pdf.toString("latin1");
check("it is a PDF", raw.startsWith("%PDF-"), true);
check("and ends properly", raw.trimEnd().endsWith("%%EOF"), true);
check("it has a catalog", raw.includes("/Type /Catalog"), true);
check("a page", raw.includes("/Type /Page"), true);
check("and a font", raw.includes("/BaseFont /Helvetica"), true);
check("the text is in there", raw.includes("Hello"), true);
// Unescaped, these would end the string literal early and corrupt the file.
check("a bracket is escaped", raw.includes("\\(world\\)"), true);
check("a backslash is escaped", raw.includes("\\\\"), true);

// The cross-reference offsets are the part that silently breaks: if they
// are wrong the file still looks fine and no reader will open it.
const xrefAt = Number(raw.slice(raw.lastIndexOf("startxref")).match(/startxref\s+(\d+)/)[1]);
check("startxref points at the table", raw.slice(xrefAt, xrefAt + 4), "xref");
const offsets = [...raw.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
check("every object is listed", offsets.length >= 5, true);
check("and every offset lands on its object",
  offsets.every((at, i) => raw.slice(at).startsWith(`${i + 1} 0 obj`)), true);

// A letter longer than a page has to produce more than one.
const long = textToPdf("line\n".repeat(200));
check("a long letter spills onto more pages", (long.toString("latin1").match(/\/Type \/Page[^s]/g) || []).length > 1, true);
check("the page count matches the kids",
  Number(long.toString("latin1").match(/\/Count (\d+)/)[1]),
  (long.toString("latin1").match(/\/Type \/Page[^s]/g) || []).length);

section("naming the file");
check("it is findable in a folder",
  coverLetterFilename("Chirag Kashyap", "Acme Corp"), "Chirag-Kashyap-cover-letter-Acme-Corp.pdf");
check("no company still works", coverLetterFilename("Chirag Kashyap", ""), "Chirag-Kashyap-cover-letter.pdf");
check("no name either", coverLetterFilename("", ""), "cover-letter.pdf");
check("punctuation is stripped", coverLetterFilename("A. B.", "X & Y"), "A-B-cover-letter-X-Y.pdf");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

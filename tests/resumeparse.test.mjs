// Reading a resume PDF back into the profile.
const { ParsedResumeSchema, RESUME_FIELDS, RESUME_SYSTEM_PROMPT, applyParsed, changedBy, describeParse, filledFields, parsedPatch, EMPTY_PROFILE } =
  await import("./.resumeparse.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const parse = (over = {}) =>
  ParsedResumeSchema.parse({
    fullName: "Chirag Kashyap",
    headline: "Full Stack Developer",
    email: "chirag@example.com",
    phone: "9876543210",
    location: "Noida, Uttar Pradesh",
    linkedin: "linkedin.com/in/chirag",
    github: "github.com/chirag",
    portfolio: "chirag.dev",
    yearsExperience: "2",
    skills: "React, Next.js, Node.js",
    resumeText: "CHIRAG KASHYAP\nFull Stack Developer\nEXPERIENCE\n...",
    ...over,
  });

section("the shape that comes back");
// Every field defaults, so a model that omits one does not break the parse.
check("a missing field becomes empty", ParsedResumeSchema.parse({}).skills, "");
check("all the fields are accounted for", RESUME_FIELDS.length, 11);
check("resume text is one of them", RESUME_FIELDS.includes("resumeText"), true);
// Nothing outside this list may be touched by a parse.
check("the Gmail password is not", RESUME_FIELDS.includes("gmailAppPassword"), false);
check("nor the attachment", RESUME_FIELDS.includes("resumeFileData"), false);
check("nor the tone", RESUME_FIELDS.includes("tone"), false);

section("which fields the resume actually spoke to");
check("a full parse fills everything", filledFields(parse()).length, 11);
check("blanks are not counted", filledFields(parse({ github: "", portfolio: "" })).length, 9);
check("neither is whitespace", filledFields(parse({ github: "   " })).includes("github"), false);
check("an empty parse fills nothing", filledFields(ParsedResumeSchema.parse({})), []);

section("applying it over what is already there");
const mine = { ...EMPTY_PROFILE, portfolio: "typed-by-hand.dev", tone: "direct", signOff: "Thanks" };
const applied = applyParsed(mine, parse({ portfolio: "" }));
check("the skills come from the resume", applied.skills, "React, Next.js, Node.js");
check("so does the headline", applied.headline, "Full Stack Developer");
check("and the resume text", applied.resumeText.startsWith("CHIRAG KASHYAP"), true);
// A resume that omits a link must not wipe one that was typed in.
check("a field the resume omits is left alone", applied.portfolio, "typed-by-hand.dev");
check("the tone is not a resume's business", applied.tone, "direct");
check("nor the sign-off", applied.signOff, "Thanks");
check("values are trimmed", applyParsed(mine, parse({ skills: "  React  " })).skills, "React");

section("a parse is a patch, so it cannot erase the file it came from");
// The bug this pins: applying a parse built from a profile captured before
// the upload wrote that stale copy back, and the attachment disappeared
// from the form seconds after being chosen.
const patch = parsedPatch(parse());
check("the patch names only resume fields", Object.keys(patch).every((k) => RESUME_FIELDS.includes(k)), true);
check("the attachment data is not in it", "resumeFileData" in patch, false);
check("nor the file name", "resumeFileName" in patch, false);
check("nor the file type", "resumeFileType" in patch, false);
check("nor the Gmail password", "gmailAppPassword" in patch, false);
// Merged over a profile that has a file attached, the file survives.
const withFile = { ...EMPTY_PROFILE, resumeFileName: "new.pdf", resumeFileData: "JVBER", resumeFileType: "application/pdf" };
const merged = { ...withFile, ...patch };
check("the file name survives the merge", merged.resumeFileName, "new.pdf");
check("so does the file itself", merged.resumeFileData, "JVBER");
check("and the skills still arrive", merged.skills, "React, Next.js, Node.js");
check("a parse that found nothing is an empty patch", parsedPatch(ParsedResumeSchema.parse({})), {});

section("what a parse would change, before it changes it");
const already = { ...EMPTY_PROFILE, ...parse() };
check("nothing, when it all matches", changedBy(already, parse()), []);
check("just the one field that differs", changedBy(already, parse({ skills: "React, Vue" })), ["skills"]);
check("a blank in the parse is not a change", changedBy(already, parse({ skills: "" })), []);
check("everything, against an empty profile", changedBy(EMPTY_PROFILE, parse()).length, 11);
// Whitespace-only differences are not worth undoing.
check("trailing space is not a change", changedBy(already, parse({ skills: "React, Next.js, Node.js  " })), []);

section("what the form is told");
const summary = describeParse(parse());
check("it names the role", summary.includes("Full Stack Developer"), true);
check("and the experience", summary.includes("2 year(s)"), true);
check("and counts the skills", summary.includes("3 skills"), true);
check("and the resume text", summary.includes("characters of resume text"), true);
check("it asks for a check", summary.toLowerCase().includes("correct"), true);
check("an empty parse says so", describeParse(ParsedResumeSchema.parse({})), "Nothing could be read from that file.");

section("what the model is told");
check("not to embellish", RESUME_SYSTEM_PROMPT.toLowerCase().includes("do not improve"), true);
check("to leave unknowns empty", RESUME_SYSTEM_PROMPT.toLowerCase().includes("empty string"), true);
check("never to guess", RESUME_SYSTEM_PROMPT.toLowerCase().includes("never guess"), true);
// resumeText is what an email is written from, so it cannot be abridged.
check("that the resume text must be whole", RESUME_SYSTEM_PROMPT.toLowerCase().includes("nothing may be left out"), true);
check("that skills are comma separated", RESUME_SYSTEM_PROMPT.toLowerCase().includes("comma separated"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

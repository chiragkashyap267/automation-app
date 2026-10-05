// The autofill brain: reading what a form field is asking for.
// fields.js is a browser script, so it is run here rather than imported.
import { readFileSync } from "node:fs";

new Function(readFileSync("extension/fields.js", "utf8"))();
const { normalizeLabel, classify, splitName, cityFrom, valueFor, NEVER_FILL } = globalThis.JDFields;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

section("reading a label the way a person would");
check("a required marker is noise", normalizeLabel("First Name *"), "first name");
check("so is a parenthetical", normalizeLabel("Phone (optional)"), "phone");
// Workday generates ids rather than labels, so the id has to be readable.
check("camelCase becomes words", normalizeLabel("legalNameSection_firstName"), "legal name section first name");
check("kebab-case too", normalizeLabel("email-address"), "email address");
check("and dotted ids", normalizeLabel("candidate.lastName"), "candidate last name");
check("whitespace collapses", normalizeLabel("  Full   Name \n"), "full name");
check("nothing stays nothing", normalizeLabel(""), "");

section("the order of the rules matters");
// "first name" and "last name" both contain "name"; a bare name rule last.
check("first name is not read as a name", classify("First Name"), "firstName");
check("last name is not read as a name", classify("Last Name"), "lastName");
check("surname is a last name", classify("Surname"), "lastName");
check("given name is a first name", classify("Given Name"), "firstName");
check("a bare name is a full name", classify("Name"), "fullName");
check("full name is a full name", classify("Full Name"), "fullName");

section("the fields every form asks for");
check("email", classify("Email"), "email");
check("e-mail with a hyphen", classify("E-Mail Address"), "email");
check("phone", classify("Phone"), "phone");
check("mobile number", classify("Mobile Number"), "phone");
check("linkedin", classify("LinkedIn Profile"), "linkedin");
check("linked in as two words", classify("Linked In URL"), "linkedin");
check("github", classify("GitHub"), "github");
check("portfolio", classify("Portfolio"), "portfolio");
check("website", classify("Website"), "portfolio");
check("city", classify("City"), "city");
check("country", classify("Country"), "country");
check("location", classify("Current Location"), "location");
check("resume", classify("Resume/CV"), "resume");
check("experience in years", classify("Total Years of Experience"), "experience");
check("a Workday id works too", classify("legalNameSection_firstName"), "firstName");

section("the questions every form asks that the app does not store");
check("country", classify("Country"), "country");
check("country of residence", classify("Country of Residence"), "country");
check("gender", classify("Gender"), "gender");
check("sex", classify("Sex"), "gender");
// A different question entirely, and not one to answer from a setting.
check("sexual orientation is not gender", classify("Sexual Orientation"), null);
check("nationality", classify("Nationality"), "nationality");
check("citizenship", classify("Citizenship"), "nationality");

section("those answers come from the extension's own options");
const withExtras = {
  location: "Noida, Uttar Pradesh",
  country: "India",
  gender: "Male",
  nationality: "Indian",
};
check("country is what you set", valueFor("country", withExtras), "India");
check("gender is what you set", valueFor("gender", withExtras), "Male");
check("nationality is what you set", valueFor("nationality", withExtras), "Indian");
// Unset gender must leave the radio group alone, not guess at it.
check("unset gender fills nothing", valueFor("gender", { location: "Noida" }), null);
check("country is worked out when unset", valueFor("country", { location: "Noida, Uttar Pradesh" }), "India");
check("a non-Indian address is not called India", valueFor("country", { location: "Berlin, Germany" }), null);

section("what it refuses to answer for you");
// Salary and notice period cannot be un-said once submitted.
check("expected salary is recognised", classify("Expected CTC"), "expectedCtc");
check("and refused", NEVER_FILL.has("expectedCtc"), true);
check("current salary is refused", NEVER_FILL.has("currentCtc"), true);
check("notice period is refused", NEVER_FILL.has("noticePeriod"), true);
check("a cover letter is refused", NEVER_FILL.has("coverLetter"), true);
check("but an email is not", NEVER_FILL.has("email"), false);

section("fields it does not pretend to know");
check("a question of its own", classify("How did you hear about us?"), null);
check("a sponsorship question", classify("Do you require visa sponsorship?"), null);
check("gibberish", classify("xyzzy"), null);

section("splitting a name");
check("two parts", splitName("Chirag Kashyap"), { first: "Chirag", middle: "", last: "Kashyap" });
check("three parts put the middle in the middle", splitName("A B C"), { first: "A", middle: "B", last: "C" });
check("one part is a first name", splitName("Chirag"), { first: "Chirag", middle: "", last: "" });
check("extra spaces do not create empty parts", splitName("  Chirag   Kashyap  "), { first: "Chirag", middle: "", last: "Kashyap" });
check("nothing at all", splitName(""), { first: "", middle: "", last: "" });

section("the city out of a free-text location");
check("a comma separates it", cityFrom("Noida, Uttar Pradesh"), "Noida");
check("no comma is the whole thing", cityFrom("Bengaluru"), "Bengaluru");
check("nothing stays nothing", cityFrom(""), "");

section("what gets typed in");
const me = {
  fullName: "Chirag Kashyap",
  email: "chirag@example.com",
  phone: "9876543210",
  location: "Noida, Uttar Pradesh",
  linkedin: "linkedin.com/in/chirag",
  github: "",
  portfolio: "chiragkashyapwebdev.vercel.app",
  yearsExperience: "2",
};
check("first name", valueFor("firstName", me), "Chirag");
check("last name", valueFor("lastName", me), "Kashyap");
check("full name", valueFor("fullName", me), "Chirag Kashyap");
check("email", valueFor("email", me), "chirag@example.com");
check("city comes from the location", valueFor("city", me), "Noida");
check("country is worked out", valueFor("country", me), "India");
check("years of experience", valueFor("experience", me), "2");
// An empty profile field must leave the form field alone, not blank it.
check("an empty field offers nothing", valueFor("github", me), null);
check("an unknown kind offers nothing", valueFor("xyzzy", me), null);
check("an empty profile offers nothing", valueFor("email", {}), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

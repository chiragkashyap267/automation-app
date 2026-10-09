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

section("education, which Indian IT portals ask for in full");
// Order is everything here: "10th percentage" must not fall through to the
// bare "percentage" rule that belongs to graduation.
check("10th marks", classify("10th Percentage"), "tenthMarks");
check("SSC marks", classify("SSC Marks"), "tenthMarks");
check("10th passing year", classify("10th Passing Year"), "tenthYear");
check("10th board", classify("10th Board"), "tenthBoard");
check("12th marks", classify("12th Percentage"), "twelfthMarks");
check("HSC marks", classify("HSC Marks"), "twelfthMarks");
check("12th passing year", classify("12th Year of Passing"), "twelfthYear");
check("12th board", classify("Intermediate Board"), "twelfthBoard");
check("graduation year", classify("Graduation Passing Year"), "gradYear");
check("a bare percentage is graduation", classify("Percentage"), "gradMarks");
check("CGPA is graduation", classify("CGPA"), "gradMarks");
check("college", classify("College Name"), "college");
check("university", classify("University"), "college");
check("branch", classify("Branch / Specialization"), "branch");
check("degree", classify("Highest Qualification"), "degree");
check("date of birth", classify("Date of Birth"), "dob");
check("DOB abbreviated", classify("DOB"), "dob");

section("current employment");
check("current employer", classify("Current Company"), "currentCompany");
check("current designation", classify("Current Designation"), "currentDesignation");

section("those answers are typed once in the options");
const student = {
  location: "Noida",
  headline: "Full Stack Developer",
  tenthMarks: "88.4",
  tenthYear: "2019",
  tenthBoard: "CBSE",
  twelfthMarks: "79.2",
  degree: "B.Tech",
  branch: "Computer Science",
  college: "ABC Institute of Technology",
  gradMarks: "7.8 CGPA",
  gradYear: "2025",
  dob: "12/05/2003",
};
check("10th marks", valueFor("tenthMarks", student), "88.4");
check("10th board", valueFor("tenthBoard", student), "CBSE");
check("degree", valueFor("degree", student), "B.Tech");
check("college", valueFor("college", student), "ABC Institute of Technology");
check("graduation marks", valueFor("gradMarks", student), "7.8 CGPA");
check("date of birth", valueFor("dob", student), "12/05/2003");
// Falls back to the headline, which is the same answer in practice.
check("designation falls back to the headline", valueFor("currentDesignation", student), "Full Stack Developer");
check("an unset education field stays empty", valueFor("twelfthBoard", student), null);

section("identity numbers are recognised so they can be refused by name");
// A wrong government number can invalidate an application outright, and
// none of these belong in extension storage to begin with.
check("PAN", classify("PAN Number"), "pan");
check("Aadhaar", classify("Aadhaar Number"), "aadhaar");
check("passport", classify("Passport Number"), "passport");
check("bank account", classify("Bank Account Number"), "bank");
check("IFSC", classify("IFSC Code"), "bank");
check("UAN", classify("UAN / PF Number"), "uan");
check("a password field", classify("Password"), "password");
check("a captcha", classify("Enter Captcha"), "captcha");
check("PAN is refused", NEVER_FILL.has("pan"), true);
check("Aadhaar is refused", NEVER_FILL.has("aadhaar"), true);
check("passport is refused", NEVER_FILL.has("passport"), true);
check("bank details are refused", NEVER_FILL.has("bank"), true);
check("UAN is refused", NEVER_FILL.has("uan"), true);
check("passwords are refused", NEVER_FILL.has("password"), true);
check("captchas are refused", NEVER_FILL.has("captcha"), true);
// And the ordinary fields are not caught by any of that.
check("but a plain email is still filled", NEVER_FILL.has("email"), false);
check("and 10th marks are still filled", NEVER_FILL.has("tenthMarks"), false);

section("what it refuses to answer for you");
// Salary and notice period cannot be un-said once submitted.
check("expected salary is recognised", classify("Expected CTC"), "expectedCtc");
check("and refused", NEVER_FILL.has("expectedCtc"), true);
check("current salary is refused", NEVER_FILL.has("currentCtc"), true);
check("notice period is refused", NEVER_FILL.has("noticePeriod"), true);
check("but an email is not", NEVER_FILL.has("email"), false);
// A cover letter used to be refused along with these, because the only
// thing to put in the box was something generic. It is written for the
// posting now, so the box is answered -- but still only when a letter
// exists for this application, never from a stock paragraph.
check("a cover letter is no longer refused outright", NEVER_FILL.has("coverLetter"), false);
check("and is still recognised", classify("Cover letter"), "coverLetter");
check("with nothing written, nothing is typed", valueFor("coverLetter", { fullName: "X" }), null);
check("a letter for this application is used",
  valueFor("coverLetter", { coverLetter: "Dear Acme, ..." }), "Dear Acme, ...");

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

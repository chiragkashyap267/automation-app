// Picking and naming the resume, reading a raw email, spotting a posting.
const {
  describeResumeChoice, pickResumeUrl, resumeFileNameFor, resumeVariants,
  extractPlainText, stripHtml, withoutQuotedReply, looksLikeJobPosting,
} = await import("./.resume.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

section("choosing a resume");
const env = {
  RESUME_URL: "https://x/general.pdf",
  RESUME_URL_QA: "https://x/qa.pdf",
  RESUME_URL_DATA_ENGINEER: "https://x/data-eng.pdf",
  RESUME_URL_DATA: "https://x/data.pdf",
  NOT_A_RESUME: "https://x/nope.pdf",
  RESUME_URL_EMPTY: "   ",
};
check("a QA role gets the QA resume", pickResumeUrl("QA Engineer", env), "https://x/qa.pdf");
check("anything else gets the default", pickResumeUrl("Frontend Developer", env), "https://x/general.pdf");
check("no role at all gets the default", pickResumeUrl("", env), "https://x/general.pdf");
// The more specific label has to win, or "data" would swallow every data role.
check("the longest match wins", pickResumeUrl("Senior Data Engineer", env), "https://x/data-eng.pdf");
check("a shorter one still matches alone", pickResumeUrl("Data Analyst", env), "https://x/data.pdf");
check("unrelated variables are ignored", resumeVariants(env).some((v) => v.keyword === "not a resume"), false);
check("a blank variant is ignored", resumeVariants(env).some((v) => v.keyword === "empty"), false);
check("no variants means no default either", pickResumeUrl("QA", {}), "");
check("the choice can be named", describeResumeChoice("QA Engineer", env), "qa");
check("and is empty when the default was used", describeResumeChoice("Designer", env), "");

section("naming the file");
// "resume.pdf" is unfindable in a folder of two hundred of them.
check("name and role", resumeFileNameFor("Chirag Kashyap", "QA Engineer"), "Chirag-Kashyap-QA-Engineer.pdf");
check("the extension is kept", resumeFileNameFor("Chirag Kashyap", "QA", "cv.docx"), "Chirag-Kashyap-QA.docx");
check("punctuation is dropped", resumeFileNameFor("Chirag Kashyap", "Engineer (Backend), Level II"), "Chirag-Kashyap-Engineer-Backend-Level-II.pdf");
check("no role still names the person", resumeFileNameFor("Chirag Kashyap", ""), "Chirag-Kashyap.pdf");
check("nothing to go on falls back", resumeFileNameFor("", "", "resume.pdf"), "resume.pdf");
check("a very long title is cut", resumeFileNameFor("A B", "Senior Principal Distinguished Staff Engineer Level Nine").length < 70, true);

section("reading a raw email");
const CRLF = "\r\n";
const plain = [
  "From: Recruiter <hr@acme.com>", "Subject: Opening", "Content-Type: text/plain; charset=utf-8",
  "", "We are hiring a Backend Engineer.", "Send your resume.",
].join(CRLF);
check("a plain message", extractPlainText(plain), "We are hiring a Backend Engineer.\nSend your resume.");

const qp = [
  "Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable",
  "", "We are hiring a Backend Engineer with 3=2B years and a=", " strong CV.",
].join(CRLF);
check("quoted-printable is decoded", extractPlainText(qp).includes("3+ years"), true);
check("a soft line break is joined", extractPlainText(qp).includes("and a strong CV"), true);

const b64 = [
  "Content-Type: text/plain", "Content-Transfer-Encoding: base64",
  "", Buffer.from("We are hiring a QA Engineer.").toString("base64"),
].join(CRLF);
check("base64 is decoded", extractPlainText(b64), "We are hiring a QA Engineer.");

const multipart = [
  'Content-Type: multipart/alternative; boundary="XYZ"', "",
  "--XYZ", "Content-Type: text/plain", "", "The plain version.", "",
  "--XYZ", "Content-Type: text/html", "", "<p>The HTML version.</p>", "", "--XYZ--",
].join(CRLF);
check("text/plain is preferred", extractPlainText(multipart), "The plain version.");

const htmlOnly = [
  'Content-Type: multipart/alternative; boundary="XYZ"', "",
  "--XYZ", "Content-Type: text/html", "",
  "<div>We are hiring.</div><p>Apply now.</p>", "", "--XYZ--",
].join(CRLF);
check("HTML is used when that is all there is", extractPlainText(htmlOnly), "We are hiring.\nApply now.");
check("scripts are dropped", stripHtml("<script>bad()</script><p>Good</p>").trim(), "Good");
check("entities are decoded", stripHtml("R&amp;D &lt;team&gt;").trim(), "R&D <team>");

check(
  "the quoted history is dropped",
  withoutQuotedReply("My reply here.\n\nOn Tue, 3 Mar 2026, Bob wrote:\n> old stuff"),
  "My reply here.",
);
check("a message with no quote is untouched", withoutQuotedReply("Just this."), "Just this.");

section("spotting a posting");
const posting = {
  from: "priya@acme.com",
  subject: "Opening for Backend Engineer",
  text: "Hi, we are looking for a Backend Engineer with 3 years of experience in Node and React. Notice period and expected CTC please. Kindly share your updated resume so we can take this forward this week.",
};
check("a recruiter's posting is caught", looksLikeJobPosting(posting).ok, true);

// A digest has nobody to reply to, so a draft from one is a dead letter.
check("a no-reply sender is rejected", looksLikeJobPosting({ ...posting, from: "no-reply@acme.com" }).ok, false);
check("a job alert is rejected", looksLikeJobPosting({ ...posting, from: "jobs-listings@linkedin.com" }).ok, false);
check("and it says why", looksLikeJobPosting({ ...posting, from: "no-reply@acme.com" }).reason, "nobody reads that address");

// Replies to our own applications are not new postings.
check(
  "a rejection is not a posting",
  looksLikeJobPosting({ from: "hr@acme.com", subject: "Your application", text: "Unfortunately we have decided to proceed with other candidates at this time. We will keep your resume on file for future openings that may suit you." }).ok,
  false,
);
check(
  "an interview invite is not a posting",
  looksLikeJobPosting({ from: "hr@acme.com", subject: "Interview invitation", text: "We would like to schedule a call with you this week to discuss the role further. Please let us know your availability for an interview on Thursday." }).ok,
  false,
);

check(
  "chit-chat is not a posting",
  looksLikeJobPosting({ from: "mum@example.com", subject: "Dinner", text: "Are you coming over on Sunday? Let me know what you would like to eat and I will get it ready before you arrive home from work." }).ok,
  false,
);
check(
  "a newsletter is rejected",
  looksLikeJobPosting({ from: "news@site.com", subject: "Jobs this week", text: "We are hiring across the industry. " + "https://x.com/a ".repeat(20) + " unsubscribe" }).ok,
  false,
);
// One line saying "we are hiring" is not enough to write an application from.
check(
  "too little to work with is rejected",
  looksLikeJobPosting({ from: "hr@acme.com", subject: "Hi", text: "We are hiring." }).ok,
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

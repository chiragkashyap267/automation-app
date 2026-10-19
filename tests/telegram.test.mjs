// The bot stores the draft in the message text and parses it back on Send.
// If that round-trip is wrong, the wrong email goes out — so test it directly.
import { readFileSync } from "node:fs";

const { renderDraft, parseDraft, stripTrailingNotes, withNotes } =
  await import("./.draft.bundle.mjs");

// Some sections below still lift small pure helpers straight out of the
// route, which has no module of its own to import.
const src = readFileSync("app/api/telegram/route.ts", "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const BODY = `Dear Rahul Mehta,

I am applying for the Backend Engineer role, CMT-2291.

At Labhyansh I built Node.js APIs.

I would welcome a brief call.

Best regards,
Chirag Kashyap
+91 95481 74325
chiragkashyap26712@gmail.com
LinkedIn: https://linkedin.com/in/chiragkashyap267`;

const rendered = renderDraft("Cloudmint", "Backend Engineer", ["rahul.mehta@cloudmint.io"], "Backend Engineer - CMT-2291", BODY);
const back = parseDraft(rendered);

check("recipient survives the round-trip", back.to, ["rahul.mehta@cloudmint.io"]);
check("subject survives the round-trip", back.subject, "Backend Engineer - CMT-2291");
check("body survives byte-for-byte", back.body, BODY);
check("the signature is still attached", back.body.includes("linkedin.com/in/chiragkashyap267"), true);
check("blank lines inside the body are preserved", (back.body.match(/\n\n/g) || []).length, (BODY.match(/\n\n/g) || []).length);

const multi = parseDraft(renderDraft("A", "B", ["x@y.com", "z@y.com"], "S", "Dear Team,\n\nHi."));
check("several recipients survive", multi.to, ["x@y.com", "z@y.com"]);

// A body whose own text contains "Subject:" must not confuse the parser.
const tricky = parseDraft(renderDraft("A", "B", ["x@y.com"], "Real subject", "Dear Team,\n\nPut Subject: the role in your reply."));
check("a later 'Subject:' in the body does not hijack the header", tricky.subject, "Real subject");
check("the tricky body is intact", tricky.body, "Dear Team,\n\nPut Subject: the role in your reply.");

check("garbage in gives null, not a bad send", parseDraft("just some text"), null);

// Resume links: a share URL points at a viewer page, not the file.
// The resume helpers moved to lib/resumeFetch so the scheduled send could
// use them too; they are imported rather than lifted out of the route.
const h = await import("./.resume.bundle.mjs");

check(
  "a Drive /view link becomes a direct download",
  h.resolveResumeUrl("https://drive.google.com/file/d/1fCVAsfBgcUEVD7LxZgaF8rgGM1qD1HA1/view?usp=sharing"),
  "https://drive.google.com/uc?export=download&id=1fCVAsfBgcUEVD7LxZgaF8rgGM1qD1HA1",
);
check(
  "a Drive open?id link is converted too",
  h.resolveResumeUrl("https://drive.google.com/open?id=ABC123xyz"),
  "https://drive.google.com/uc?export=download&id=ABC123xyz",
);
check(
  "a Google Doc is exported as PDF",
  h.resolveResumeUrl("https://docs.google.com/document/d/DOC99/edit"),
  "https://docs.google.com/document/d/DOC99/export?format=pdf",
);
check(
  "a Dropbox preview link becomes a download",
  h.resolveResumeUrl("https://www.dropbox.com/s/abc/cv.pdf?dl=0"),
  "https://www.dropbox.com/s/abc/cv.pdf?dl=1",
);
check(
  "a plain direct URL is left alone",
  h.resolveResumeUrl("https://example.com/cv.pdf"),
  "https://example.com/cv.pdf",
);

process.env.RESUME_FILENAME = "Chirag_KashyapCV";
check("a missing .pdf extension is added", h.resumeFilename(), "Chirag_KashyapCV.pdf");
process.env.RESUME_FILENAME = "cv.pdf";
check("an existing .pdf extension is not doubled", h.resumeFilename(), "cv.pdf");

// /ask parsing decides whether a message is a cold enquiry or a job posting.
const askSrc = src.slice(src.indexOf("const EMAIL_ONLY"), src.indexOf("async function handleAsk"));
const a = await import(
  "data:text/javascript," +
    encodeURIComponent(
      askSrc
        .replace(/:\s*\{ email: string; role: string \}\s*\|\s*null/g, "")
        .replace(/:\s*string/g, "")
        .replace(/\bfunction parseAsk/, "export function parseAsk")
    )
);

check("/ask with a role", a.parseAsk("/ask hr@acme.io Backend Engineer"), {
  email: "hr@acme.io",
  role: "Backend Engineer",
});
check("/ask without a role falls back later", a.parseAsk("/ask hr@acme.io"), {
  email: "hr@acme.io",
  role: "",
});
check("a bare address is an enquiry", a.parseAsk("hr@acme.io"), { email: "hr@acme.io", role: "" });
check("the address is lowercased", a.parseAsk("/ask HR@Acme.IO").email, "hr@acme.io");
check("a job description is not mistaken for an enquiry", a.parseAsk("Hiring a dev, mail hr@acme.io"), null);
check(
  "an address followed by prose is left to the JD path",
  a.parseAsk("hr@acme.io please consider me for backend roles"),
  null,
);
check("plain text is not an enquiry", a.parseAsk("hello there"), null);

// A pitch has to survive the round trip through the message text, because
// that text is the only state between showing a draft and tapping Send.
{
  const pitch = renderDraft("Freshbite", "packaging", ["hi@freshbite.in"], "Packaging for Freshbite", "Hello,\n\nBody here.", "", "pitch");
  const back = parseDraft(pitch);
  check("a pitch is marked as one", back.kind, "pitch");
  check("its body is unchanged", back.body, "Hello,\n\nBody here.");
  check("its recipient survives", back.to, ["hi@freshbite.in"]);
  // The marker must not leak into what the recipient reads.
  check("the marker is not in the body", back.body.includes("Kind:"), false);

  const application = parseDraft(renderDraft("Acme", "Dev", ["a@b.com"], "Application", "Dear Team,\n\nBody."));
  check("an application defaults to application", application.kind, "application");
  check(
    "an old draft with no marker still parses",
    parseDraft("📬 Acme — Dev\n\nTo: a@b.com\nSubject: X\n\nBody").kind,
    "application",
  );
}

section("the bot's own remarks must never reach the employer");
// This one went out for real: a warning printed under the signature, in
// the email, to the company. The body was read as "everything after the
// Subject line", and the warning had been appended to the same message.
const WARNED_BODY =
  "Dear Team,\n\nI am applying for the role.\n\nBest regards,\nCHIRAG KASHYAP\n+91 9548174325";
const warned = withNotes(
  renderDraft("Tramo", "Full-Stack Web Developer", ["hr@tramo.in"], "Application", WARNED_BODY),
  ["⚠️ You wrote to hr@tramo.in 5 days ago. Sending again may read as spam."],
);
const sent = parseDraft(warned);
check("the warning is not in the email", sent.body.includes("read as spam"), false);
check("the body is intact", sent.body, WARNED_BODY);
check("the recipient still parses", sent.to, ["hr@tramo.in"]);
check("and the company, though a note sits above it", sent.company, "Tramo");
check("and the role", sent.role, "Full-Stack Web Developer");
check("the warning is still shown to you", warned.includes("read as spam"), true);
check(
  "and above the draft, where it is read before the thumb reaches Send",
  warned.indexOf("read as spam") < warned.indexOf("📬"),
  true,
);

const manyNotes = parseDraft(
  withNotes(renderDraft("A", "B", ["x@y.com"], "S", WARNED_BODY), [
    "♻️ Written from a saved recipe — no API call.",
    "⚠️ You wrote to A 3 days ago. Sending again may read as spam.",
  ]),
);
check("several notes, none of them in the email", manyNotes.body, WARNED_BODY);
check(
  "a draft with no notes is unchanged",
  parseDraft(renderDraft("A", "B", ["x@y.com"], "S", WARNED_BODY)).body,
  WARNED_BODY,
);

section("drafts already sitting in the chat");
// Telegram keeps old messages and their Send buttons still work, so a
// draft posted before this fix has its notes underneath. The parser has
// to cope with that shape too, or the bug outlives its own repair.
const legacy =
  renderDraft("Tramo", "Dev", ["hr@tramo.in"], "Application", WARNED_BODY) +
  "\n\n⚠️ You wrote to hr@tramo.in 5 days ago. Sending again may read as spam.";
check("an old draft is cleaned on the way out", parseDraft(legacy).body, WARNED_BODY);

const legacyMany =
  renderDraft("A", "B", ["x@y.com"], "S", WARNED_BODY) +
  "\n\n♻️ Written from a saved recipe — no API call." +
  "\n⚠️ Check x@y.com against the posting.";
check("so is one carrying several", parseDraft(legacyMany).body, WARNED_BODY);

section("what the stripper will not touch");
check("ordinary prose survives", stripTrailingNotes(WARNED_BODY), WARNED_BODY);
// Only at the end, and only the bot's own markers: an email body is
// prose and a signature, and neither begins a line with a warning sign.
check(
  "a marker in the middle is left alone",
  stripTrailingNotes("Hello\n⚠️ odd line\n\nReal ending."),
  "Hello\n⚠️ odd line\n\nReal ending.",
);
check("trailing blank lines go", stripTrailingNotes("Body.\n\n\n"), "Body.");
check("an empty body stays empty", stripTrailingNotes(""), "");
check("a body of nothing but a note becomes empty", stripTrailingNotes("⛔ nope"), "");
check("withNotes with nothing to say changes nothing", withNotes("draft", []), "draft");
check("blank notes are dropped", withNotes("draft", ["", "  "]), "draft");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

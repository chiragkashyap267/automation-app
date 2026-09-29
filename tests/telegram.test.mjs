// The bot stores the draft in the message text and parses it back on Send.
// If that round-trip is wrong, the wrong email goes out — so test it directly.
import { readFileSync } from "node:fs";

const src = readFileSync("app/api/telegram/route.ts", "utf8");
// Lift the two pure functions out of the route rather than booting Next.
const body = src.slice(src.indexOf("function renderDraft"), src.indexOf("const HELP"));
const mod = await import(
  "data:text/javascript," +
    encodeURIComponent(
      body.replace(/:\s*string\[\]/g, "").replace(/:\s*string/g, "").replace(/\bfunction /g, "export function ")
    )
);
const { renderDraft, parseDraft } = mod;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

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
const helpers = src.slice(src.indexOf("export function resolveResumeUrl"), src.indexOf("type ResumeResult"));
const h = await import(
  "data:text/javascript," +
    encodeURIComponent(helpers.replace(/:\s*string/g, "").replace(/\bexport function /g, "export function "))
);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

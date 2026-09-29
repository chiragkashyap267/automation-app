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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

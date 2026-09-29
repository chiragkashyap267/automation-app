// Reader selection and cross-provider failover.
// A spent Gemini pool must not fail a text job that Groq can do.
for (let i = 1; i <= 2; i++) process.env[`GEMINI_API_KEY_${i}`] = `gem-${i}`;
process.env.GROQ_API_KEY_1 = "groq-1";
delete process.env.ANTHROPIC_API_KEY;

const { textReaders, visionReaders, readJobs, geminiPool, groqPool } = await import(
  "./.readers.bundle.mjs"
);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const FACTS = {
  company: "Acme", role: "Dev", location: "", reqId: "", recipients: ["a@b.com"],
  contactName: "", highlights: [], seniority: "", confidence: "high", notes: "",
};
const JOB = { ...FACTS, subject: "s", body: "b" };

check("text prefers groq over gemini", textReaders(), ["groq", "gemini"]);
check("vision cannot use groq", visionReaders(), ["gemini"]);

// Groq 429s on every key; the read must still succeed via Gemini.
let hits = [];
globalThis.fetch = async (url, init) => {
  const isGroq = String(url).includes("groq.com");
  hits.push(isGroq ? "groq" : "gemini");
  if (isGroq) return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ jobs: [JOB] }) }] }, finishReason: "STOP" }] }),
    { status: 200 },
  );
};
let out = await readJobs({ text: "a job", images: [] }, "full");
check("falls back to gemini when groq is spent", out.reader, "gemini");
check("groq was tried first", hits[0], "groq");
check("the job still came back", out.result.jobs[0].company, "Acme");

// The reverse: Gemini spent, Groq healthy — the case that just broke.
geminiPool.reset(); groqPool.reset();
hits = [];
globalThis.fetch = async (url) => {
  const isGroq = String(url).includes("groq.com");
  hits.push(isGroq ? "groq" : "gemini");
  if (!isGroq) return new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), { status: 429 });
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ jobs: [JOB] }) }, finish_reason: "stop" }] }),
    { status: 200 },
  );
};
out = await readJobs({ text: "a job", images: [] }, "full");
check("a spent gemini pool does not fail a text job", out.reader, "groq");
check("gemini was never even needed", hits.includes("gemini"), false);

// Images with only Gemini available, and Gemini spent: must fail, not silently use Groq.
geminiPool.reset(); groqPool.reset();
globalThis.fetch = async (url) =>
  String(url).includes("groq.com")
    ? new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 })
    : new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), { status: 429 });
const imgErr = await readJobs({ text: "x", images: [{ mediaType: "image/png", data: "AAA" }] }, "full")
  .then(() => null, (e) => e.message);
check("a screenshot never falls back to a blind reader", /Gemini key/i.test(imgErr || ""), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

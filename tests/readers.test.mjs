// Reader selection and cross-provider failover.
// A spent Gemini pool must not fail a text job that Groq can do.
for (let i = 1; i <= 2; i++) process.env[`GEMINI_API_KEY_${i}`] = `gem-${i}`;
process.env.GROQ_API_KEY_1 = "groq-1";
delete process.env.ANTHROPIC_API_KEY;

const { textReaders, visionReaders, readJobs, reviseIfNeeded, geminiPool, groqPool, markFailure } =
  await import("./.readers.bundle.mjs");

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

console.log("");
console.log("-- the one-shot draft is checked too");
{
  // The bot reads and writes in a single call to save quota, which used to
  // mean its drafts skipped the check that catches invented experience.
  const profile = {
    fullName: "Chirag Kashyap",
    resumeText: "Built React dashboards and REST APIs at Freelance. Next.js, TypeScript, Node.",
    skills: "React, Next.js, TypeScript, Node",
    portfolio: "",
    linkedin: "",
    github: "",
    signOff: "Best regards",
  };

  let calls = 0;
  const watched = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls += 1; return watched(...a); };

  const clean = {
    subject: "Application for Frontend Engineer",
    body: "Hello, I am applying for the Frontend Engineer role. I build React and Next.js interfaces in TypeScript, and have shipped REST APIs in Node. I would welcome the chance to talk about how that fits what you need from this position, and can share work on request.",
  };
  const ok = await reviseIfNeeded(profile, { company: "Acme", role: "Frontend Engineer" }, clean);
  check("a clean draft raises nothing", ok.problems, []);
  check("and is returned unchanged", ok.written.subject, clean.subject);
  // The whole point of checking locally is that it costs nothing.
  check("no model call is made for a clean draft", calls, 0);

  // The real failure this app produced: a duty invented and pinned on an
  // employer that IS in the resume. Long enough that the word-count rule
  // stays quiet and only the claim is reported.
  const invented = {
    subject: "Application for QA Engineer",
    body:
      "Hello, I am writing about the QA Engineer role you advertised. At Freelance I wrote " +
      "automated Selenium suites and owned the regression pipeline for three years, running " +
      "manual testing across releases and tracking every defect through to closure. That " +
      "background lines up closely with what this position appears to need day to day, and I " +
      "would be glad to walk through any of it with you at whatever length suits.",
  };
  const bad = await reviseIfNeeded(profile, { company: "Acme", role: "QA Engineer" }, invented);
  check("invented experience is caught", bad.problems.length > 0, true);
  check("the invented duty is named", /selenium|regression|manual testing/i.test(bad.problems.join(" ")), true);
  check("the length rule stays quiet", /words/.test(bad.problems.join(" ")), false);
  // With no keys configured there is nothing to revise with, and that must
  // return the draft plus its problems rather than throwing.
  check("no writer available still returns", bad.revised, false);

  globalThis.fetch = watched;
}

console.log("");
console.log("-- a spent provider stops going first");
{
  geminiPool.reset(); groqPool.reset();
  check("groq leads while it is healthy", textReaders(), ["groq", "gemini"]);

  // Ordering used to count how many keys a provider had, which does not
  // change when they stop working — so a dead key kept its place at the
  // front and burned a round trip on every single request.
  const spent = groqPool.keysToTry()[0];
  markFailure(spent, "daily-quota", "quota exhausted");

  check("a spent groq drops behind gemini", textReaders(), ["gemini", "groq"]);
  // It stays in the list: one stale attempt beats refusing to try.
  check("but it is still tried last", textReaders().includes("groq"), true);
  check("availability is what moved it", groqPool.available(), 0);
  check("its key is still counted", groqPool.count(), 1);

  geminiPool.reset(); groqPool.reset();
  check("a reset pool leads again", textReaders(), ["groq", "gemini"]);
}

console.log("");
console.log("-- the error names every provider, not just the first");
{
  geminiPool.reset(); groqPool.reset();
  globalThis.fetch = async (url) =>
    String(url).includes("groq.com")
      ? new Response(JSON.stringify({ error: { message: "groq daily quota exhausted" } }), { status: 429 })
      : new Response(JSON.stringify({ error: { code: 429, message: "gemini is rate limited" } }), { status: 429 });

  const message = await readJobs({ text: "a job", images: [] }, "full").then(() => "", (e) => e.message);

  // The old behaviour reported only the first failure, so the user was
  // always told it was Groq's fault whatever had actually gone wrong.
  check("both providers are named", /groq/i.test(message) && /gemini/i.test(message), true);
  check("it says they all failed", /All \d+ providers failed/.test(message), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

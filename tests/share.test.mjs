// What arrives from the phone's share sheet, and whether it is worth anything.
const { classifyShare, LINK_ONLY_NOTE } = await import("./.share.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const POST = `We are hiring a Frontend Developer at Acme Pvt Ltd in Noida.
Two years of React and TypeScript. Send your CV to careers@acme.example`;

section("a share with a real posting in it");
check("plain text is usable", classifyShare(POST).kind, "usable");
check("and comes back whole", classifyShare(POST).text, POST);
check("title and text are joined", classifyShare("Frontend Developer", POST).kind, "usable");
check("blank parts are dropped", classifyShare("", null, POST).text, POST);

section("a share that is only a link");
// LinkedIn hands over the URL, and that page needs a login to read.
check("a bare linkedin post", classifyShare("https://www.linkedin.com/posts/someone_activity-7123").kind, "link-only");
// A job listing is the exception: LinkedIn serves those to everyone, so it
// is routed to the reader instead of refused. See tests/linkedin.test.mjs.
check("a job listing link is readable", classifyShare("https://www.linkedin.com/jobs/view/4012345678").kind, "linkedin-job");
check("a link with a word in front", classifyShare("Hiring https://example.com/jobs/1").kind, "link-only");
check("a link given as the url part", classifyShare("", "", "https://example.com/j/1").kind, "link-only");

section("a share too thin to write from");
check("a title on its own", classifyShare("Frontend Developer").kind, "link-only");
check("eleven words is not enough", classifyShare("one two three four five six seven eight nine ten eleven").kind, "link-only");
check("twelve is", classifyShare("one two three four five six seven eight nine ten eleven twelve").kind, "usable");

section("nothing at all");
check("empty string", classifyShare("").kind, "empty");
check("only whitespace", classifyShare("   \n  ").kind, "empty");
check("nothing passed", classifyShare().kind, "empty");
check("all nulls", classifyShare(null, undefined, "").kind, "empty");

section("what the person is told");
check("the note names the way out", LINK_ONLY_NOTE.toLowerCase().includes("screenshot"), true);
check("and says why the link failed", LINK_ONLY_NOTE.toLowerCase().includes("login"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

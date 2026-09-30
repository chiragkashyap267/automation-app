// Reply sorting, re-application guard, the API guard, and secret stripping.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { classifyReply, priorApplication, guard, passwordRequired, stripSecrets } = await import(
  "./.newfeatures.bundle.mjs"
);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n── ${n}`);

section("reply classification");
check("an interview invite", classifyReply("Interview invitation for Backend Engineer").kind, "interview");
check("a calendar link counts", classifyReply("Next steps", "Please pick a slot: https://calendly.com/x").kind, "interview");
check("availability question", classifyReply("Re: application", "Would you be available for a call Thursday?").kind, "interview");
check("a plain rejection", classifyReply("Re: your application", "Unfortunately we have decided to proceed with other candidates.").kind, "rejection");
// The trap: rejections usually open by thanking you for applying.
check(
  "a rejection that thanks you is not an auto-reply",
  classifyReply("Thank you for applying", "Thank you for applying. Unfortunately we are not moving forward.").kind,
  "rejection",
);
check("an out of office", classifyReply("Out of Office: Re: application").kind, "auto");
check("an ATS acknowledgement", classifyReply("We have received your application").kind, "auto");
check("auto-replies are not notable", classifyReply("Automatic reply").notable, false);
check("a recruiter question", classifyReply("Re: application", "Could you share your expected CTC and notice period?").kind, "recruiter");
check("anything else is still notable", classifyReply("Quick question about your CV").notable, true);

section("re-application guard");
const now = Date.now();
store.set("jdmailer.history.v1", JSON.stringify([
  { id: "1", company: "Kulsys", role: "QA", to: ["career@kulsys.com"], sentAt: now - 4 * 86400000, reply: "awaiting", messageId: "" },
  { id: "2", company: "Acme", role: "Dev", to: ["hr@acme.com"], sentAt: now - 60 * 86400000, reply: "awaiting", messageId: "" },
]));
check("a recent application is found", priorApplication("Kulsys", [])?.daysAgo, 4);
check("matched by address too", priorApplication("", ["career@kulsys.com"])?.company, "Kulsys");
check("an old one is ignored", priorApplication("Acme", ["hr@acme.com"]), null);
check("an unrelated company is clear", priorApplication("Globex", ["jobs@globex.io"]), null);

section("api guard");
process.env.APP_PASSWORD = "hunter2";
check("a password is required once set", passwordRequired(), true);
const req = (pw) => new Request("https://x.test/api/write", { method: "POST", headers: pw ? { "x-app-password": pw } : {} });
check("no password is rejected", (await guard(req(null))).ok, false);
check("a wrong password is rejected", (await guard(req("nope"))).ok, false);
check("the right password passes", (await guard(req("hunter2"))).ok, true);
check("the rejection is a 401", (await guard(req("nope"))).status, 401);
delete process.env.APP_PASSWORD;
check("with no password set, requests pass", (await guard(req(null))).ok, true);

section("shared profile");
const stripped = stripSecrets({
  fullName: "Chirag", gmailUser: "me@gmail.com", gmailAppPassword: "abcd efgh ijkl mnop",
  resumeFileData: "JVBERi0xLjQ=", resumeText: "my resume", skills: "React",
});
check("the app password is never mirrored", "gmailAppPassword" in stripped, false);
check("the resume file is never mirrored", "resumeFileData" in stripped, false);
check("the resume text is mirrored", stripped.resumeText, "my resume");
check("the gmail address is mirrored", stripped.gmailUser, "me@gmail.com");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

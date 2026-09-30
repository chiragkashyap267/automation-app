// Follow-up eligibility, the nudge text, and the send loop's safety rails.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
// No Redis in tests: claims and counters degrade to "cannot claim".
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const M = await import("./.followups.bundle.mjs");
const {
  assessFollowUp,
  buildFollowUp,
  describeCandidates,
  isWorkday,
  replySubject,
  selectFollowUps,
  sendFollowUps,
  missingSendField,
  missingSendLabel,
  QUIET_DAYS,
  STALE_DAYS,
} = M;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n── ${n}`);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 9, 0, 0);
const daysAgo = (n) => NOW - n * DAY;

const entry = (over = {}) => ({
  id: "a1",
  messageId: "<abc@mail.gmail.com>",
  to: ["hr@kulsys.com"],
  company: "Kulsys",
  role: "QA Engineer",
  contactName: "Jnaincy Goel",
  subject: "Application for QA Engineer",
  sentAt: daysAgo(10),
  via: "web",
  chatId: null,
  ...over,
});

section("eligibility");
check("ten days of silence is ready", assessFollowUp(entry(), {}, NOW).reason, "ready");
check("three days is too soon", assessFollowUp(entry({ sentAt: daysAgo(3) }), {}, NOW).reason, "too-soon");
check(`${QUIET_DAYS} days exactly is ready`, assessFollowUp(entry({ sentAt: daysAgo(QUIET_DAYS) }), {}, NOW).reason, "ready");
check(`past ${STALE_DAYS} days it is left alone`, assessFollowUp(entry({ sentAt: daysAgo(40) }), {}, NOW).reason, "too-old");

// The three that must never be nudged.
check("someone who replied is never nudged", assessFollowUp(entry(), { a1: { repliedAt: daysAgo(2) } }, NOW).reason, "replied");
check("a bounced address is never nudged", assessFollowUp(entry(), { a1: { bounced: true } }, NOW).reason, "bounced");
check("nobody is nudged twice", assessFollowUp(entry(), { a1: { followedUpAt: daysAgo(1) } }, NOW).reason, "already-nudged");
check("an entry with no address is skipped", assessFollowUp(entry({ to: [] }), {}, NOW).reason, "no-recipient");

// A rejection is a reply, so the state carries repliedAt and it is excluded.
check(
  "a rejection still counts as answered",
  assessFollowUp(entry(), { a1: { repliedAt: daysAgo(2), kind: "rejection" } }, NOW).reason,
  "replied",
);

section("selection");
const many = [
  entry({ id: "old", sentAt: daysAgo(20), to: ["a@x.com"] }),
  entry({ id: "new", sentAt: daysAgo(8), to: ["b@x.com"] }),
  entry({ id: "recent", sentAt: daysAgo(2), to: ["c@x.com"] }),
];
check("only the quiet ones are picked", selectFollowUps(many, {}, NOW).map((c) => c.entry.id), ["old", "new"]);
check("oldest first — it is closest to expiring", selectFollowUps(many, {}, NOW)[0].entry.id, "old");
check("the age is reported", selectFollowUps(many, {}, NOW)[0].daysAgo, 20);

// Two applications to one inbox must not produce two emails to that inbox.
const sameAddress = [
  entry({ id: "p1", sentAt: daysAgo(12), to: ["careers@acme.com"] }),
  entry({ id: "p2", sentAt: daysAgo(9), to: ["careers@acme.com"] }),
];
check("one nudge per address", selectFollowUps(sameAddress, {}, NOW).map((c) => c.entry.id), ["p1"]);

check("the run is capped", selectFollowUps(
  Array.from({ length: 30 }, (_, i) => entry({ id: `x${i}`, sentAt: daysAgo(10), to: [`x${i}@a.com`] })),
  {}, NOW,
).length, M.MAX_PER_RUN);

section("the nudge itself");
const profile = {
  fullName: "Chirag Kashyap",
  email: "chirag@example.com",
  signOff: "Best regards",
  portfolio: "",
  linkedin: "",
  github: "",
  phone: "",
  headline: "",
};
const note = buildFollowUp(entry(), profile, 10);
check("it threads onto the original subject", note.subject, "Re: Application for QA Engineer");
check("no Re: Re:", replySubject("Re: Application for QA Engineer"), "Re: Application for QA Engineer");
check("it greets by first name only", note.body.startsWith("Hi Jnaincy,"), true);
check("no name means no fake familiarity", buildFollowUp(entry({ contactName: "" }), profile, 10).body.startsWith("Hello,"), true);
check("the role and company are named", note.body.includes("the QA Engineer role at Kulsys"), true);
check("it says how long it has been", note.body.includes("10 days ago"), true);
check("a fortnight is rounded, not counted", buildFollowUp(entry(), profile, 17).body.includes("a couple of weeks ago"), true);
check("it offers a way out", note.body.includes("If the position is filled"), true);
// It must never guilt-trip; that is what makes a follow-up a nuisance.
check("no apology, no reproach", /sorry|chase|still waiting|no response|ignored/i.test(note.body), false);
check("it is short", note.body.split(/\s+/).length < 110, true);

section("the offer message");
const described = describeCandidates(selectFollowUps(many, {}, NOW));
check("it counts them", described.includes("2 applications have gone quiet"), true);
check("it says nothing is sent yet", described.includes("Nothing goes out until you tap"), true);
check("one is singular", describeCandidates([{ entry: entry(), daysAgo: 9 }]).includes("1 application has gone quiet"), true);

section("weekday guard");
check("Saturday is skipped", isWorkday(new Date(Date.UTC(2026, 8, 26))), false);
check("Sunday is skipped", isWorkday(new Date(Date.UTC(2026, 8, 27))), false);
check("Monday runs", isWorkday(new Date(Date.UTC(2026, 8, 28))), true);

section("sending");
const creds = { ...profile, gmailUser: "me@gmail.com", gmailAppPassword: "abcdefghijklmnop", ccSelf: false };

// Without Redis there is no claim, so nothing may go out — losing a nudge is
// always better than sending a second copy of one.
{
  const calls = [];
  const out = await sendFollowUps([{ entry: entry(), daysAgo: 10 }], creds, {
    chatId: 1,
    send: async (req) => { calls.push(req); return "<id>"; },
  });
  check("no claim store means no send", calls.length, 0);
  check("and it says why", out.outcomes[0].detail, "already nudged");
}

{
  const out = await sendFollowUps([{ entry: entry(), daysAgo: 10 }], { ...creds, gmailAppPassword: "" }, {
    chatId: 1,
    send: async () => { throw new Error("SMTP must never be opened here"); },
  });
  check("missing credentials stop it before SMTP", out.sent, 0);
}

// With a store present the nudge actually goes out. A tiny in-memory Redis
// over the same REST shape lib/kv.ts speaks.
{
  const redis = new Map();
  globalThis.fetch = async (_url, init) => {
    const [cmd, key, ...rest] = JSON.parse(init.body);
    let result = null;
    if (cmd === "SET" && rest.includes("NX")) {
      result = redis.has(key) ? null : (redis.set(key, rest[0]), "OK");
    } else if (cmd === "SET") {
      result = (redis.set(key, rest[0]), "OK");
    } else if (cmd === "GET") {
      result = redis.has(key) ? redis.get(key) : null;
    } else if (cmd === "INCR") {
      result = (Number(redis.get(key) ?? 0) + 1);
      redis.set(key, String(result));
    } else if (cmd === "EXPIRE" || cmd === "LTRIM") {
      result = 1;
    }
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "t";

  const calls = [];
  const send = async (req) => { calls.push(req); return "<sent@mail>"; };
  const first = await sendFollowUps([{ entry: entry(), daysAgo: 10 }], creds, { chatId: 1, send });

  check("it sends once", first.sent, 1);
  // Without both headers the nudge arrives as an unrelated second email.
  check("In-Reply-To points at the original", calls[0].inReplyTo, "<abc@mail.gmail.com>");
  check("References points at the original", calls[0].references, "<abc@mail.gmail.com>");
  check("it goes to the original recipient", calls[0].to, ["hr@kulsys.com"]);
  check("the subject threads", calls[0].subject, "Re: Application for QA Engineer");

  // The claim is what stops a retried webhook sending a second copy.
  const second = await sendFollowUps([{ entry: entry(), daysAgo: 10 }], creds, { chatId: 1, send });
  check("a second run sends nothing", second.sent, 0);
  check("only ever one email", calls.length, 1);
  check("and it says so", second.outcomes[0].detail, "already nudged");

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

section("naming the missing credential");
check("neither", missingSendField({ gmailUser: "", gmailAppPassword: "" }), "both");
check("address only", missingSendField({ gmailUser: "me@gmail.com", gmailAppPassword: "" }), "password");
// The bug this fixes: the app said "add your App Password" when the address
// was the missing half, sending people to re-type the part that was right.
check("password only", missingSendField({ gmailUser: "", gmailAppPassword: "abcd" }), "address");
check("it says the password is already there", missingSendLabel({ gmailUser: "", gmailAppPassword: "abcd" }), "your Gmail address (the App Password is saved)");
check("complete", missingSendField({ gmailUser: "me@gmail.com", gmailAppPassword: "abcd" }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

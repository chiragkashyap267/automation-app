// Holding mail for a working-hours send, and the morning summary.
process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.local";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const store = new Map();
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("fake-redis")) throw new Error(`unexpected fetch to ${url}`);
  const [cmd, key, ...rest] = JSON.parse(init.body);
  const list = () => (Array.isArray(store.get(key)) ? store.get(key) : []);
  const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });

  switch (cmd) {
    case "GET": return reply(store.has(key) ? store.get(key) : null);
    case "SET": store.set(key, rest[0]); return reply("OK");
    case "DEL": store.delete(key); return reply(1);
    case "INCR": { const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); return reply(n); }
    case "RPUSH": { const n = [...list(), rest[0]]; store.set(key, n); return reply(n.length); }
    case "LPUSH": { const n = [rest[0], ...list()]; store.set(key, n); return reply(n.length); }
    case "LRANGE": return reply(list().slice(Number(rest[0]), Number(rest[1]) + 1));
    case "LTRIM": store.set(key, list().slice(Number(rest[0]), Number(rest[1]) + 1)); return reply("OK");
    default: return reply(1);
  }
};

const {
  clearQueue, describeWindow, loadQueue, nextWindow, queueDrafts, sendQueued, buildDigest,
  loadCooldowns, publishCooldown, forgetCooldownCache, createKeyPool,
} = await import("./.schedule.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

// Sept 2026: 28th is a Monday, so 30th is a Wednesday and Oct 2nd a Friday.
const at = (day, hour) => new Date(Date.UTC(2026, 8, day, hour, 0, 0));
const iso = (d) => d.toISOString().slice(0, 16);

section("when the window is");
check("before 04:00 it is today", iso(nextWindow(at(30, 2))), "2026-09-30T04:00");
check("after 04:00 it is tomorrow", iso(nextWindow(at(30, 10))), "2026-10-01T04:00");
// Friday evening's queue must not go out on a Saturday: nobody is reading,
// and a burst at the weekend is what looks least like a person.
check("Friday evening waits for Monday", iso(nextWindow(at(2 + 30, 10))), "2026-10-05T04:00");
check("Saturday waits for Monday", iso(nextWindow(new Date(Date.UTC(2026, 9, 3, 12)))), "2026-10-05T04:00");
check("Sunday waits for Monday", iso(nextWindow(new Date(Date.UTC(2026, 9, 4, 12)))), "2026-10-05T04:00");
check("exactly 04:00 rolls to the next day", iso(nextWindow(at(30, 4))), "2026-10-01T04:00");

section("how it is described");
check("in the morning, it is today", describeWindow(at(30, 2)), "today at about 9:30am");
check("in the afternoon, tomorrow", describeWindow(at(30, 10)), "tomorrow at about 9:30am");
check("on a Friday, named", describeWindow(new Date(Date.UTC(2026, 9, 2, 10))), "Monday at about 9:30am");

section("the queue");
const CHAT = 77;
const draft = (c, to) => ({ company: c, role: "Dev", to: [to], subject: `Re ${c}`, body: "hello" });
await queueDrafts(CHAT, [draft("Acme", "a@x.com"), draft("Globex", "b@x.com")]);
check("both are queued", (await loadQueue(CHAT)).length, 2);
check("in order", (await loadQueue(CHAT))[0].company, "Acme");

// The same posting queued twice goes out once.
await queueDrafts(CHAT, [draft("Acme", "a@x.com")]);
check("a repeat is not duplicated", (await loadQueue(CHAT)).length, 2);

section("sending the queue");
{
  const sent = [];
  const out = await sendQueued(CHAT, {
    gmailUser: "me@gmail.com", gmailAppPassword: "abcd1234abcd1234",
    fullName: "Chirag", email: "me@gmail.com", ccSelf: false,
  }, { send: async (r) => { sent.push(r); return "<id>"; }, gapMs: 0 });

  check("everything queued goes out", out.sent, 2);
  check("to the right people", sent.map((r) => r.to[0]), ["a@x.com", "b@x.com"]);
  // Silently retrying mail to a stranger every morning is the pattern to avoid.
  check("the queue is emptied", (await loadQueue(CHAT)).length, 0);
}

{
  const out = await sendQueued(CHAT, { gmailUser: "", gmailAppPassword: "" }, {
    send: async () => { throw new Error("SMTP must never be opened here"); },
  });
  check("an empty queue is a no-op", out.queued, 0);
}

// Credentials missing must not clear the queue — the mail is still wanted.
await clearQueue(CHAT);
await queueDrafts(CHAT, [draft("Initech", "c@x.com")]);
{
  const out = await sendQueued(CHAT, { gmailUser: "", gmailAppPassword: "" }, {
    send: async () => { throw new Error("SMTP must never be opened here"); },
  });
  check("no credentials is refused", Boolean(out.refused), true);
  check("and the queue survives", (await loadQueue(CHAT)).length, 1);
}
await clearQueue(CHAT);

section("the morning digest");
const outbox = [
  { id: "1", messageId: "<1>", to: ["a@x.com"], company: "Acme", role: "Backend Engineer", contactName: "", subject: "s", sentAt: Date.now() - 3 * 86400000, via: "web", chatId: null },
  { id: "2", messageId: "<2>", to: ["b@x.com"], company: "Globex", role: "QA", contactName: "", subject: "t", sentAt: Date.now() - 5 * 86400000, via: "bot", chatId: 1 },
];

check("a quiet night says nothing at all", buildDigest({ outbox, state: {}, fresh: [], justSent: 0, quiet: 0 }), null);

const withInterview = buildDigest({
  outbox, state: {}, justSent: 0, quiet: 2,
  fresh: [
    { id: "1", reply: "replied", at: Date.now(), from: "hr@acme.com", subject: "x", kind: "interview" },
    { id: "2", reply: "replied", at: Date.now(), from: "hr@globex.com", subject: "y", kind: "rejection" },
  ],
});
check("interviews lead", withInterview.indexOf("interview request") < withInterview.indexOf("other repl"), true);
check("the company is named", withInterview.includes("Acme"), true);
check("the role is named", withInterview.includes("Backend Engineer"), true);
check("a rejection is still reported", withInterview.includes("Globex"), true);
check("what is still open is noted", withInterview.includes("gone quiet"), true);

// An autoresponder is not news; reporting it trains you to ignore the digest.
check(
  "an acknowledgement is not news",
  buildDigest({ outbox, state: {}, justSent: 0, quiet: 0, fresh: [{ id: "1", reply: "auto", at: 1, from: "x", subject: "y", kind: "auto" }] }),
  null,
);

const bounced = buildDigest({
  outbox, state: {}, justSent: 0, quiet: 0,
  fresh: [{ id: "2", reply: "bounced", at: Date.now(), from: "mailer-daemon", subject: "failed", kind: "bounce" }],
});
check("a bounce is worth saying", bounced.includes("could not be delivered"), true);

const justSent = buildDigest({ outbox, state: {}, fresh: [], justSent: 3, quiet: 0 });
check("queued mail going out is reported", justSent.includes("3 queued email"), true);

section("spent keys are remembered between invocations");
{
  // Every serverless invocation starts with a fresh key pool, so a key that
  // hit its daily quota looked healthy again on the very next request. Ten
  // pasted job descriptions meant ten wasted round trips to the same dead
  // key, and the user was told it was that provider's fault every time.
  const hour = Date.now() + 3600_000;
  await publishCooldown("GROQ_API_KEY_1", hour);
  forgetCooldownCache();

  const seen = await loadCooldowns();
  check("the cooldown survives", seen.GROQ_API_KEY_1, hour);

  // A later invocation knowing less must not revive a dead key.
  await publishCooldown("GROQ_API_KEY_1", Date.now() + 1000);
  forgetCooldownCache();
  check("a shorter cooldown does not shorten it", (await loadCooldowns()).GROQ_API_KEY_1, hour);

  // An expired entry should not keep a working key out.
  await publishCooldown("GROQ_API_KEY_9", Date.now() - 5000);
  forgetCooldownCache();
  check("an expired cooldown is dropped", "GROQ_API_KEY_9" in (await loadCooldowns()), false);

  process.env.TESTPOOL_API_KEY_1 = "aaa";
  process.env.TESTPOOL_API_KEY_2 = "bbb";
  const pool = createKeyPool("TESTPOOL_API_KEY");
  check("both keys start usable", pool.available(), 2);

  pool.applyCooldowns({ TESTPOOL_API_KEY_1: Date.now() + 3600_000 });
  check("a shared cooldown takes one out", pool.available(), 1);
  check("the key itself is still there", pool.count(), 2);
  // Still last-resort material rather than discarded.
  check("and remains a last resort", pool.keysToTry().length, 2);
  check("the usable one goes first", pool.keysToTry()[0].label, "TESTPOOL_API_KEY_2");

  pool.applyCooldowns({ TESTPOOL_API_KEY_1: Date.now() - 1000 });
  check("a stale shared value cannot revive it", pool.available(), 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

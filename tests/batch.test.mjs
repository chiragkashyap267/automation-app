// Send-all drives real SMTP, so its behaviour is pinned down here against a
// fake Redis and a fake mail server.
process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.local";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const store = new Map();

// Stand in for Upstash's REST API.
function redisFetch(init) {
  const [cmd, key, ...rest] = JSON.parse(init.body);
  const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
  const list = () => (Array.isArray(store.get(key)) ? store.get(key) : []);

  switch (cmd) {
    case "GET":
      return reply(store.has(key) ? store.get(key) : null);
    case "SET":
      store.set(key, rest[0]);
      return reply("OK");
    case "DEL":
      store.delete(key);
      return reply(1);
    case "INCR": {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return reply(next);
    }
    // The batch drafts are a list, so that concurrent appends cannot
    // overwrite one another.
    case "RPUSH": {
      const next = [...list(), rest[0]];
      store.set(key, next);
      return reply(next.length);
    }
    case "LRANGE":
      return reply(list().slice(Number(rest[0]), Number(rest[1]) + 1));
    case "LTRIM":
      store.set(key, list().slice(Number(rest[0]), Number(rest[1]) + 1));
      return reply("OK");
    case "EXPIRE":
      return reply(1);
    default:
      return reply(null);
  }
}

let mailSent = [];
let failNext = new Set();

globalThis.fetch = async (url, init) => {
  if (String(url).includes("fake-redis")) return redisFetch(init);
  throw new Error(`unexpected fetch to ${url}`);
};

const { sendAllInBatch, addToBatch, loadBatch, sendsToday, isLastOfBurst, clearBatch } =
  await import("./.batch.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const CHAT = 111;
const PROFILE = {
  gmailUser: "me@gmail.com", gmailAppPassword: "abcd1234abcd1234",
  fullName: "Chirag", email: "me@gmail.com", ccSelf: false,
};

function draft(company, to) {
  return {
    company, role: "Dev", to: [to],
    subject: `${company} application`,
    body: "Dear Hiring Team,\n\nI would like to apply.\n\nBest regards,\nChirag",
  };
}

// The mailer is swapped out so nothing leaves the machine.
const deps = (edits) => ({
  profile: PROFILE,
  attachment: async () => undefined,
  edit: async (id, text) => edits.push(text),
  answer: async (text) => edits.push(`[toast] ${text}`),
  send,
});

// Injected rather than aliased, so no SMTP connection is ever possible here.
const send = async (req) => {
  if (failNext.has(req.to[0])) throw new Error("550 mailbox unavailable");
  mailSent.push(req.to[0]);
  return "<id@local>";
};

await addToBatch(CHAT, draft("Acme", "a@acme.com"));
await addToBatch(CHAT, draft("Globex", "b@globex.com"));
await addToBatch(CHAT, draft("Initech", "c@initech.com"));
check("three drafts accumulate across messages", (await loadBatch(CHAT)).drafts.length, 3);

await addToBatch(CHAT, draft("Acme", "a@acme.com"));
check("the same posting twice is not duplicated", (await loadBatch(CHAT)).drafts.length, 3);

let edits = [];
mailSent = [];
await sendAllInBatch(CHAT, 1, deps(edits));
check("all three are sent", mailSent.length, 3);
check("each went to its own recipient", mailSent.sort(), ["a@acme.com", "b@globex.com", "c@initech.com"]);
check("the summary reports success", /Sent 3 of 3/.test(edits.join(" ")), true);
check("the batch is emptied afterwards", await loadBatch(CHAT), null);
check("the daily counter advanced", await sendsToday(CHAT), 3);

// One bad address must not stop the others.
edits = [];
mailSent = [];
failNext = new Set(["b@globex.com"]);
await addToBatch(CHAT, draft("Acme", "a@acme.com"));
await addToBatch(CHAT, draft("Globex", "b@globex.com"));
await addToBatch(CHAT, draft("Initech", "c@initech.com"));
await sendAllInBatch(CHAT, 1, deps(edits));
check("a failure does not stop the batch", mailSent.length, 2);
check("the failure is reported", /Sent 2 of 3/.test(edits.join(" ")), true);
check("the failing one is named", /Globex/.test(edits.join(" ")), true);

// Nothing to send.
edits = [];
await sendAllInBatch(CHAT, 1, deps(edits));
check("an empty batch says so", /Nothing left/.test(edits.join(" ")), true);

// An album of ten screenshots reaches Vercel as ten concurrent functions.
// Read-modify-write on a single JSON value kept only the last of them, so
// ten postings became one draft. Latency is added here because without it
// the calls serialise and the bug hides.
{
  const direct = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    await new Promise((r) => setTimeout(r, 15));
    const res = await direct(url, init);
    await new Promise((r) => setTimeout(r, 15));
    return res;
  };

  const ALBUM = 222;
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => addToBatch(ALBUM, draft(`Co${i}`, `a${i}@x.com`))),
  );
  const batch = await loadBatch(ALBUM);
  check("ten at once keeps all ten", batch.drafts.length, 10);
  check("in the order they arrived", batch.drafts[0].company, "Co0");

  // And exactly one of them posts the summary, with the final count.
  const winners = (
    await Promise.all(Array.from({ length: 10 }, () => isLastOfBurst(ALBUM, 200)))
  ).filter(Boolean).length;
  check("one summary, not ten", winners, 1);

  globalThis.fetch = direct;
  await clearBatch(ALBUM);
}

// A resume belongs with a job application. Attaching it to a freelance
// pitch turns an offer of work into what looks like a job request.
{
  const PITCH = 333;
  const sent = [];
  const file = { filename: "cv.pdf", content: Buffer.from("%PDF-"), contentType: "application/pdf" };

  await addToBatch(PITCH, { ...draft("Freshbite", "hi@freshbite.in"), kind: "pitch" });
  await addToBatch(PITCH, draft("Acme", "jobs@acme.com"));

  await sendAllInBatch(PITCH, 1, {
    profile: PROFILE,
    attachment: async () => file,
    edit: async () => {},
    answer: async () => {},
    send: async (r) => { sent.push(r); return "<id>"; },
  });

  const pitchMail = sent.find((r) => r.to[0] === "hi@freshbite.in");
  const jobMail = sent.find((r) => r.to[0] === "jobs@acme.com");
  check("a pitch carries no resume", pitchMail.attachment, undefined);
  check("an application still does", jobMail.attachment.filename, "cv.pdf");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

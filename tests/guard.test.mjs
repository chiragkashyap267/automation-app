// Sending limits exist to protect the Gmail account, so they are tested.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const { checkSendGuard, recentBounceRate, DAILY_SOFT_LIMIT, DAILY_HARD_LIMIT } = await import(
  "./.guard.bundle.mjs"
);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const HOUR = 3600_000;
function seed(rows) {
  store.set("jdmailer.history.v1", JSON.stringify(rows));
}
function row(hoursAgo, reply = "awaiting") {
  return { id: Math.random().toString(36), sentAt: Date.now() - hoursAgo * HOUR, reply, to: [], messageId: "" };
}

seed([]);
check("an empty history blocks nothing", checkSendGuard(10).block, false);
check("and does not warn", checkSendGuard(10).warn, false);

seed(Array.from({ length: DAILY_SOFT_LIMIT }, () => row(1)));
check("at the soft limit, one more warns", checkSendGuard(1).warn, true);
check("but is not blocked", checkSendGuard(1).block, false);

seed(Array.from({ length: DAILY_HARD_LIMIT }, () => row(1)));
check("past the hard limit it blocks", checkSendGuard(1).block, true);
check("the message says why", /worth more than/.test(checkSendGuard(1).message), true);

// Yesterday's sends must not count against today.
seed(Array.from({ length: DAILY_HARD_LIMIT }, () => row(30)));
check("sends older than 24h roll off", checkSendGuard(5).block, false);
check("and today's count is zero", checkSendGuard(0).sentToday, 0);

seed([...Array.from({ length: 10 }, () => row(2)), ...Array.from({ length: 5 }, () => row(2, "bounced"))]);
check("a high bounce rate is detected", recentBounceRate().high, true);
seed(Array.from({ length: 20 }, () => row(2)));
check("no bounces reads as healthy", recentBounceRate().high, false);
seed([row(2, "bounced"), row(2)]);
check("too few sends to judge bounce rate", recentBounceRate().high, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

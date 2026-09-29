// Addresses read off screenshots carry icon artifacts. Sending to a mangled
// address fails silently, so this is tested hard.
const { cleanRecipients, cleanRecipient, isGenericMailbox } = await import("./.email.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

// The exact pair from a real posting.
const real = cleanRecipients(["Jnaincy.goel@kulsys.com", "甾career@kulsys.com"]);
check("a glued non-ASCII icon is stripped", real.addresses.includes("career@kulsys.com"), true);
check("both addresses survive", real.addresses.length, 2);
check("the capital-prefixed one is flagged", real.suspicious.includes("jnaincy.goel@kulsys.com"), true);
check("the clean one is not flagged", real.suspicious.includes("career@kulsys.com"), false);

check("addresses are lowercased", cleanRecipient("HR@Acme.IO").address, "hr@acme.io");
check("an ordinary address is not flagged", cleanRecipient("naincy.goel@kulsys.com").suspicious, false);
check("an all-caps address is not flagged as an icon", cleanRecipient("HR@ACME.COM").suspicious, false);
check("trailing punctuation is trimmed", cleanRecipient("hr@acme.com.").address, "hr@acme.com");
check("surrounding brackets are trimmed", cleanRecipient("<hr@acme.com>").address, "hr@acme.com");
check("garbage returns null", cleanRecipient("not an address"), null);
check("duplicates collapse", cleanRecipients(["hr@a.com", "HR@a.com"]).addresses, ["hr@a.com"]);

check("career is a generic mailbox", isGenericMailbox("career@kulsys.com"), true);
check("a person is not", isGenericMailbox("naincy.goel@kulsys.com"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

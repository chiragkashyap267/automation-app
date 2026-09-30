// Freelance pitches: reading a lead, and refusing to invent clients.
const { parseLead, servicesReady, EMPTY_SERVICES, companyFromEmail, inventedClientsIn, buildPitchText } =
  await import("./.pitch.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

section("reading a lead");
const simple = parseLead("/pitch hello@freshbite.in they need packaging for a new snack range");
check("the address is found", simple.email, "hello@freshbite.in");
check("the need is what is left", simple.need, "they need packaging for a new snack range");
check("the business comes from the domain", simple.company, "Freshbite");

// A lead usually arrives as a whole pasted enquiry, not a tidy command.
const pasted = parseLead(
  "/pitch Hi, we are launching a cold-pressed juice brand in Noida next month and need label\n" +
  "design plus a simple website. Budget is flexible. Write to kavya@juicery.co.in",
);
check("a pasted enquiry works too", pasted.email, "kavya@juicery.co.in");
check("the whole enquiry becomes the need", pasted.need.includes("cold-pressed juice"), true);
check("and the address is not left in it", pasted.need.includes("kavya@juicery.co.in"), false);

check("no address means no lead", parseLead("/pitch someone who needs a logo"), null);
check("an empty command is not a lead", parseLead("/pitch"), null);

// A personal address tells you nothing about the business.
check("a gmail lead has no company", parseLead("/pitch raj@gmail.com needs a logo").company, "");
check("nor does a role mailbox", companyFromEmail("info@gmail.com"), "");
check("a real domain does", companyFromEmail("hello@spicemill.co.in"), "Spicemill");

section("the profile has to be usable");
const services = {
  ...EMPTY_SERVICES,
  fullName: "Chirag Kashyap",
  services: "packaging design, websites, motion graphics",
  proof: "Designed the label and outer carton for Spicemill, a Noida spice brand.",
  portfolio: "chiragkashyapwebdev.vercel.app",
};
check("a filled profile is ready", servicesReady(services), true);
check("no services is not", servicesReady({ ...services, services: "" }), false);
// Without proof a pitch has nothing true to say.
check("no proof and no portfolio is not", servicesReady({ ...services, proof: "", portfolio: "" }), false);
check("proof alone is enough", servicesReady({ ...services, portfolio: "" }), true);

section("invented clients");
// The pitch equivalent of claiming experience you do not have.
check(
  "a client you never had is caught",
  inventedClientsIn("We have worked with Haldiram and Bikano on packaging.", services),
  ["Haldiram"],
);
check(
  "a client you do have is fine",
  inventedClientsIn("We designed for Spicemill last year.", services),
  [],
);
// A pitch legitimately names the business it is being sent to, so only a
// claiming context counts.
check(
  "naming the recipient is not a claim",
  inventedClientsIn("Hello Freshbite, I design packaging for new brands.", services),
  [],
);
check("generic words are not client names", inventedClientsIn("I have worked with brands like yours.", services), []);
check("nothing claimed, nothing flagged", inventedClientsIn("I design packaging and build websites.", services), []);

section("what the model is told");
const text = buildPitchText(services, {
  email: "hello@freshbite.in", company: "Freshbite", contactName: "", need: "packaging for a snack range", source: "OLX",
});
check("the proof is marked as the only claimable thing", text.includes("the only thing this email may claim"), true);
check("the need is passed through", text.includes("packaging for a snack range"), true);
check("the source is passed through", text.includes("OLX"), true);
check("a missing need is handled", buildPitchText(services, { email: "a@b.com", company: "", contactName: "", need: "", source: "" }).includes("not stated"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

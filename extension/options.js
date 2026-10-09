/** Stores the app address, the password, and the few answers it does not keep. */

const FIELDS = [
  "appUrl",
  "appPassword",
  "country",
  "gender",
  "nationality",
  "dob",
  "tenthMarks",
  "tenthYear",
  "tenthBoard",
  "twelfthMarks",
  "twelfthYear",
  "twelfthBoard",
  "degree",
  "branch",
  "college",
  "gradMarks",
  "gradYear",
  "currentCompany",
  "currentDesignation",
];

/**
 * Switches rather than text, so they are read and written separately.
 *
 * Both letter-writing and step-following default to on: they are what
 * makes this worth having, and someone who does not want them will find
 * them here. Filling without being asked defaults to off, because a page
 * that changes under you without a click is alarming the first time.
 */
const TOGGLES = { autoFill: false, writeCover: true, followSteps: true };

/** Sensible for the person this was built for; all of it is editable. */
const DEFAULTS = {
  appUrl: "https://jdmailer.vercel.app",
  country: "India",
  nationality: "Indian",
};

const el = (id) => document.getElementById(id);
const saved = el("saved");

chrome.storage.local.get([...FIELDS, ...Object.keys(TOGGLES)]).then((stored) => {
  for (const name of FIELDS) {
    el(name).value = stored[name] ?? DEFAULTS[name] ?? "";
  }
  for (const [name, fallback] of Object.entries(TOGGLES)) {
    el(name).checked = stored[name] ?? fallback;
  }
});

el("save").addEventListener("click", async () => {
  const values = {};
  for (const name of FIELDS) values[name] = el(name).value.trim();
  for (const name of Object.keys(TOGGLES)) values[name] = el(name).checked;

  await chrome.storage.local.set(values);
  saved.textContent = "Saved.";
  setTimeout(() => {
    saved.textContent = "";
  }, 2000);
});

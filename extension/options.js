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

/** Sensible for the person this was built for; all of it is editable. */
const DEFAULTS = {
  appUrl: "https://jdmailer.vercel.app",
  country: "India",
  nationality: "Indian",
};

const el = (id) => document.getElementById(id);
const saved = el("saved");

chrome.storage.local.get(FIELDS).then((stored) => {
  for (const name of FIELDS) {
    el(name).value = stored[name] ?? DEFAULTS[name] ?? "";
  }
});

el("save").addEventListener("click", async () => {
  const values = {};
  for (const name of FIELDS) values[name] = el(name).value.trim();

  await chrome.storage.local.set(values);
  saved.textContent = "Saved.";
  setTimeout(() => {
    saved.textContent = "";
  }, 2000);
});

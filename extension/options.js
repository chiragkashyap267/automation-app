/** Stores the app address and password in this browser only. */

const url = document.getElementById("appUrl");
const password = document.getElementById("appPassword");
const saved = document.getElementById("saved");

chrome.storage.local.get(["appUrl", "appPassword"]).then((s) => {
  url.value = s.appUrl || "https://jdmailer.vercel.app";
  password.value = s.appPassword || "";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    appUrl: url.value.trim(),
    appPassword: password.value.trim(),
  });
  saved.textContent = "Saved.";
  setTimeout(() => (saved.textContent = ""), 2000);
});

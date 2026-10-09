/** The two buttons: fill the form, or explain what it saw. */

const out = document.getElementById("out");
const show = (text) => {
  out.textContent = text;
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * The content script is declared for the known boards, but a company
 * often hosts its own form on its own domain. Injecting on demand means
 * the button still works there, without asking for every site up front.
 */
async function ask(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["fields.js", "content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

document.getElementById("fill").addEventListener("click", async () => {
  show("Reading your profile…");

  const loaded = await chrome.runtime.sendMessage({ type: "profile" });
  if (!loaded?.ok) return show(loaded?.error || "Could not reach the app.");

  const tab = await activeTab();
  show("Filling… (reading the form, and writing a letter if it asks for one)");

  const stored = await chrome.storage.local.get(["writeCover", "followSteps"]);
  const options = {
    writeCover: stored.writeCover !== false,
    followSteps: stored.followSteps !== false,
  };

  let report;
  try {
    report = await ask(tab.id, { type: "fill", data: loaded.data, options });
  } catch (err) {
    return show(`This page would not let the extension run.\n${err.message}`);
  }
  if (!report) return show("No answer from the page. Reload it and try again.");
  if (report.error) return show(report.error);

  const lines = [
    report.filled.length ? `Filled: ${report.filled.join(", ")}` : "Filled nothing.",
    `Resume: ${report.resume}`,
  ];
  if (report.cover) lines.push(`Cover letter: ${report.cover}`);
  if (report.note) lines.push(`Note: ${report.note}`);
  if (report.skipped.length) lines.push(`\nLeft alone:\n  ${report.skipped.join("\n  ")}`);
  if (report.unknown.length) {
    lines.push(
      `\nDid not recognise ${report.unknown.length} field${report.unknown.length === 1 ? "" : "s"}:`,
      `  ${report.unknown.slice(0, 8).join("\n  ")}`,
    );
  }
  if (report.unknown.length) {
    lines.push("\nThe panel on the page lets you name these once — it then remembers.");
  }
  lines.push("\nCheck everything, then submit it yourself.");
  show(lines.join("\n"));
});

document.getElementById("inspect").addEventListener("click", async () => {
  const tab = await activeTab();
  show("Looking…");

  let fields;
  try {
    fields = await ask(tab.id, { type: "inspect" });
  } catch (err) {
    return show(`Could not read this page.\n${err.message}`);
  }
  if (!fields?.length) return show("No form fields found on this page.");

  show(
    fields
      .map((f) => `${f.kind ? `[${f.kind}]` : "[ ? ]"} ${f.type || f.tag} — ${f.reads}`)
      .join("\n"),
  );
});

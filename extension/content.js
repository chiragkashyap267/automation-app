/**
 * Filling the form that is actually on screen.
 *
 * Three things make this harder than setting .value:
 *
 *   1. React ignores a value assigned directly, because it tracks the last
 *      value it wrote and sees no change. Going through the native setter
 *      and then dispatching input and change is what makes it notice.
 *   2. A file input cannot be given a path, but it can be given a File
 *      through a DataTransfer, which is how the resume gets attached.
 *   3. Nothing is ever submitted. Fields are filled and left for you to
 *      read, because a wrong answer sent in your name cannot be recalled.
 */
(function () {
  "use strict";

  const F = globalThis.JDFields;

  /** The words a human would read as the question for this field. */
  function labelFor(el) {
    const bits = [];

    if (el.id) {
      const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (tag) bits.push(tag.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) bits.push(wrapping.textContent);

    const describedBy = el.getAttribute("aria-labelledby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) bits.push(node.textContent);
      }
    }

    bits.push(
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      // Workday keeps a stable hook here when everything else is generated.
      el.getAttribute("data-automation-id"),
      el.getAttribute("name"),
      el.id,
    );

    return bits.filter(Boolean).join(" ");
  }

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return false;
    // Leave anything you have already answered exactly as you left it.
    return !String(el.value || "").trim();
  }

  /** Assigns a value in the way a framework will actually notice. */
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Picks the option whose text or value matches, if one does. */
  function selectOption(el, value) {
    const want = value.trim().toLowerCase();
    const option = [...el.options].find(
      (o) =>
        o.value.trim().toLowerCase() === want || o.textContent.trim().toLowerCase() === want,
    );
    if (!option) return false;
    setValue(el, option.value);
    return true;
  }

  /**
   * Puts a real file into a file input.
   *
   * A page cannot invent a file, but an extension can build one and hand
   * it over through a DataTransfer, which is indistinguishable from a
   * chosen file by the time the form reads input.files.
   */
  function attachFile(input, file) {
    const carrier = new DataTransfer();
    carrier.items.add(file);
    input.files = carrier.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function resumeFile(resume) {
    if (!resume?.url) return null;
    const res = await chrome.runtime.sendMessage({ type: "resume", url: resume.url });
    if (!res?.ok) return null;
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    return new File([bytes], resume.filename || "resume.pdf", {
      type: res.contentType || "application/pdf",
    });
  }

  /** Fills what it can and reports everything it saw. */
  async function fill({ profile, resume }) {
    const report = { filled: [], skipped: [], unknown: [], resume: "not attempted" };

    const inputs = [...document.querySelectorAll("input, select, textarea")];

    for (const el of inputs) {
      if (el.type === "file") continue; // handled separately
      // A tick box is a decision, not a detail. Never answer one for you.
      if (el.type === "checkbox" || el.type === "radio") continue;

      const label = labelFor(el);
      const kind = F.classify(label);

      if (!kind) {
        if (isFillable(el)) report.unknown.push(label.slice(0, 60));
        continue;
      }
      if (F.NEVER_FILL.has(kind)) {
        report.skipped.push(`${kind} (yours to answer)`);
        continue;
      }
      if (!isFillable(el)) {
        report.skipped.push(`${kind} (already filled)`);
        continue;
      }

      const value = F.valueFor(kind, profile);
      if (!value) {
        report.skipped.push(`${kind} (nothing in your profile)`);
        continue;
      }

      if (el instanceof HTMLSelectElement) {
        if (selectOption(el, value)) report.filled.push(kind);
        else report.skipped.push(`${kind} (no matching option)`);
        continue;
      }

      setValue(el, value);
      report.filled.push(kind);
    }

    const fileInput = [...document.querySelectorAll('input[type="file"]')].find(
      (el) => F.classify(labelFor(el)) === "resume",
    ) ?? document.querySelector('input[type="file"]');

    if (fileInput) {
      try {
        const file = await resumeFile(resume);
        if (file) {
          attachFile(fileInput, file);
          report.resume = `attached ${file.name}`;
        } else {
          report.resume = "no resume configured in the app";
        }
      } catch (err) {
        report.resume = `could not attach: ${err.message}`;
      }
    } else {
      report.resume = "no file input on this page";
    }

    return report;
  }

  /** Lists every field on the page, for working out what a miss was. */
  function inspect() {
    return [...document.querySelectorAll("input, select, textarea")]
      .filter((el) => el.type !== "hidden")
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        label: labelFor(el).slice(0, 80),
        reads: F.normalizeLabel(labelFor(el)).slice(0, 60),
        kind: F.classify(labelFor(el)),
      }));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "fill") {
      fill(msg.data).then(reply, (err) => reply({ error: err.message }));
      return true; // reply comes later
    }
    if (msg.type === "inspect") {
      reply(inspect());
      return false;
    }
    return false;
  });
})();

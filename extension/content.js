/**
 * Filling the form that is actually on screen.
 *
 * Four things make this harder than setting .value:
 *
 *   1. React ignores a value assigned directly, because it tracks the last
 *      value it wrote and sees no change. Going through the native setter
 *      and then dispatching input and change is what makes it notice.
 *   2. A file input cannot be given a path, but it can be given a File
 *      through a DataTransfer, which is how the resume gets attached.
 *   3. A form nobody has written rules for still has to work. Labels the
 *      pattern list cannot place are sent to the app, which asks a model
 *      what they are asking for — labels only, never the values.
 *   4. Nothing is ever submitted. Fields are filled and left for you to
 *      read, because a wrong answer sent in your name cannot be recalled.
 *
 * And it is meant to stop being wrong. Corrections are recorded against
 * the site and remembered, so the same field is not misread twice.
 */
(function () {
  "use strict";

  if (globalThis.__jdFillLoaded) return;
  globalThis.__jdFillLoaded = true;

  const F = globalThis.JDFields;
  const HOST = location.hostname;

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

  /**
   * Picks the option that means what we want.
   *
   * Exact first, then a prefix. "India" has to find itself in a list where
   * it is spelled "India (IN)", and "Male" in one offering "Male" beside
   * "Female" — but never by substring, or "Male" would match "Female".
   */
  function selectOption(el, value) {
    const want = value.trim().toLowerCase();
    const options = [...el.options];
    const text = (o) => o.textContent.trim().toLowerCase();

    const exact = options.find((o) => text(o) === want || o.value.trim().toLowerCase() === want);
    const prefix = options.find((o) => text(o).startsWith(want));

    const option = exact || prefix;
    if (!option) return false;
    setValue(el, option.value);
    return true;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * The dropdowns that are not dropdowns.
   *
   * Workday and most modern boards build their own from divs, so there is
   * no <select> and no options until the thing is opened. Opening it and
   * clicking the right row is the only way in.
   */
  async function pickFromListbox(el, value) {
    const want = value.trim().toLowerCase();

    el.focus();
    el.click();
    await wait(180);

    const rows = [
      ...document.querySelectorAll('[role="option"], [role="listbox"] li, [role="menuitem"]'),
    ].filter((r) => r.offsetParent !== null);

    const label = (r) => (r.textContent || "").trim().toLowerCase();
    const hit = rows.find((r) => label(r) === want) || rows.find((r) => label(r).startsWith(want));

    if (!hit) {
      el.blur();
      return false;
    }
    hit.click();
    await wait(60);
    return true;
  }

  function isCustomDropdown(el) {
    const role = el.getAttribute("role");
    return (
      role === "combobox" ||
      role === "listbox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.hasAttribute("aria-expanded")
    );
  }

  /**
   * The question a group of radio buttons is really asking.
   *
   * The label on each button is its answer ("Male"), not the question, so
   * the question has to come from the fieldset around them.
   */
  function groupLabelFor(radio) {
    const bits = [];
    const fieldset = radio.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) bits.push(legend.textContent);
    }
    const group = radio.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const by = group.getAttribute("aria-labelledby");
      if (by) {
        for (const id of by.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node) bits.push(node.textContent);
        }
      }
      bits.push(group.getAttribute("aria-label"));
    }
    bits.push(radio.name);
    return bits.filter(Boolean).join(" ");
  }

  /** The visible answer text beside one radio button. */
  function radioAnswer(radio) {
    if (radio.id) {
      const tag = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (tag) return tag.textContent.trim();
    }
    const wrapping = radio.closest("label");
    if (wrapping) return wrapping.textContent.trim();
    return (radio.getAttribute("aria-label") || radio.value || "").trim();
  }

  /**
   * Radio groups we will answer.
   *
   * Everything else a form asks with radio buttons is a decision —
   * sponsorship, eligibility, consent — and those stay yours. Gender is
   * here only because you set the answer yourself in the options.
   */
  const RADIO_OK = new Set(["gender"]);

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

  /** A dropdown's choices, which are often the strongest clue of all. */
  function optionsFor(el) {
    if (el instanceof HTMLSelectElement) {
      return [...el.options].map((o) => o.textContent.trim()).filter(Boolean).slice(0, 12);
    }
    return [];
  }

  /** Every field on the page, with what it reads as. */
  function collectFields(overrides) {
    const out = [];
    const seenRadioGroups = new Set();

    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden") continue;

      if (el.type === "radio") {
        const key = el.name || groupLabelFor(el);
        if (seenRadioGroups.has(key)) continue;
        seenRadioGroups.add(key);
        const label = groupLabelFor(el) || key;
        out.push({ el, label, type: "radiogroup", options: [], kind: F.classify(label, overrides) });
        continue;
      }

      const label = labelFor(el);
      const type = el.type || el.tagName.toLowerCase();
      out.push({ el, label, type, options: optionsFor(el), kind: F.classify(label, overrides) });
    }

    return out;
  }

  /**
   * Asks the app about the labels nothing here recognised.
   *
   * Never fatal. A model outage, a wrong password or being offline should
   * cost the unrecognised fields, not the whole fill.
   */
  async function resolveUnknown(fields) {
    const asking = fields
      .filter((f) => !f.kind && f.el.type !== "file" && isFillable(f.el) && f.label.trim())
      .map((f) => ({ label: f.label.slice(0, 120), type: f.type, options: f.options }));

    if (!asking.length) return { overrides: {}, note: "" };

    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "resolve", host: HOST, fields: asking });
    } catch (err) {
      return { overrides: {}, note: `could not reach the app (${err.message})` };
    }
    if (!reply?.ok) return { overrides: {}, note: reply?.error || "the app would not answer" };

    const overrides = { ...(reply.data.learned || {}) };
    for (const entry of reply.data.resolved || []) {
      if (entry.kind) overrides[F.normalizeLabel(entry.label)] = entry.kind;
    }
    return { overrides, note: reply.data.error || reply.data.note || "" };
  }

  /** What the page seems to be, for writing a letter about it. */
  function jobContext() {
    const meta = (name) =>
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || "";

    const heading = document.querySelector("h1")?.textContent?.trim() || "";
    const role = (heading || document.title || "").slice(0, 140).trim();
    const company =
      meta("og:site_name") ||
      HOST.replace(/^(www|careers|jobs|apply)\./, "").split(".")[0];

    // The visible text, which is the posting plus some furniture. The
    // model is told to use what bears on the role and ignore the rest.
    const body = (document.body?.innerText || "").replace(/\s+\n/g, "\n").trim();

    return { company, role, jd: body.slice(0, 12000) };
  }

  /**
   * Learning from what you type.
   *
   * The strong signal is an exact match: if a field nothing recognised is
   * filled by hand with precisely the phone number in the profile, then
   * that label means phone, on this site and probably on others. Only
   * exact matches count — a partial one would teach it something wrong,
   * and a wrong lesson is worse than none because it then outranks
   * everything else.
   */
  function valueIndex(profile) {
    const index = new Map();
    const KINDS_TO_WATCH = [
      "fullName", "email", "phone", "linkedin", "github", "portfolio",
      "location", "city", "country", "experience", "dob", "college",
      "degree", "branch", "currentCompany", "currentDesignation",
      "tenthMarks", "twelfthMarks", "gradMarks", "gradYear",
    ];
    for (const kind of KINDS_TO_WATCH) {
      const value = F.valueFor(kind, profile);
      if (value && value.length >= 3) index.set(value.trim().toLowerCase(), kind);
    }
    return index;
  }

  function watchForCorrections(unknownFields, profile) {
    const index = valueIndex(profile);
    if (!index.size) return;

    const learned = new Map();

    for (const field of unknownFields) {
      field.el.addEventListener(
        "change",
        () => {
          const typed = String(field.el.value || "").trim().toLowerCase();
          const kind = index.get(typed);
          if (!kind || learned.get(field.label) === kind) return;

          learned.set(field.label, kind);
          void chrome.runtime.sendMessage({
            type: "learn",
            host: HOST,
            corrections: [{ label: field.label, kind }],
          });
        },
        { passive: true },
      );
    }
  }

  // ---------------------------------------------------------------- panel

  /**
   * The report, in the page rather than in a popup you have to reopen.
   *
   * In a shadow root so the host page's stylesheet cannot reach it and it
   * cannot reach the host page's. Every unrecognised field gets a picker,
   * because this is where a correction is cheapest to make: the form is
   * in front of you and you can see what the box actually wanted.
   */
  function showPanel(report) {
    document.getElementById("jd-fill-panel")?.remove();

    const host = document.createElement("div");
    host.id = "jd-fill-panel";
    host.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;";
    const root = host.attachShadow({ mode: "open" });

    const kindOptions = F.KINDS.map(([kind]) => kind)
      .map((k) => `<option value="${k}">${k}</option>`)
      .join("");

    const row = (field) => `
      <div class="row">
        <span class="lbl" title="${field.label.replace(/"/g, "&quot;")}">${field.label.slice(0, 44) || "(no label)"}</span>
        <select data-label="${field.label.replace(/"/g, "&quot;")}">
          <option value="">— what is this? —</option>${kindOptions}
        </select>
      </div>`;

    root.innerHTML = `
      <style>
        .box{font:13px/1.45 system-ui,sans-serif;background:#fff;color:#111;border:1px solid #d4d4d8;
             border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);width:330px;max-height:70vh;
             overflow:auto;padding:12px 14px}
        h4{margin:0 0 6px;font-size:13px}
        p{margin:4px 0}
        .ok{color:#15803d}.no{color:#a16207}.err{color:#b91c1c}
        .row{display:flex;gap:6px;align-items:center;margin:5px 0}
        .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#444}
        select{font:12px system-ui;max-width:140px}
        button{font:12px system-ui;padding:4px 10px;border-radius:7px;border:1px solid #d4d4d8;
               background:#f4f4f5;cursor:pointer}
        button.primary{background:#111;color:#fff;border-color:#111}
        .foot{display:flex;gap:6px;margin-top:10px}
        hr{border:0;border-top:1px solid #eee;margin:9px 0}
      </style>
      <div class="box">
        <h4>Filled ${report.filled.length} field${report.filled.length === 1 ? "" : "s"}</h4>
        <p class="ok">${report.filled.join(", ") || "nothing"}</p>
        <p>Resume: ${report.resume}</p>
        ${report.cover ? `<p>Cover letter: ${report.cover}</p>` : ""}
        ${report.note ? `<p class="err">${report.note}</p>` : ""}
        ${report.skipped.length ? `<hr><p class="no">Left alone: ${report.skipped.join("; ")}</p>` : ""}
        ${
          report.unknownFields.length
            ? `<hr><p><b>Not recognised.</b> Tell it once and it will remember:</p>
               ${report.unknownFields.map(row).join("")}
               <div class="foot"><button class="primary" id="save">Remember these</button>
               <button id="close">Close</button></div>`
            : `<div class="foot"><button id="close">Close</button></div>`
        }
      </div>`;

    root.getElementById("close").onclick = () => host.remove();

    const save = root.getElementById("save");
    if (save) {
      save.onclick = async () => {
        const corrections = [...root.querySelectorAll("select")]
          .filter((s) => s.value)
          .map((s) => ({ label: s.dataset.label, kind: s.value }));

        if (!corrections.length) return host.remove();

        save.textContent = "Saving…";
        const reply = await chrome.runtime.sendMessage({ type: "learn", host: HOST, corrections });
        save.textContent = reply?.ok ? "Remembered — fill again" : `Failed: ${reply?.error ?? "?"}`;
        save.classList.remove("primary");
      };
    }

    document.body.appendChild(host);
  }

  // ----------------------------------------------------------------- fill

  /** Fills what it can and reports everything it saw. */
  async function fill(data, options) {
    const { profile, resume } = data;
    const settings = options || {};
    const report = {
      filled: [],
      skipped: [],
      unknown: [],
      unknownFields: [],
      resume: "not attempted",
      cover: "",
      note: "",
    };

    // Round one: what the pattern list alone can place.
    let fields = collectFields(null);

    // Round two: ask about the rest, then classify again with the answers.
    const { overrides, note } = await resolveUnknown(fields);
    if (note) report.note = note;
    if (Object.keys(overrides).length) fields = collectFields(overrides);

    // A cover letter is written only when the form actually asks for one,
    // and only for this posting. It costs a model call and some seconds,
    // so it is not done speculatively.
    const wantsCover = fields.some(
      (f) => f.kind === "coverLetter" && f.el.type !== "file" && isFillable(f.el),
    );
    if (wantsCover && settings.writeCover !== false) {
      try {
        const reply = await chrome.runtime.sendMessage({ type: "cover", context: jobContext() });
        if (reply?.ok && reply.data?.letter) {
          profile.coverLetter = reply.data.letter;
          report.cover = reply.data.problems?.length
            ? `written, but check it — ${reply.data.problems.join(" ")}`
            : "written";
        } else {
          report.cover = `not written: ${reply?.error || "no answer"}`;
        }
      } catch (err) {
        report.cover = `not written: ${err.message}`;
      }
    }

    for (const field of fields) {
      const { el, kind, label } = field;
      if (el.type === "file") continue; // handled separately

      if (el.type === "radio" || field.type === "radiogroup") continue; // handled below
      // A tick box is a decision, not a detail. Never answer one for you.
      if (el.type === "checkbox") continue;

      if (!kind) {
        if (isFillable(el)) {
          report.unknown.push(label.slice(0, 60));
          report.unknownFields.push({ el, label });
        }
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
        else report.skipped.push(`${kind} (no option matching "${value}")`);
        continue;
      }

      if (isCustomDropdown(el)) {
        if (await pickFromListbox(el, value)) report.filled.push(kind);
        else report.skipped.push(`${kind} (dropdown had no "${value}")`);
        continue;
      }

      setValue(el, value);
      report.filled.push(kind);
    }

    // Radio groups, once the text fields are done.
    const radioGroups = new Map();
    for (const el of document.querySelectorAll('input[type="radio"]')) {
      const key = el.name || groupLabelFor(el);
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      radioGroups.get(key).push(el);
    }

    for (const [key, radios] of radioGroups) {
      const kind = F.classify(groupLabelFor(radios[0]) || key, overrides);

      if (!kind || !RADIO_OK.has(kind)) {
        report.skipped.push(`${kind || "a choice"} (yours to answer)`);
        continue;
      }
      if (radios.some((r) => r.checked)) {
        report.skipped.push(`${kind} (already answered)`);
        continue;
      }

      const value = F.valueFor(kind, profile);
      if (!value) {
        report.skipped.push(`${kind} (not set in extension options)`);
        continue;
      }

      const want = value.trim().toLowerCase();
      const pick =
        radios.find((r) => radioAnswer(r).toLowerCase() === want) ||
        radios.find((r) => radioAnswer(r).toLowerCase().startsWith(want));

      if (!pick) {
        report.skipped.push(`${kind} (no choice matching "${value}")`);
        continue;
      }
      pick.click();
      report.filled.push(kind);
    }

    // The resume, and the cover letter if there is a second box for it.
    const fileInputs = [...document.querySelectorAll('input[type="file"]')];
    const resumeInput =
      fileInputs.find((el) => F.classify(labelFor(el), overrides) === "resume") ?? fileInputs[0];

    if (resumeInput) {
      try {
        const file = await resumeFile(resume);
        if (file) {
          attachFile(resumeInput, file);
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

    watchForCorrections(report.unknownFields, profile);
    if (settings.panel !== false) showPanel(report);

    // The elements cannot cross the message boundary.
    return {
      filled: report.filled,
      skipped: report.skipped,
      unknown: report.unknown,
      resume: report.resume,
      cover: report.cover,
      note: report.note,
    };
  }

  /**
   * Re-filling as a wizard moves on.
   *
   * Workday and the portals built like it keep you on one URL and swap the
   * fields out, so a fill that ran on step one has nothing to do with step
   * three. This watches for a crop of new empty fields appearing and fills
   * those, rather than making you press the button on every page.
   */
  function watchForNewSteps(data, options) {
    let timer = null;
    let busy = false;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (busy) return;
        const empty = collectFields(null).filter(
          (f) => f.el.type !== "file" && isFillable(f.el) && f.kind && !F.NEVER_FILL.has(f.kind),
        );
        // Three is the threshold for "a new step", not "the page moved".
        if (empty.length < 3) return;

        busy = true;
        try {
          await fill(data, { ...options, panel: false });
        } finally {
          busy = false;
        }
      }, 900);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  /** Lists every field on the page, for working out what a miss was. */
  function inspect() {
    return collectFields(null).map((f) => ({
      tag: f.el.tagName.toLowerCase(),
      type: f.type,
      label: f.label.slice(0, 80),
      reads: F.normalizeLabel(f.label).slice(0, 60),
      kind: f.kind,
    }));
  }

  let watcher = null;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "fill") {
      fill(msg.data, msg.options).then(
        (report) => {
          if (msg.options?.followSteps && !watcher) watcher = watchForNewSteps(msg.data, msg.options);
          reply(report);
        },
        (err) => reply({ error: err.message }),
      );
      return true; // reply comes later
    }
    if (msg.type === "inspect") {
      reply(inspect());
      return false;
    }
    return false;
  });

  /**
   * Filling without being asked.
   *
   * Only on the boards the manifest already loads this into, only when the
   * page really looks like an application form, and only when it has been
   * turned on. Still fills nothing it would not have filled on a click.
   */
  (async function maybeAutoFill() {
    let stored;
    try {
      stored = await chrome.storage.local.get(["autoFill", "writeCover", "followSteps"]);
    } catch {
      return;
    }
    if (!stored.autoFill) return;

    const candidates = collectFields(null).filter((f) => f.el.type !== "file" && isFillable(f.el));
    if (candidates.length < 4) return;

    const loaded = await chrome.runtime.sendMessage({ type: "profile" });
    if (!loaded?.ok) return;

    const options = {
      writeCover: stored.writeCover !== false,
      followSteps: stored.followSteps !== false,
    };
    await fill(loaded.data, options);
    if (options.followSteps && !watcher) watcher = watchForNewSteps(loaded.data, options);
  })();
})();

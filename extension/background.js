/**
 * Talks to the app, so the page never has to.
 *
 * The app password lives here and in extension storage only. A content
 * script runs inside whatever site you are applying to, and handing it a
 * credential would mean trusting every careers page on the internet with
 * it. Fetching from the service worker also sidesteps CORS, because the
 * extension's host permission covers the app's own domain.
 */

const DEFAULT_APP = "https://jdmailer.vercel.app";

async function settings() {
  const EXTRA_KEYS = [
    "country", "gender", "nationality", "dob",
    "tenthMarks", "tenthYear", "tenthBoard",
    "twelfthMarks", "twelfthYear", "twelfthBoard",
    "degree", "branch", "college", "gradMarks", "gradYear",
    "currentCompany", "currentDesignation",
  ];
  const stored = await chrome.storage.local.get(["appUrl", "appPassword", ...EXTRA_KEYS]);
  return {
    appUrl: (stored.appUrl || DEFAULT_APP).replace(/\/+$/, ""),
    appPassword: stored.appPassword || "",
    // Asked for on nearly every form, kept by nothing else.
    extras: Object.fromEntries(EXTRA_KEYS.map((k) => [k, stored[k] || ""])),
  };
}

/** The profile, as the app holds it. Cached briefly; it rarely changes. */
let cached = null;
const CACHE_MS = 5 * 60 * 1000;

async function loadProfile(force) {
  const { appUrl, appPassword, extras } = await settings();

  // The extras are local and free to read, so a cached profile still picks
  // up an answer you changed a moment ago.
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.data, profile: { ...cached.data.profile, ...extras } };
  }

  if (!appPassword) throw new Error("Set your app password in the extension options first.");

  const res = await fetch(`${appUrl}/api/profile`, {
    headers: { "x-app-password": appPassword },
  });

  if (res.status === 401) throw new Error("The app password is wrong.");
  if (!res.ok) throw new Error(`The app returned ${res.status}.`);

  const data = await res.json();
  if (!data?.profile?.fullName) {
    throw new Error("The app has no profile saved yet. Fill in Details and save.");
  }

  cached = { at: Date.now(), data };
  return { ...data, profile: { ...data.profile, ...extras } };
}

/** Base64 so the file can cross the message boundary intact. */
async function fetchResume(url) {
  const res = await fetch(url);
  if (!res.ok) return { ok: false };

  const buffer = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  // Chunked: spreading a large array into String.fromCharCode overflows.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return {
    ok: true,
    base64: btoa(binary),
    contentType: res.headers.get("content-type") || "application/pdf",
  };
}

/** One authenticated POST to the app, with the password kept out of the page. */
async function callApp(path, body, method = "POST") {
  const { appUrl, appPassword } = await settings();
  if (!appPassword) throw new Error("Set your app password in the extension options first.");

  const res = await fetch(`${appUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-app-password": appPassword },
    body: JSON.stringify(body),
  });

  if (res.status === 401) throw new Error("The app password is wrong.");
  if (!res.ok) {
    const said = await res.text();
    throw new Error(`The app returned ${res.status}. ${said.slice(0, 140)}`);
  }
  return res.json();
}

/**
 * Asks the app what a set of unrecognised labels are asking for.
 *
 * Labels only. The values about to be typed stay in the page, and the
 * profile never leaves the browser to answer this question.
 */
async function resolveFields(host, fields) {
  return callApp("/api/fill", { host, fields });
}

/** Records a correction so the same field is not got wrong twice. */
async function learn(host, corrections, forget) {
  return callApp("/api/fill", { host, corrections: corrections || [], forget: forget || [] }, "PUT");
}

/** A cover letter for this specific application, as text for a textarea. */
async function coverLetter(context) {
  return callApp("/api/cover", { ...context, pdf: false });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "resolve") {
    resolveFields(msg.host, msg.fields).then(
      (data) => reply({ ok: true, data }),
      (err) => reply({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.type === "learn") {
    learn(msg.host, msg.corrections, msg.forget).then(
      (data) => reply({ ok: true, data }),
      (err) => reply({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.type === "cover") {
    coverLetter(msg.context).then(
      (data) => reply({ ok: true, data }),
      (err) => reply({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.type === "profile") {
    loadProfile(msg.force).then(
      (data) => reply({ ok: true, data }),
      (err) => reply({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.type === "resume") {
    fetchResume(msg.url).then(reply, () => reply({ ok: false }));
    return true;
  }
  return false;
});

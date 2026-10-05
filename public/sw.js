/**
 * Minimal service worker.
 *
 * Its job is not offline support — it is installability. Android Chrome only
 * builds a real installed app (a WebAPK) for a site that has a service worker
 * with a fetch handler, and only a WebAPK is registered in the system share
 * sheet. Without this file, "Add to Home screen" makes a bookmark and the app
 * never appears when sharing from LinkedIn or WhatsApp.
 *
 * It deliberately caches almost nothing. Drafts, the profile and the Gmail
 * credentials live in localStorage, and API responses carry personal data, so
 * nothing under /api is ever stored.
 */

const CACHE = "jdmailer-shell-v1";
const SHELL = "/";

/**
 * Where a share is parked between the POST and the page that reads it.
 *
 * A share target has to be a POST to carry a screenshot, and a page has no
 * way to read a POST body it was navigated to. So the worker takes the body,
 * leaves it here, and redirects to an ordinary URL the app can load.
 */
const SHARE_CACHE = "jdmailer-share";
const SHARE_TEXT = "/__share__/text";
const SHARE_COUNT = "/__share__/count";
const shareFile = (i) => `/__share__/file/${i}`;

async function receiveShare(request) {
  try {
    const form = await request.formData();

    const text = ["share_title", "share_text", "share_url"]
      .map((key) => form.get(key))
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .trim();

    const files = form.getAll("media").filter((f) => f && typeof f === "object" && f.size > 0);

    const cache = await caches.open(SHARE_CACHE);
    await cache.put(SHARE_TEXT, new Response(text));
    await cache.put(SHARE_COUNT, new Response(String(files.length)));

    for (let i = 0; i < files.length; i += 1) {
      await cache.put(
        shareFile(i),
        new Response(files[i], {
          headers: {
            "content-type": files[i].type || "image/png",
            // Response headers are the only way a name survives the cache.
            "x-share-filename": encodeURIComponent(files[i].name || `shared-${i}.png`),
          },
        }),
      );
    }
  } catch {
    // A share that cannot be parsed still opens the app, just empty.
  }

  // 303 so the browser follows with a GET; the app reads the cache on load.
  return Response.redirect("/?shared=1", 303);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, "/icon-192.png", "/icon-512.png"]))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // The share cache is spared: a deploy landing between the share and
      // the page reading it would otherwise throw the screenshot away.
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const shareUrl = new URL(request.url);

  // The share sheet posting a job post, possibly with screenshots attached.
  if (request.method === "POST" && shareUrl.pathname === "/share") {
    event.respondWith(receiveShare(request));
    return;
  }

  // Only page loads are handled. Everything else — API calls, JS chunks,
  // the Tesseract download — goes straight to the network untouched.
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  // Network first, so a deploy is picked up immediately; the cached shell is
  // only a fallback for when the device is offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(SHELL, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(SHELL).then((hit) => hit ?? Response.error())),
  );
});

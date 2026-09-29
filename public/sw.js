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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

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

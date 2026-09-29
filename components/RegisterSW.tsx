"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes Android install the app as
 * a real WebAPK rather than a bookmark — and only a WebAPK appears in the
 * system share sheet.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Registration failing is not worth surfacing; the app works without it.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}

import type { MetadataRoute } from "next";

/**
 * Installing this to the home screen puts JD Mailer in Android's share sheet,
 * so a job post can be sent straight here from LinkedIn, WhatsApp or anywhere
 * else — no bot, no API, no account of yours involved.
 *
 * The share target is a POST, which is the only kind that can carry files.
 * That is what lets a screenshot go straight from the screenshot notification
 * into the app, instead of being saved, then found again in the picker. The
 * service worker catches the POST, keeps the payload, and sends the app to a
 * plain URL — a page cannot read a POST body any other way.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // An explicit id keeps Chrome from reusing whatever it cached for an
    // earlier bookmark-style install of the same start_url.
    id: "/?app=jdmailer",
    name: "JD Mailer",
    short_name: "JD Mailer",
    description: "Turn job descriptions into sent application emails.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0d0f13",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Not yet in Next's Manifest type, but a valid part of the web app manifest.
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "share_title",
        text: "share_text",
        url: "share_url",
        // Android hands over screenshots here. Several, if you picked several.
        files: [{ name: "media", accept: ["image/*"] }],
      },
    },
  } as MetadataRoute.Manifest;
}

import type { NextConfig } from "next";

/**
 * In development Next only accepts dev-asset requests from the hostname it was
 * started with, so opening the app from a phone on the LAN gets its JS chunks
 * and HMR blocked — pages that render their content on the client then sit on
 * "Loading…" forever.
 *
 * Private-network ranges are listed here so any device on the same Wi-Fi works,
 * and the IP can change with DHCP without breaking it. A `*` matches exactly one
 * dot-separated label and partial labels are not allowed, so 172.16-172.31 has
 * to be spelled out. Set DEV_ORIGIN to add one more (a tunnel host, say).
 * Development only; ignored in production.
 */
const privateRanges = [
  "192.168.*.*",
  "10.*.*.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    ...privateRanges,
    ...(process.env.DEV_ORIGIN ? [process.env.DEV_ORIGIN] : []),
  ],
  serverExternalPackages: ["nodemailer", "imapflow"],
};

export default nextConfig;

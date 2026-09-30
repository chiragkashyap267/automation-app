import { kvConfigured, kvGet, kvSet } from "./kv";
import { EMPTY_SERVICES, type ServicesProfile } from "./services";

/**
 * The services profile, mirrored where the bot can read it.
 *
 * Same arrangement as the job profile: the browser owns it, the server keeps
 * a copy so the bot writes from the same details. Nothing secret lives in
 * it — it is all things you would put on a business card.
 */

const KEY = "services:v1";
const TTL = 365 * 24 * 60 * 60;

export const sharedServicesAvailable = kvConfigured;

export async function saveSharedServices(profile: ServicesProfile): Promise<boolean> {
  if (!kvConfigured()) return false;
  return kvSet(KEY, profile, TTL);
}

export async function loadSharedServices(): Promise<ServicesProfile> {
  const stored = kvConfigured() ? await kvGet<ServicesProfile>(KEY) : null;
  return { ...EMPTY_SERVICES, ...(stored ?? {}) };
}

export async function sharedServicesExist(): Promise<boolean> {
  if (!kvConfigured()) return false;
  return (await kvGet<ServicesProfile>(KEY)) !== null;
}

import "server-only";

/*
 * Web push server configuration.
 *
 * The whole feature is DORMANT until both env vars exist, by design: the
 * routes return 503 and the profile UI hides itself (it checks the public
 * key's presence client-side). That is what makes this mergeable before the
 * secrets are provisioned, and what keeps a backend without them deployable.
 *
 * Provisioning (per environment, see docs/pwa.md for the full runbook):
 *   - NEXT_PUBLIC_VAPID_PUBLIC_KEY: the VAPID public key. Needs BUILD
 *     availability (it is inlined into the client bundle).
 *   - VAPID_PRIVATE_KEY: the private half. RUNTIME only, Secret Manager.
 * Local dev reads both from .env.local.
 *
 * The subject identifies the sender to push services; they use it to reach
 * an operator about misbehaving senders. Matches EMAIL_DEFAULT_REPLY_TO.
 */

export const VAPID_SUBJECT = "mailto:ai-safety@uonsu.com";

export function getVapidKeys(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

export function isPushConfigured(): boolean {
  return getVapidKeys() !== null;
}

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short HMAC tokens embedded in RSVP emails so attendees (including anonymous
 * email-only signups) can self-service cancel their spot or request a change
 * to their answers without needing a NAISI account.
 *
 * Stateless: the token is `base64url( hmac_sha256(secret, "<rsvpId>:<email>") )`
 * truncated to 32 chars. No token storage — validation is just re-signing.
 *
 * Rotating `EVENTS_TOKEN_SECRET` invalidates every outstanding link; that's
 * the right tradeoff (stateless + instant revocation).
 */

function secret(): string {
  const s = process.env.EVENTS_TOKEN_SECRET;
  if (!s) {
    throw new Error(
      "EVENTS_TOKEN_SECRET is not set. Add a random string (≥32 chars) to the environment.",
    );
  }
  return s;
}

export function signRsvpToken(rsvpId: string, email: string): string {
  return createHmac("sha256", secret())
    .update(`${rsvpId}:${email.toLowerCase().trim()}`)
    .digest("base64url")
    .slice(0, 32);
}

export function verifyRsvpToken(
  rsvpId: string,
  email: string,
  token: string,
): boolean {
  if (!token || typeof token !== "string") return false;
  const expected = signRsvpToken(rsvpId, email);
  if (expected.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

/** Absolute base URL for links in transactional emails. */
export function baseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://naisi.web.app";
  return raw.replace(/\/+$/, "");
}

/** Convenience: absolute cancel-link URL for an RSVP. */
export function cancelUrl(eventId: string, rsvpId: string, token: string): string {
  return `${baseUrl()}/events/${eventId}/rsvp/${rsvpId}/cancel?t=${encodeURIComponent(token)}`;
}

/** Convenience: absolute change-request URL for an RSVP. */
export function changeUrl(eventId: string, rsvpId: string, token: string): string {
  return `${baseUrl()}/events/${eventId}/rsvp/${rsvpId}/change?t=${encodeURIComponent(token)}`;
}

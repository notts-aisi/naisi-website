/**
 * Mints magic-link tokens byte-identically to `src/lib/signedTokens.ts`, so
 * the harness can exercise the link flows without an inbox.
 *
 * This reveals nothing: the algorithm is already readable in the public repo,
 * and the security boundary is `EVENTS_TOKEN_SECRET`, which lives only in
 * Secret Manager and the git-ignored .env.e2e.local. That is exactly why the
 * design brief rejected dev-only "preview the email" pages — a script holding
 * the dev secret needs no such page, and the page would have handed the same
 * capability to anyone who could load it.
 *
 * FOUR THINGS MUST MATCH THE SERVER EXACTLY or every token is rejected:
 *  1. Payload keys are single letters — `s` (scope) and `v` (doc id). Not
 *     `scope`/`docId`.
 *  2. The HMAC is computed over the base64url BODY STRING, not the raw JSON.
 *  3. JSON key order is load-bearing (it is hashed as text): caller keys in
 *     literal order, then `iat`, then `exp`.
 *  4. The HMAC key is the secret's raw utf8 bytes — not hex- or base64-decoded.
 */
import { createHmac } from "node:crypto";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param payload  e.g. `{ s: "verify-uni-email", v: tokenId }`
 * @param ttlSeconds  negative values mint an already-expired token on purpose
 * @param secret  the DEV project's EVENTS_TOKEN_SECRET
 */
export function signToken(payload, ttlSeconds, secret) {
  if (!secret || secret.length < 16) {
    throw new Error("EVENTS_TOKEN_SECRET missing or too short for the harness.");
  }
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSeconds };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = b64url(createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest());
  return `${body}.${sig}`;
}

/** A well-formed token whose signature does not match its body. */
export function tamperSignature(token) {
  const [body, sig] = token.split(".", 2);
  const flipped = sig
    .split("")
    .map((c, i) => (i === 0 ? (c === "A" ? "B" : "A") : c))
    .join("");
  return `${body}.${flipped}`;
}

/** A token whose body has been edited after signing (signature now stale). */
export function tamperBody(token, mutate) {
  const [body, sig] = token.split(".", 2);
  const decoded = JSON.parse(
    Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
  const mutated = mutate(decoded);
  const newBody = b64url(Buffer.from(JSON.stringify(mutated), "utf8"));
  return `${newBody}.${sig}`;
}

/** The shape of `randomOpaqueId()` in src/lib/signedTokens.ts. */
export function opaqueId() {
  return b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
}

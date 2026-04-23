import "server-only";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * HMAC-signed tokens, scoped so the same signing secret can safely issue
 * tokens for multiple unrelated flows without any being replayable across
 * scopes.
 *
 * A token is:  base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(JSON))
 *
 * `payload` always carries `{ s: scope, ... }` so signatures from one flow
 * (e.g. unsubscribe) can't be presented as tokens for another (e.g. verify
 * email) even if the secret is shared.
 *
 * `EVENTS_TOKEN_SECRET` is reused as the signing key — it's already set up on
 * both prod and dev backends (see apphosting.yaml). If you rotate it,
 * outstanding unsubscribe + verify links become invalid.
 */

export type TokenScope = "unsubscribe" | "verify-uni-email" | "public-confirm";

type PayloadBase = {
  s: TokenScope;
  /** ISO-ish epoch seconds the token was issued at. */
  iat: number;
  /** Epoch seconds after which the token MUST be rejected. */
  exp: number;
};

type UnsubscribePayload = PayloadBase & {
  s: "unsubscribe";
  /** Uid if this is for an authed user, else the public subscriber email. */
  uid?: string;
  email?: string;
  /** Which category the unsubscribe targets (omit to unsubscribe from all). */
  c?: "newsletter" | "events" | "all";
};

type VerifyPayload = PayloadBase & {
  s: "verify-uni-email";
  /** Firestore doc id in `emailVerifications`. */
  v: string;
};

type PublicConfirmPayload = PayloadBase & {
  s: "public-confirm";
  /** Firestore doc id in `publicSubscriberConfirmations`. */
  c: string;
};

export type TokenPayload =
  | UnsubscribePayload
  | VerifyPayload
  | PublicConfirmPayload;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function secret(): Buffer {
  const raw = process.env.EVENTS_TOKEN_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error(
      "EVENTS_TOKEN_SECRET is unset or too short. Set it on the App Hosting backend + .env.local.",
    );
  }
  return Buffer.from(raw, "utf8");
}

// Plain `Omit<TokenPayload, "iat" | "exp">` collapses the discriminated
// union's branch-specific fields (uid, email, v, c). A distributive omit
// preserves them, so `{ s: "unsubscribe", uid, c: "newsletter" }` still
// typechecks at the call site.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function signToken(
  payload: DistributiveOmit<TokenPayload, "iat" | "exp">,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSeconds } as TokenPayload;
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T extends TokenPayload>(
  token: string,
  expectedScope: T["s"],
): T | null {
  if (typeof token !== "string" || !token.includes(".")) {
    console.warn("[verifyToken] rejected: no separator", { scope: expectedScope, len: token?.length });
    return null;
  }
  const [body, sig] = token.split(".", 2);
  if (!body || !sig) {
    console.warn("[verifyToken] rejected: empty body or sig", { scope: expectedScope });
    return null;
  }

  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length) {
    console.warn("[verifyToken] rejected: sig length mismatch", {
      scope: expectedScope,
      given: given.length,
      expected: expected.length,
      sigPreview: sig.slice(0, 8),
    });
    return null;
  }
  if (!timingSafeEqual(given, expected)) {
    console.warn("[verifyToken] rejected: sig content mismatch", {
      scope: expectedScope,
      bodyPreview: body.slice(0, 16),
      sigPreview: sig.slice(0, 8),
    });
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8")) as TokenPayload;
  } catch (err) {
    console.warn("[verifyToken] rejected: JSON parse failed", { scope: expectedScope, err });
    return null;
  }
  if (payload.s !== expectedScope) {
    console.warn("[verifyToken] rejected: scope mismatch", {
      expected: expectedScope,
      got: payload.s,
    });
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    console.warn("[verifyToken] rejected: expired", {
      scope: expectedScope,
      now,
      exp: payload.exp,
      agedSeconds: now - payload.exp,
    });
    return null;
  }
  return payload as T;
}

/** Random 32-byte opaque id, base64url-encoded — used as Firestore doc ids
 * for verification / confirmation records. Not the same as a signed token. */
export function randomOpaqueId(): string {
  return b64url(randomBytes(32));
}

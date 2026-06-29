import "server-only";

/**
 * Best-effort, in-memory, fixed-window rate limiter for abuse control on the
 * public write routes (registration, resend, collaborator apply).
 *
 * Deliberately in-memory, NOT Firestore-backed: the whole point of throttling
 * these routes is to cap COST, so spending a Firestore read/write per request to
 * count requests would be self-defeating. reCAPTCHA on /api/register is the
 * primary bot gate; this is a cheap second line that adds zero datastore cost.
 *
 * Caveat: App Hosting (Cloud Run) can run more than one instance, and each holds
 * its own counters, so under heavy scale-out this is a soft limit rather than a
 * global guarantee. At NAISI's scale it's typically a single warm instance, so
 * in practice it behaves globally. Counters also reset on cold start (fail-open,
 * which is the safe direction for a backstop).
 *
 * Limits are kept GENEROUS on the per-IP axis on purpose: a university society's
 * members often share one campus NAT IP, so a tight per-IP cap would block legit
 * bulk sign-ups at a fair. The per-identity (email / uid) axis is tighter.
 */

type Bucket = { count: number; resetAt: number };

// Bound memory so a flood of distinct keys can't grow the map without limit.
const MAX_KEYS = 10_000;
const buckets = new Map<string, Bucket>();

function evictIfNeeded(now: number) {
  // Drop expired buckets first; Map preserves insertion order, so if we're still
  // over the cap, deleting from the front evicts the oldest entries.
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
  if (buckets.size <= MAX_KEYS) return;
  const over = buckets.size - MAX_KEYS;
  let i = 0;
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (++i >= over) break;
  }
}

export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

/**
 * Count one hit against `key`. Returns ok=false (with retryAfterSeconds) once
 * more than `limit` hits land inside the current `windowMs` window.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now >= existing.resetAt) {
    if (buckets.size >= MAX_KEYS) evictIfNeeded(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP from the proxy headers App Hosting / Cloud Run set.
 * Falls back to a constant so a missing header buckets everyone together rather
 * than disabling the limiter.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

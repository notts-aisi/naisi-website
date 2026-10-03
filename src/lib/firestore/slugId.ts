/**
 * Human-readable Firestore doc IDs: `{slug}__{8-char-base36}`.
 *
 * Goal: Firebase Console stays scannable as the corpus grows. Random auto-IDs
 * make it impossible to find a specific doc by eye; a slug prefix means the
 * title/kind/filename is visible at a glance and the suffix still guarantees
 * uniqueness.
 *
 * Invariants:
 *  - slug: lowercase `[a-z0-9-]`; max 40 chars; empty/unusable source → `"untitled"`
 *  - separator: `__` (double underscore) — makes `splitOnce` unambiguous
 *  - suffix: 8 base36 chars (~2.8 trillion combos) from the platform's
 *    cryptographic generator, so one id says nothing about the next
 *
 * Forward-only — existing random IDs keep their shape; we only apply this
 * convention at doc-creation time.
 *
 * NB: Firestore doc IDs can't start with `__`. A slug is always non-empty (we
 * fall back to `"untitled"`), so `${slug}__${suffix}` never starts with `__`.
 */

const MAX_SLUG_LEN = 40;

export function slugify(source: string, maxLen = MAX_SLUG_LEN): string {
  const cleaned = source
    .toLowerCase()
    // Decompose accented chars then drop combining marks so "café" → "cafe".
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return cleaned || "untitled";
}

const SUFFIX_LENGTH = 8;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
// The largest multiple of 36 that fits in a byte. A byte at or above it is
// thrown away rather than folded in, so every character is equally likely.
const UNBIASED_BELOW = 252;

/**
 * Eight base36 characters from `crypto.getRandomValues`, which exists in the
 * browser and on the server alike.
 *
 * This used `Math.random`, whose output can be predicted from a handful of
 * earlier values. Nothing here treats a document id as a secret (the rules
 * and the routes decide who may read a document, never knowledge of its
 * name), but ids are minted on the server and shown to clients, and "the next
 * id cannot be guessed" is a property worth having for the price of one call.
 */
function randomSuffix(): string {
  let out = "";
  const bytes = new Uint8Array(SUFFIX_LENGTH * 2);
  while (out.length < SUFFIX_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BELOW) continue;
      out += BASE36[byte % 36];
      if (out.length === SUFFIX_LENGTH) break;
    }
  }
  return out;
}

/**
 * Build a doc ID: `${slugify(source)}__${8-char-base36}`.
 *
 * Examples:
 *   slugId("Review the new design doc") → "review-the-new-design-doc__a7f3k2m1"
 *   slugId("subtask-approved")          → "subtask-approved__z91kx0jq"
 *   slugId("")                          → "untitled__cb4x2pzl"
 */
export function slugId(source: string): string {
  return `${slugify(source)}__${randomSuffix()}`;
}

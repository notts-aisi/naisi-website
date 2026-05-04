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
 *  - suffix: 8 base36 chars (~4B combos via `Math.random` — ample at our
 *    scale; a doc-ID suffix doesn't need cryptographic strength)
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padStart(8, "0");
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

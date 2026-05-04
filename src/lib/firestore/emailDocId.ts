import "server-only";

/**
 * Email-keyed Firestore doc ids. Two collections (`suppressedEmails`,
 * `subscriptions`) want to look up a doc by email without a query, so they
 * derive a deterministic doc id from the normalised address. The sanitiser
 * replaces characters Firestore rejects in doc ids with underscores; the
 * normaliser lower-cases and trims so the same address always maps to the
 * same id regardless of how it was typed.
 */

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Doc-id-safe sanitisation of an already-normalised email. Characters outside
 * Firestore's safe set are replaced with underscores. Idempotent:
 * `emailDocId(emailDocId(x)) === emailDocId(x)`.
 */
export function emailDocId(email: string): string {
  return normaliseEmail(email).replace(/[^a-z0-9@._+-]/g, "_");
}

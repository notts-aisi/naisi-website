import "server-only";
import type { Firestore } from "firebase-admin/firestore";

export type SuppressionReason = "bounce" | "complaint";

export type SuppressionEntry = {
  email: string;
  reason: SuppressionReason;
  subReason?: string;
  source: "ses-sns" | "resend-webhook" | "manual";
  addedAt: Date;
};

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Firestore doc id for a normalised email. The collection is keyed by a
 * sanitised form so we can fetch by doc id instead of querying. Characters
 * outside Firestore's safe set are replaced with underscores.
 */
function docId(email: string): string {
  return normalize(email).replace(/[^a-z0-9@._+-]/g, "_");
}

export async function addSuppression(
  db: Firestore,
  entry: Omit<SuppressionEntry, "addedAt"> & { addedAt?: Date },
): Promise<void> {
  const email = normalize(entry.email);
  if (!email) return;
  const doc: Record<string, unknown> = {
    email,
    reason: entry.reason,
    source: entry.source,
    addedAt: entry.addedAt ?? new Date(),
  };
  if (entry.subReason) doc.subReason = entry.subReason;
  await db.collection("suppressedEmails").doc(docId(email)).set(doc, { merge: true });
}

/**
 * Given a list of addresses, return which are clear to send to vs suppressed.
 * Doc-id lookup avoids Firestore's 30-item `in` cap and per-query round trips
 * are batched with Promise.all.
 */
export async function filterSuppressed(
  db: Firestore,
  emails: string[],
): Promise<{ allowed: string[]; suppressed: string[] }> {
  const unique = Array.from(new Set(emails.map(normalize).filter(Boolean)));
  if (unique.length === 0) return { allowed: [], suppressed: [] };

  const refs = unique.map((e) => db.collection("suppressedEmails").doc(docId(e)));
  const snaps = await db.getAll(...refs);
  const suppressedSet = new Set<string>();
  snaps.forEach((s, i) => {
    if (s.exists) suppressedSet.add(unique[i]);
  });

  const allowed: string[] = [];
  const suppressed: string[] = [];
  for (const raw of emails) {
    (suppressedSet.has(normalize(raw)) ? suppressed : allowed).push(raw);
  }
  return { allowed, suppressed };
}

export async function isSuppressed(db: Firestore, email: string): Promise<boolean> {
  const e = normalize(email);
  if (!e) return false;
  const snap = await db.collection("suppressedEmails").doc(docId(e)).get();
  return snap.exists;
}

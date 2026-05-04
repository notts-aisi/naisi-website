import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ALL_CATEGORIES,
  normaliseNotifications,
} from "@/lib/firestore/notifications";
import { normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  subscriptionDocId,
  type SubscriptionDoc,
} from "@/lib/firestore/subscriptions";

/**
 * One-shot backfill: walk every `users` doc, read its notification prefs
 * (tolerating both the modern `profile.notifications` shape and the legacy
 * `profile.newsletter` shape via `normaliseNotifications`), and write a
 * matching `subscriptions/{id}` row for each active category.
 *
 * Idempotent: doc id is `sub_<sanitisedEmail>__<channel>`, so re-running
 * just touches the same rows. Writes use `set({ merge: true })` to keep
 * any existing fields (like `lastSentAt` from a sender run) intact.
 *
 * Admin-only. POST with no body — returns counts for the operator.
 */

export async function POST() {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const maybeDb = getAdminDb();
  if (!maybeDb) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  // Capture as const with narrowed type so the inner loop's closure-free
  // batch reassign keeps the non-undefined type.
  const db = maybeDb;

  const allUsers = await db.collection("users").get();

  let usersScanned = 0;
  let rowsWritten = 0;
  let usersWithNoEmail = 0;

  // Use a single batch per ~400 writes (Firestore caps at 500). For NAISI's
  // size (~hundreds of members) one or two batches will cover everything.
  const BATCH_LIMIT = 400;
  let batch = db.batch();
  let batchOps = 0;

  for (const doc of allUsers.docs) {
    usersScanned += 1;
    const data = doc.data();
    const email = typeof data.email === "string" ? data.email : "";
    const normalised = normaliseEmail(email);
    if (!normalised) {
      usersWithNoEmail += 1;
      continue;
    }
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    const prefs = normaliseNotifications(profile);
    const now = Timestamp.now();

    for (const cat of ALL_CATEGORIES) {
      if (!prefs.categories[cat]) continue;
      const ref = db
        .collection("subscriptions")
        .doc(subscriptionDocId({ email: normalised, channel: cat }));
      const row: Partial<SubscriptionDoc> & {
        // Allow extra fields for `set({ merge: true })`.
        [key: string]: unknown;
      } = {
        email: normalised,
        channel: cat,
        audience: "user",
        audienceId: doc.id,
        status: "confirmed",
        source: "backfill",
        createdAt: now,
        confirmedAt: now,
      };
      batch.set(ref, row, { merge: true });
      batchOps += 1;
      rowsWritten += 1;
      if (batchOps >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  return NextResponse.json({
    ok: true,
    usersScanned,
    rowsWritten,
    usersWithNoEmail,
  });
}

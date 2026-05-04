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
  migrationPatchFromLegacyStatus,
  subscriptionDocId,
} from "@/lib/firestore/subscriptions";

/**
 * Two-pass admin backfill / migration. Idempotent.
 *
 * Pass A — write a row per (member, channel) for EVERY user, regardless of
 * their current notification preference. Members get one row per known
 * channel (newsletter, events) with:
 *  - confirmed: true (members are inherently confirmed by their session)
 *  - confirmedAt: now (or preserved if a row already exists)
 *  - subscribed: legacy_value (true iff their user-doc has the category on)
 *  - subscribedAt: now if subscribed, omitted otherwise
 *  - unsubscribedAt: now if unsubscribed, omitted otherwise
 *  - audience: "user", audienceId: uid
 *  - source: "backfill" (or kept on existing rows)
 *
 * That answers the user's "backfill doesn't catch people" gap. Currently-
 * unsubscribed members appear in the Subscriptions admin tab as
 * subscribed=false rather than being absent.
 *
 * Pass B — migrate any pre-existing rows that still use the legacy `status`
 * enum (pending / confirmed / unsubscribed) into the new (confirmed,
 * subscribed) shape. Translation:
 *   pending      → confirmed=false, subscribed=true
 *   confirmed    → confirmed=true,  subscribed=true,  confirmedAt preserved
 *   unsubscribed → confirmed=(was confirmedAt set?), subscribed=false,
 *                  unsubscribedAt preserved
 * The legacy `status` field is left in place; a follow-up cleanup PR drops
 * it after both prod and dev have been migrated and the new code paths
 * have been observed for a few days.
 *
 * Admin-only. POST with no body. Returns counts for the operator.
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
  const db = maybeDb;

  let usersScanned = 0;
  let usersWithNoEmail = 0;
  let memberRowsWritten = 0;
  let legacyRowsMigrated = 0;

  // Use a single batch per ~400 writes (Firestore caps at 500).
  const BATCH_LIMIT = 400;
  let batch = db.batch();
  let batchOps = 0;

  // === Pass A: write a row per (member, channel) for every user ===

  const allUsers = await db.collection("users").get();

  for (const userDoc of allUsers.docs) {
    usersScanned += 1;
    const data = userDoc.data();
    const email = typeof data.email === "string" ? data.email : "";
    const normalised = normaliseEmail(email);
    if (!normalised) {
      usersWithNoEmail += 1;
      continue;
    }
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    const prefs = normaliseNotifications(profile);
    const now = Timestamp.now();

    // Pull a name (preferredName, then displayName).
    const preferred = profile.preferredName;
    const display = data.displayName;
    const memberName: string | undefined =
      (typeof preferred === "string" && preferred.trim()) ||
      (typeof display === "string" && display.trim()) ||
      undefined;

    for (const cat of ALL_CATEGORIES) {
      const wantsThis = Boolean(prefs.categories[cat]);
      const ref = db
        .collection("subscriptions")
        .doc(subscriptionDocId({ email: normalised, channel: cat }));

      // Use set({ merge: true }) so existing rows keep their current
      // confirmedAt / subscribedAt timestamps and we just upsert the
      // current intent. New rows pick up everything below.
      const row: Record<string, unknown> = {
        email: normalised,
        channel: cat,
        audience: "user",
        audienceId: userDoc.id,
        confirmed: true,
        confirmedAt: now,
        subscribed: wantsThis,
        source: "backfill",
        createdAt: now,
      };
      if (wantsThis) {
        row.subscribedAt = now;
      } else {
        row.unsubscribedAt = now;
      }
      if (memberName) row.name = memberName;

      batch.set(ref, row, { merge: true });
      batchOps += 1;
      memberRowsWritten += 1;
      if (batchOps >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  }

  // === Pass B: migrate legacy `status`-only rows ===

  const allSubs = await db.collection("subscriptions").get();
  for (const subDoc of allSubs.docs) {
    const patch = migrationPatchFromLegacyStatus(
      subDoc.data() as Record<string, unknown>,
    );
    if (!patch) continue;
    batch.update(subDoc.ref, patch);
    batchOps += 1;
    legacyRowsMigrated += 1;
    if (batchOps >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  return NextResponse.json({
    ok: true,
    usersScanned,
    usersWithNoEmail,
    memberRowsWritten,
    legacyRowsMigrated,
  });
}

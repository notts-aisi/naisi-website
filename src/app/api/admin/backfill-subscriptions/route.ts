import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ALL_CATEGORIES,
  getVerifiedEmails,
  normaliseNotifications,
  type NotificationCategory,
  type VerifiedEmail,
} from "@/lib/firestore/notifications";
import {
  addSubscriptionEventToBatch,
  migrationPatchFromLegacyStatus,
  subscriptionDocId,
} from "@/lib/firestore/subscriptions";

/**
 * Two-pass admin backfill / migration. Idempotent.
 *
 * Pass A: write a row per (verified email, channel) for EVERY user. The
 * verified-email set comes from `getVerifiedEmails(userDoc)`: the Google
 * account email is always counted; the university email is only counted
 * when `profile.uniEmailVerifiedAt` is set. Members get one row per
 * (email × channel) pair with:
 *  - confirmed: true (members are inherently confirmed by their session)
 *  - subscribed: legacy_value (true iff the user-doc has the category on
 *    AND the channel-routing flag for that specific email is on)
 *  - audience: "user", audienceId: uid
 *  - source: "backfill" (or kept on existing rows)
 *
 * Audit timestamps (createdAt, confirmedAt, subscribedAt,
 * unsubscribedAt) are write-once: an existing row keeps whatever it
 * already has, and a field is only stamped the first time it applies.
 * subscribedAt and unsubscribedAt both persist once set, so a row keeps
 * its full history rather than losing the opposite timestamp on a flip.
 * This is what makes a re-run genuinely free: nothing drifts.
 *
 * Channel-routing: the legacy `notifications.channels.{gmail, uniEmail}`
 * flags decide which addresses got which categories pre-migration. The
 * backfill carries that intent forward into per-(email, channel) rows so
 * existing users don't see their settings flipped on first run. The flags
 * themselves stay on the user doc as legacy fields for now; a follow-up
 * cleanup PR drops them once the new code paths have settled.
 *
 * Currently-unsubscribed members appear in the Subscriptions admin tab
 * as subscribed=false rather than being absent.
 *
 * Pass B: migrate any pre-existing rows that still use the legacy
 * `status` enum into the new (confirmed, subscribed) shape, and nuke
 * stale `status` fields on already-migrated rows in the same pass.
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

  const BATCH_LIMIT = 400;
  let batch = db.batch();
  let batchOps = 0;

  // === Pass A: write a row per (verified email, channel) for every user ===

  // Preload existing subscription docs so Pass A can preserve write-once
  // audit timestamps instead of restamping them on every run. Without
  // this the backfill is not truly idempotent: createdAt / confirmedAt
  // drift forward each time it runs.
  const existingSubsSnap = await db.collection("subscriptions").get();
  const existingSubById = new Map<string, Record<string, unknown>>();
  for (const d of existingSubsSnap.docs) {
    existingSubById.set(d.id, d.data() as Record<string, unknown>);
  }

  const allUsers = await db.collection("users").get();

  for (const userDoc of allUsers.docs) {
    usersScanned += 1;
    const data = userDoc.data();
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    const verifiedEmails = getVerifiedEmails({
      email: typeof data.email === "string" ? data.email : null,
      profile: profile as { universityEmail?: unknown; uniEmailVerifiedAt?: unknown },
    });
    if (verifiedEmails.length === 0) {
      usersWithNoEmail += 1;
      continue;
    }
    const prefs = normaliseNotifications(profile);
    const now = Timestamp.now();

    const preferred = profile.preferredName;
    const display = data.displayName;
    const memberName: string | undefined =
      (typeof preferred === "string" && preferred.trim()) ||
      (typeof display === "string" && display.trim()) ||
      undefined;

    for (const ve of verifiedEmails) {
      for (const cat of ALL_CATEGORIES) {
        const wantsThis = wantsChannelForEmail(prefs, ve, cat);
        const docId = subscriptionDocId({ email: ve.email, channel: cat });
        const ref = db.collection("subscriptions").doc(docId);
        const existing = existingSubById.get(docId);

        // Audit timestamps are write-once: keep whatever the row already
        // has, stamp a field only the first time it applies. subscribedAt
        // and unsubscribedAt both persist once set, so a row that has
        // flipped state keeps its full history.
        const row: Record<string, unknown> = {
          email: ve.email,
          channel: cat,
          audience: "user",
          audienceId: userDoc.id,
          confirmed: true,
          confirmedAt: existing?.confirmedAt ?? now,
          subscribed: wantsThis,
          source: existing?.source ?? "backfill",
          createdAt: existing?.createdAt ?? now,
          status: FieldValue.delete(),
        };
        if (wantsThis && !existing?.subscribedAt) {
          row.subscribedAt = now;
        }
        if (!wantsThis && !existing?.unsubscribedAt) {
          row.unsubscribedAt = now;
        }
        if (memberName) row.name = memberName;

        batch.set(ref, row, { merge: true });
        batchOps += 1;
        memberRowsWritten += 1;
        // Log a `created` event for genuinely new rows only, so re-runs
        // of the backfill don't append duplicate history.
        if (!existing) {
          addSubscriptionEventToBatch(db, batch, {
            subscriptionId: docId,
            email: ve.email,
            channel: cat,
            type: "created",
            actor: { kind: "system", label: "backfill migration" },
          });
          batchOps += 1;
        }
        if (batchOps >= BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          batchOps = 0;
        }
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  }

  // === Pass B: migrate legacy `status`-only rows + nuke dead status fields ===

  const allSubs = await db.collection("subscriptions").get();
  for (const subDoc of allSubs.docs) {
    const patch = migrationPatchFromLegacyStatus(
      subDoc.data() as Record<string, unknown>,
      FieldValue.delete(),
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

/**
 * Should a row exist subscribed=true for this (email, channel) given the
 * user's legacy notification prefs? Combines the category flag (do they
 * want this channel at all) with the per-email channel-routing flag
 * (does this specific address get the category).
 *
 * The Google email defaults to receiving categories when the channels
 * map is missing, it's the auth identity, and pre-existing prefs that
 * predate the channels concept should keep delivering there.
 */
function wantsChannelForEmail(
  prefs: ReturnType<typeof normaliseNotifications>,
  verified: VerifiedEmail,
  cat: NotificationCategory,
): boolean {
  if (!prefs.categories[cat]) return false;
  if (verified.kind === "google") return prefs.channels.gmail !== false;
  return Boolean(prefs.channels.uniEmail);
}

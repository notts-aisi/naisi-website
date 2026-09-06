import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normaliseNotifications } from "@/lib/firestore/notifications";

/**
 * One-shot admin-triggered backfill: rewrites every user doc still on the
 * legacy `profile.newsletter` shape into the new `profile.notifications`
 * shape. Idempotent — users already on the new shape are skipped.
 *
 * Not automatic because:
 *   - it touches every user doc at once, and
 *   - the normaliser already hides the split at read time,
 * so there's no urgency. Admin clicks once after the PR deploys.
 */
export async function POST() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const snap = await db.collection("users").get();
  let migrated = 0;
  let alreadyNew = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    if (profile.notifications && typeof profile.notifications === "object") {
      alreadyNew += 1;
      continue;
    }
    if (!profile.newsletter) {
      skipped += 1;
      continue;
    }
    const prefs = normaliseNotifications(profile);
    // WRITE ONLY WHAT THE LEGACY SHAPE CAN ACTUALLY SAY, as dotted field paths.
    //
    // `serialiseNotifications(prefs)` would write the whole map, and the map
    // includes `categories.courses`. The legacy `profile.newsletter` shape
    // predates that category entirely, so a `false` there is the normaliser's
    // absent-collapses-to-false, NOT an answer — and the run email route reads a
    // stored `false` under the modern shape as an explicit refusal by someone
    // who saw the toggle (see its module comment and DEFAULT_NOTIFICATION_PREFS
    // in notifications.ts). Backfilling one would opt every legacy user out of
    // cohort announcements they have never been asked about. Absent stays
    // absent; `courses` is answered by the profile form or not at all.
    //
    // `newsletter` and `events` are migrated exactly as before — both are
    // expressible in the legacy shape, and neither distinguishes absent from
    // false anywhere that reads them.
    await doc.ref.update({
      "profile.notifications.channels": prefs.channels,
      "profile.notifications.categories.newsletter": prefs.categories.newsletter,
      "profile.notifications.categories.events": prefs.categories.events,
    });
    migrated += 1;
  }

  return NextResponse.json({ ok: true, migrated, alreadyNew, skipped });
}

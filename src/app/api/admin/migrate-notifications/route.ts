import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  normaliseNotifications,
  serialiseNotifications,
} from "@/lib/firestore/notifications";

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
    await doc.ref.update({
      "profile.notifications": serialiseNotifications(prefs),
    });
    migrated += 1;
  }

  return NextResponse.json({ ok: true, migrated, alreadyNew, skipped });
}

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  MEMBERSHIP_CONFIG_PATH,
  MEMBERSHIP_PERIODS_COLLECTION,
} from "@/lib/firestore/memberships";

/**
 * Move the CURRENT membership period pointer.
 *
 * ## Why the pointer is a document rather than a flag
 *
 * `config/membership.currentPeriodId` names exactly one period. The obvious
 * alternative, a `current: true` flag on the period itself, can be true on two
 * documents at once, and the first time that happens every badge on the site
 * disagrees with every other depending on which document a query returned
 * first. One pointer, one answer.
 *
 * ## Why full admins only, when `manageMembership` may do everything else
 *
 * Creating a period, granting a tier and revoking one are all decisions about
 * ONE person or ONE year. Moving this pointer re-badges the whole site at
 * once: every profile badge, every members-row chip and every reviewer-facing
 * membership fact starts answering about a different year the moment it is
 * written. That is an admin decision, and the console renders the button only
 * for admins while this route refuses everyone else regardless.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function POST(req: Request) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Only an admin can change which membership period is current: it changes every member's badge at once.",
      },
      { status: 403 },
    );
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let body: { periodId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const periodId = typeof body.periodId === "string" ? body.periodId.trim() : "";
  if (!periodId) {
    return NextResponse.json({ error: "Name the period to make current." }, { status: 400 });
  }

  // The pointer must name a period that exists. A pointer at a missing
  // document reads as "no current period" everywhere, which is
  // indistinguishable from a broken deploy on the day the badge goes blank.
  const period = await db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId).get();
  if (!period.exists) {
    return NextResponse.json({ error: "No such membership period" }, { status: 404 });
  }

  await db
    .collection(MEMBERSHIP_CONFIG_PATH.collection)
    .doc(MEMBERSHIP_CONFIG_PATH.doc)
    .set(
      {
        currentPeriodId: periodId,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: user.uid,
      },
      // Merge: `config/membership` is a shared document, and a later field
      // added beside the pointer must not be dropped by this write.
      { merge: true },
    );

  return NextResponse.json({ currentPeriodId: periodId });
}

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership } from "@/lib/firestore/users";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  planTotalsRecount,
  type MembershipTier,
} from "@/lib/firestore/memberships";

/**
 * Rebuild one period's four cached tier totals from the membership rows.
 *
 * ## Why a cache needs a repair button at all
 *
 * The totals on a period document are moved by `increment`, by the grant route
 * and by each chunk of an import commit. The commit deliberately does not fail
 * when that update fails: the memberships are the record and a counter is not
 * worth refusing an import over. What it leaves behind, though, is a console
 * reporting a headcount that no longer agrees with the table underneath it,
 * with no way back short of editing the document by hand. This is that way
 * back, and the commit now reports `totalsMoved: false` so somebody knows to
 * press it.
 *
 * ## Four aggregates, not a scan
 *
 * One `count()` per tier over `(periodId, tier)`, which is the composite index
 * the console's list already owes. Four billed reads whatever the size of the
 * society, rather than paging every membership row for the period.
 *
 * A tier already holding the right number is left out of the write, so a
 * period whose counts were fine is not touched and the response says nothing
 * was corrected. `planTotalsRecount` holds that arithmetic and is pure.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ periodId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canManageMembership(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { periodId } = await params;

  try {
    const ref = db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "No such membership period" }, { status: 404 });
    }

    const counted: Partial<Record<MembershipTier, number>> = {};
    for (const tier of ALL_MEMBERSHIP_TIERS) {
      const agg = await db
        .collection(MEMBERSHIPS_COLLECTION)
        .where("periodId", "==", periodId)
        .where("tier", "==", tier)
        .count()
        .get();
      counted[tier] = agg.data().count;
    }

    const plan = planTotalsRecount(counted, snap.data()?.totals);
    // Nothing to write when nothing was wrong. A period whose counts already
    // agree with its rows should not gain an `updatedAt` for being checked.
    if (Object.keys(plan.update).length > 0) {
      await ref.update(plan.update);
    }

    return NextResponse.json({
      periodId,
      totals: plan.totals,
      corrected: plan.corrected,
    });
  } catch (err) {
    console.error("[membership/recount] failed:", periodId, err);
    return NextResponse.json(
      { error: "Those totals could not be recounted." },
      { status: 500 },
    );
  }
}

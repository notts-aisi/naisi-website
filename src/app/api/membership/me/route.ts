import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_CONFIG_PATH,
  MEMBERSHIP_PERIODS_COLLECTION,
  normalizeMembership,
  normalizeMembershipPeriod,
  projectMembershipForMe,
} from "@/lib/firestore/memberships";

/**
 * The caller's own membership: the current period, their row on it, and the
 * years they have been a member.
 *
 * ## Why this route exists at all
 *
 * `memberships` is `allow read, write: if false`, INCLUDING the own-row read
 * that looks obvious here. A `get` of a MISSING document evaluates
 * `resource.data.uid` against null and denies, so "you have no membership row"
 * and "you are not allowed to look" come back to the browser as the same
 * permission-denied error, and the profile could not tell the difference
 * between a member with no membership and a broken rule. That trap is already
 * recorded on `useMyApplication.ts`. So the member path is this route and
 * nothing else, and "no row" is a plain `null` in the payload.
 *
 * ## What it does not return
 *
 * No provenance beyond the date the membership was recorded, and no period
 * note. Who granted it, which import batch it came from and what an admin
 * wrote about the period are all admin material. The projection is a function
 * in `memberships.ts` rather than an object literal here, so that promise is
 * one testable line instead of a spread that leaks the next field somebody
 * adds.
 *
 * A GET, and it writes nothing.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const configSnap = await db
    .collection(MEMBERSHIP_CONFIG_PATH.collection)
    .doc(MEMBERSHIP_CONFIG_PATH.doc)
    .get();
  const rawCurrent = configSnap.data()?.currentPeriodId;
  const currentPeriodId =
    typeof rawCurrent === "string" && rawCurrent !== "" ? rawCurrent : null;

  const periodSnap = currentPeriodId
    ? await db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(currentPeriodId).get()
    : null;
  const period =
    periodSnap && periodSnap.exists
      ? normalizeMembershipPeriod(periodSnap.id, periodSnap.data() ?? {})
      : null;

  // Every row this account holds. Equality on one field, so the automatic
  // single-field index serves it and no composite index is owed. The year is
  // derived from the period id rather than joined, so a ten-year history is
  // still one query.
  //
  // The CURRENT row is picked out of this rather than read at its address:
  // there is one row per period, `paidMembershipYears` caps a member at ten
  // years, and the limit is 50, so the current period's row is in here
  // whenever it exists and an addressed `get` would only be the same document
  // fetched twice.
  const historySnap = await db
    .collection(MEMBERSHIPS_COLLECTION)
    .where("uid", "==", user.uid)
    .limit(50)
    .get();
  const history = historySnap.docs.map((d) => normalizeMembership(d.id, d.data() ?? {}));

  const current = currentPeriodId
    ? (history.find((row) => row.periodId === currentPeriodId) ?? null)
    : null;

  return NextResponse.json(projectMembershipForMe(period, current, history));
}

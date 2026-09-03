import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership, ACADEMIC_YEAR_PATTERN } from "@/lib/firestore/users";
import {
  MEMBERSHIP_CONFIG_PATH,
  MEMBERSHIP_FIELD_LIMITS,
  MEMBERSHIP_PERIODS_COLLECTION,
  normalizeMembershipPeriod,
  validatePeriodDates,
  periodIdForYear,
  zeroMembershipTotals,
} from "@/lib/firestore/memberships";

/**
 * The membership periods index: list them, and create one.
 *
 * ## Why a route at all
 *
 * `membershipPeriods` is `allow read, write: if false`. The period document
 * carries a 200-character internal note an admin writes for other admins, and
 * nothing member-facing needs the collection now that `GET /api/membership/me`
 * exists, so there is no client read to fall back on and this is the only
 * door.
 *
 * ## Who
 *
 * Admins and `manageMembership` holders, both halves. The one thing this route
 * cannot do is move the CURRENT pointer: that is `POST
 * /api/admin/membership/current` and full admins only, because it re-badges
 * every member on the site at once.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */

/** The pointer document, read on the list so the console can mark one row
 *  CURRENT without a second request. */
async function readCurrentPeriodId(
  db: FirebaseFirestore.Firestore,
): Promise<string | null> {
  const snap = await db
    .collection(MEMBERSHIP_CONFIG_PATH.collection)
    .doc(MEMBERSHIP_CONFIG_PATH.doc)
    .get();
  const value = snap.data()?.currentPeriodId;
  return typeof value === "string" && value !== "" ? value : null;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canManageMembership(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // No orderBy. `createdAt` is stamped here, but a period restored by hand
  // would be DROPPED from an ordered query rather than merely mis-sorted, and
  // a missing period on this console is the one failure nobody would look for.
  // A handful of documents, sorted below.
  const snap = await db.collection(MEMBERSHIP_PERIODS_COLLECTION).get();
  const periods = snap.docs
    .map((d) => normalizeMembershipPeriod(d.id, d.data() ?? {}))
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((p) => ({
      id: p.id,
      year: p.year,
      label: p.label,
      startsOn: p.startsOn,
      endsOn: p.endsOn,
      note: p.note,
      totals: p.totals,
      createdAt: p.createdAt ? p.createdAt.toISOString() : null,
    }));

  return NextResponse.json({
    periods,
    currentPeriodId: await readCurrentPeriodId(db),
    // The console renders the "set current" button off this rather than
    // guessing from the role, so the button and the route it calls agree.
    canSetCurrent: user.role === "admin",
  });
}

/**
 * Create a period.
 *
 * The doc id is DERIVED from the year (`2026/27` becomes `2026-27`), never
 * supplied, and the write is a `create()`, so re-submitting the form cannot
 * overwrite a live period's dates or note: a second attempt at the same year
 * comes back as a 409 naming the year rather than silently replacing it.
 */
export async function POST(req: Request) {
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

  let body: {
    year?: unknown;
    label?: unknown;
    startsOn?: unknown;
    endsOn?: unknown;
    note?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const year = typeof body.year === "string" ? body.year.trim() : "";
  if (!ACADEMIC_YEAR_PATTERN.test(year)) {
    return NextResponse.json(
      { error: "Give the academic year as 2026/27." },
      { status: 400 },
    );
  }

  const dates = validatePeriodDates(body.startsOn, body.endsOn);
  if ("error" in dates) {
    return NextResponse.json({ error: dates.error }, { status: 400 });
  }

  const label =
    typeof body.label === "string"
      ? body.label.trim().slice(0, MEMBERSHIP_FIELD_LIMITS.label)
      : "";
  const note =
    typeof body.note === "string"
      ? body.note.trim().slice(0, MEMBERSHIP_FIELD_LIMITS.note)
      : "";

  const periodId = periodIdForYear(year);
  const ref = db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId);

  try {
    await ref.create({
      year,
      label: label || `Membership ${year}`,
      startsOn: dates.startsOn,
      endsOn: dates.endsOn,
      note,
      totals: zeroMembershipTotals(),
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: user.uid,
    });
  } catch (err) {
    // `create()` rejects with ALREADY_EXISTS when the document is there, which
    // is the one failure the deterministic id makes likely and the only one a
    // 409 describes. Every other rejection is the datastore refusing the
    // write, and answering that with "already exists" would send an admin
    // looking for a period nothing ever wrote.
    if (isAlreadyExists(err)) {
      return NextResponse.json(
        { error: `A membership period for ${year} already exists.` },
        { status: 409 },
      );
    }
    console.error("[membership/periods] create failed:", periodId, err);
    return NextResponse.json(
      { error: "Could not create that membership period." },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: periodId, year });
}

/**
 * ALREADY_EXISTS, however the Admin SDK hands it over: the numeric gRPC status
 * on `code`, or the string form the REST transport and the client SDK use.
 * Everything else is a 500.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

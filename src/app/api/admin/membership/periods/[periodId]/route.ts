import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIP_FIELD_LIMITS,
  MEMBERSHIP_PERIODS_COLLECTION,
  validatePeriodDates,
} from "@/lib/firestore/memberships";

/**
 * Edit one period's label, dates and internal note.
 *
 * Deliberately NOT the year. The year IS the doc id (`2026/27` is
 * `2026-27`) and it is the string every membership row's cache entry is
 * written against, so an editable year would mean renaming a document and
 * rewriting every `paidMembershipYears` entry that points at it. A period
 * created against the wrong year is a period with no members yet: create the
 * right one.
 *
 * There is no DELETE either. A period with rows under it is the record of who
 * paid that year, and a period without them costs nothing to leave alone.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function PATCH(
  req: Request,
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
  const ref = db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No such membership period" }, { status: 404 });
  }

  let body: {
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

  // Absent keys leave the stored value alone; there is no `undefined` in the
  // update, because Firestore refuses one and because a form that only
  // touches the note must not blank the dates.
  const update: Record<string, string> = {};

  if ("label" in body) {
    if (typeof body.label !== "string") {
      return NextResponse.json({ error: "The label must be text." }, { status: 400 });
    }
    update.label = body.label.trim().slice(0, MEMBERSHIP_FIELD_LIMITS.label);
  }

  if ("note" in body) {
    if (typeof body.note !== "string") {
      return NextResponse.json({ error: "The note must be text." }, { status: 400 });
    }
    update.note = body.note.trim().slice(0, MEMBERSHIP_FIELD_LIMITS.note);
  }

  if ("startsOn" in body || "endsOn" in body) {
    const existing = snap.data() ?? {};
    const dates = validatePeriodDates(
      "startsOn" in body ? body.startsOn : existing.startsOn,
      "endsOn" in body ? body.endsOn : existing.endsOn,
    );
    if ("error" in dates) {
      return NextResponse.json({ error: dates.error }, { status: 400 });
    }
    update.startsOn = dates.startsOn;
    update.endsOn = dates.endsOn;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  await ref.update(update);
  return NextResponse.json({ id: periodId });
}

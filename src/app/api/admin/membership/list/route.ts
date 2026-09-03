import { NextResponse } from "next/server";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  membershipId,
  normalizeMembership,
  normalizeMembershipPeriod,
} from "@/lib/firestore/memberships";
import {
  MEMBERSHIP_LIST_PAGE_SIZE,
  projectMembershipRow,
  previousPeriodId,
  type MembershipListRow,
} from "@/features/admin/membershipList";

/**
 * The membership table: every ACCOUNT, joined to its membership row for one
 * period.
 *
 * ## Why this is not the Members page
 *
 * The Members list is the roster: approved people, with the roster's own PII
 * tier around it. This table exists to answer a different question, "who on
 * the SU list has an account here, and who has not been recorded yet", and the
 * accounts that most need answering for are the PENDING ones. Somebody who
 * registered on Monday, paid the SU on Tuesday and is still waiting for
 * approval on Wednesday is invisible on the Members page and is exactly who an
 * admin is looking for here. So the page is every account, pending included,
 * and `role` is a column rather than a filter applied before you see it.
 *
 * ## What a row carries, and who may read it
 *
 * Field by field, never a spread: uid, the two names, the university email,
 * the sign-in email, the role, and the membership half (tier, source, how they
 * were matched, when and by whom it was recorded). A `...user` would leak
 * whatever the next PR adds to the user document into a payload nobody
 * re-reads.
 *
 * ADMINS AND `manageMembership` HOLDERS BOTH SEE THE ADDRESSES, deliberately.
 * The addresses ARE the work here: the import matches on them, and a holder
 * looking at "no account matches this person" has to be able to see that the
 * SU spelled the address differently. This is the same data the Members page
 * already shows an admin, and `manageMembership` is granted to somebody who
 * keeps the society's membership record. It is not the SU-recognised PII tier
 * and does not become it: nothing else opens off this key.
 *
 * ## Paging, and what LAPSED means
 *
 * Paged by document id with a cursor, because a `users` scan is the one read
 * here that grows without bound. `lapsed` is computed per row against the
 * period immediately before this one: a row in that period and none in this
 * one is somebody who was a member last year and has not renewed. It is
 * derived here rather than stored, so it can never be stale.
 *
 * A GET, so no impersonation guard: this route reads, and reading what a
 * member sees is what view-as is FOR. Every write in this tree is guarded.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canManageMembership(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const periodId = (url.searchParams.get("periodId") ?? "").trim();
  const cursor = (url.searchParams.get("cursor") ?? "").trim();
  if (!periodId) {
    return NextResponse.json(
      { error: "Name the membership period to list." },
      { status: 400 },
    );
  }

  try {
    const periodsSnap = await db.collection(MEMBERSHIP_PERIODS_COLLECTION).get();
    const periods = periodsSnap.docs.map((d) =>
      normalizeMembershipPeriod(d.id, d.data() ?? {}),
    );
    const period = periods.find((p) => p.id === periodId) ?? null;
    if (!period) {
      return NextResponse.json({ error: "No such membership period" }, { status: 404 });
    }
    const previousId = previousPeriodId(periods.map((p) => p.id), periodId);

    // One page of accounts, ordered by document id so the cursor is a uid and
    // a page boundary cannot shift under an edit.
    let query = db
      .collection("users")
      .orderBy(FieldPath.documentId())
      .limit(MEMBERSHIP_LIST_PAGE_SIZE + 1);
    if (cursor) query = query.startAfter(cursor);
    const usersSnap = await query.get();

    const docs = usersSnap.docs.slice(0, MEMBERSHIP_LIST_PAGE_SIZE);
    const hasMore = usersSnap.docs.length > MEMBERSHIP_LIST_PAGE_SIZE;
    const nextCursor = hasMore && docs.length > 0 ? docs[docs.length - 1].id : null;

    const membershipsById = await readMembershipRows(
      db,
      docs.map((d) => d.id),
      periodId,
    );
    const previousById = previousId
      ? await readMembershipRows(db, docs.map((d) => d.id), previousId)
      : new Map<string, ReturnType<typeof normalizeMembership>>();

    // Who recorded each membership, resolved to a name. The grantors are a
    // handful of admins, so this is one addressed read per DISTINCT uid on the
    // page and usually a cache hit inside it.
    const nameByUid = new Map<string, string>();
    for (const doc of docs) {
      const data = doc.data() ?? {};
      const displayName = typeof data.displayName === "string" ? data.displayName : "";
      if (displayName) nameByUid.set(doc.id, displayName);
    }
    const missing = new Set<string>();
    for (const row of membershipsById.values()) {
      const by = row.provenance.byUid;
      if (by && !nameByUid.has(by)) missing.add(by);
    }
    if (missing.size > 0) {
      const grantors = await db.getAll(
        ...[...missing].map((uid) => db.collection("users").doc(uid)),
      );
      for (const snap of grantors) {
        const displayName = snap.data()?.displayName;
        nameByUid.set(snap.id, typeof displayName === "string" ? displayName : "");
      }
    }

    const rows: MembershipListRow[] = docs.map((doc) =>
      projectMembershipRow(
        doc.id,
        doc.data() ?? {},
        membershipsById.get(doc.id) ?? null,
        previousById.has(doc.id),
        nameByUid,
      ),
    );

    return NextResponse.json({
      periodId,
      previousPeriodId: previousId,
      totals: period.totals,
      rows,
      nextCursor,
    });
  } catch (err) {
    console.error("[membership/list] failed:", periodId, err);
    return NextResponse.json(
      { error: "Could not load the membership list." },
      { status: 500 },
    );
  }
}

/** Addressed reads for one page of uids. `getAll` refuses an empty call. */
async function readMembershipRows(
  db: FirebaseFirestore.Firestore,
  uids: string[],
  periodId: string,
): Promise<Map<string, ReturnType<typeof normalizeMembership>>> {
  const out = new Map<string, ReturnType<typeof normalizeMembership>>();
  if (uids.length === 0) return out;
  const snaps = await db.getAll(
    ...uids.map((uid) =>
      db.collection(MEMBERSHIPS_COLLECTION).doc(membershipId(uid, periodId)),
    ),
  );
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const row = normalizeMembership(snap.id, snap.data() ?? {});
    if (row.revokedAt !== null) continue;
    if (row.uid) out.set(row.uid, row);
  }
  return out;
}

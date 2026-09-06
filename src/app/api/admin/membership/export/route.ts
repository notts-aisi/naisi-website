import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership } from "@/lib/firestore/users";
import { toCSV } from "@/lib/csv";
import { logExport } from "@/lib/firestore/dataExports";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  MEMBERSHIP_TIER_LABELS,
  normalizeMembership,
  normalizeMembershipPeriod,
} from "@/lib/firestore/memberships";

/**
 * One period's membership list, as a CSV.
 *
 * ## A POST, and the log is written FIRST
 *
 * Two rules, both from the house list and both load-bearing here:
 *
 *  - NO WRITE ON A GET. A browser prefetches a GET, a proxy retries one, and
 *    a link somebody pastes into a chat is fetched by whatever unfurls it.
 *    An export writes an audit row, so it cannot be a GET;
 *  - the `dataExports` row is written BEFORE the CSV file is built, and a
 *    failure to write it REFUSES the export. `logExport` throws rather than
 *    swallowing exactly so this is not optional. A list of named people
 *    leaving the platform with no record of who took it is the thing the log
 *    exists to prevent, and "the log was down" is not a reason to hand it over
 *    anyway.
 *
 * To be exact about the order: the membership rows and the names ARE read
 * first, because `rowCount` belongs in the record and an estimate would make
 * the log worth less than it is. Those rows sit in memory and go nowhere. What
 * the log gates is the only step that hands them over, and nothing between the
 * log write and the response can fail open.
 *
 * ## The query, and the index it needs
 *
 * `where(periodId ==).orderBy(tier)` needs the composite index
 * `memberships (periodId ASC, tier ASC)` declared in `firestore.indexes.json`.
 * Ordering by tier groups the file the way somebody reading it wants it, and
 * paging on that order is what keeps a big period off one unbounded read.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */

/** Rows per page while the file is assembled. */
const PAGE = 500;

/** Pages. Well past any plausible year of a student society; a period that
 *  ran past it would silently export a partial list, so it throws instead. */
const MAX_PAGES = 40;

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

  const url = new URL(req.url);
  const periodId = (url.searchParams.get("periodId") ?? "").trim();
  if (!periodId) {
    return NextResponse.json(
      { error: "Name the membership period to export." },
      { status: 400 },
    );
  }

  let rows: string[][];
  let filename: string;
  try {
    const periodSnap = await db
      .collection(MEMBERSHIP_PERIODS_COLLECTION)
      .doc(periodId)
      .get();
    if (!periodSnap.exists) {
      return NextResponse.json({ error: "No such membership period" }, { status: 404 });
    }
    const period = normalizeMembershipPeriod(periodSnap.id, periodSnap.data() ?? {});

    const memberships = await readPeriodMemberships(db, periodId);
    // Both the people in the file and the admins who recorded them: the
    // "recorded by" column is a name, because a uid in a spreadsheet tells the
    // person reading it nothing they can act on.
    const names = await readNames(db, [
      ...memberships.map((m) => m.uid),
      ...memberships.map((m) => m.provenance.byUid),
    ]);

    rows = memberships.map((row) => [
      row.uid,
      names.get(row.uid)?.displayName ?? "",
      names.get(row.uid)?.email ?? "",
      names.get(row.uid)?.universityEmail ?? "",
      MEMBERSHIP_TIER_LABELS[row.tier],
      row.source,
      row.matchedOn,
      row.provenance.at ? row.provenance.at.toISOString() : "",
      names.get(row.provenance.byUid)?.displayName ?? "",
      row.provenance.batchId ?? "",
    ]);
    filename = `naisi-membership-${period.id}.csv`;
  } catch (err) {
    console.error("[membership/export] build failed:", periodId, err);
    return NextResponse.json(
      { error: "Could not build that export." },
      { status: 500 },
    );
  }

  // THE LOG, BEFORE THE BODY. A throw here is a refusal, not a warning.
  try {
    await logExport(db, {
      kind: "membership",
      actorUid: user.uid,
      actorName: user.displayName ?? "",
      scope: { periodId },
      rowCount: rows.length,
      filename,
    });
  } catch (err) {
    console.error("[membership/export] log write failed:", periodId, err);
    return NextResponse.json(
      {
        error:
          "The export could not be recorded, so it was not produced. "
          + "Every download of a list of people is logged. Try again shortly.",
      },
      { status: 503 },
    );
  }

  const body = toCSV(
    [
      "uid",
      "name",
      "email",
      "university email",
      "tier",
      "source",
      "matched on",
      "recorded at",
      "recorded by",
      "import batch",
    ],
    rows,
  );

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Never cached: it names people, and a cached copy is a copy nobody
      // logged.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Every membership row for the period, ordered by tier so the file groups the
 * way a reader wants it. Paged, and capped rather than truncated silently.
 */
async function readPeriodMemberships(
  db: FirebaseFirestore.Firestore,
  periodId: string,
): Promise<ReturnType<typeof normalizeMembership>[]> {
  const out: ReturnType<typeof normalizeMembership>[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = db
      .collection(MEMBERSHIPS_COLLECTION)
      .where("periodId", "==", periodId)
      .orderBy("tier")
      .limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return out;
    for (const doc of snap.docs) {
      const row = normalizeMembership(doc.id, doc.data() ?? {});
      if (row.revokedAt === null) out.push(row);
    }
    if (snap.size < PAGE) return out;
    cursor = snap.docs[snap.docs.length - 1];
  }
  throw new Error(`${MEMBERSHIPS_COLLECTION} did not drain after ${MAX_PAGES} pages`);
}

/** Names and addresses for the uids in the file, in addressed reads. */
async function readNames(
  db: FirebaseFirestore.Firestore,
  uids: readonly string[],
): Promise<Map<string, { displayName: string; email: string; universityEmail: string }>> {
  const out = new Map<
    string,
    { displayName: string; email: string; universityEmail: string }
  >();
  const distinct = [...new Set(uids.filter((uid) => uid !== ""))];
  for (let i = 0; i < distinct.length; i += PAGE) {
    const slice = distinct.slice(i, i + PAGE);
    if (slice.length === 0) continue;
    const snaps = await db.getAll(
      ...slice.map((uid) => db.collection("users").doc(uid)),
    );
    for (const snap of snaps) {
      const data = snap.data() ?? {};
      const profile = (data.profile ?? {}) as Record<string, unknown>;
      out.set(snap.id, {
        displayName: typeof data.displayName === "string" ? data.displayName : "",
        email: typeof data.email === "string" ? data.email : "",
        universityEmail:
          typeof profile.universityEmail === "string" ? profile.universityEmail : "",
      });
    }
  }
  return out;
}

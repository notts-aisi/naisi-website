import { NextResponse } from "next/server";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIP_PERIODS_COLLECTION,
  isMembershipTier,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import {
  MEMBERSHIP_IMPORTS_COLLECTION,
  MEMBERSHIP_IMPORT_LIMITS,
  MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION,
  MEMBERSHIP_IMPORT_UNFINISHED,
  buildMatchIndex,
  candidatesFrom,
  membershipImportBatchId,
  normalizeMembershipImport,
  normalizeMembershipImportRow,
  parseCsv,
  projectImportBatch,
  projectImportRow,
  planImportRows,
  resolveColumns,
  summariseImport,
  type MatchableAccount,
} from "@/lib/firestore/membershipImports";

/**
 * The SU list, uploaded: parse it, match it, write the batch, report.
 *
 * NOTHING IS GRANTED HERE. This route is the dry run and only the dry run: it
 * writes `membershipImports/{batchId}` and one row per line, and touches
 * neither `memberships` nor anybody's badge. The commit is a second, explicit
 * call, so an admin sees what a file would do before it does it, and so a
 * mis-parsed column costs a deleted batch rather than 600 wrong memberships.
 *
 * ## One pass over `users`, not one per row
 *
 * `findVerifiedUniEmailOwner` is the case-folded uni-email lookup, and it
 * scans the whole collection per call. That is right for a registration
 * checking one address and would be 600 full scans here, so the same folding
 * is done once into an in-memory index (`buildMatchIndex`). The index is built
 * fresh per upload: an account created between the upload and the commit is
 * simply matched by the next upload, which is honest and needs no cache.
 *
 * ## The rows are the record, and the commit reads them from Firestore
 *
 * Row ids are the zero-padded line number, so the commit walks them in file
 * order with addressed reads and no index. The commit never reads a row from a
 * request body: a name match is confirm-only precisely because a name is weak
 * evidence, and a posted row would let the browser assert both the match and
 * the confirmation in one go.
 *
 * The GET half returns the batch and a page of its rows, so the console can
 * show the confirm list after a reload and after a partial commit. Asked for a
 * period instead of a batch, it lists the imports on that period that are not
 * finished, which is the only way an admin gets back to one after a reload.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */

/** Rows per Firestore write batch. The limit is 500 operations. */
const WRITE_CHUNK = 400;

/** Accounts read per page while the match index is built. */
const USER_PAGE = 500;

/** Pages of accounts. Ten thousand accounts is far past NAISI scale; a scan
 *  that would run past it stops and says so rather than matching against half
 *  the society. */
const USER_MAX_PAGES = 20;

/** Rows returned per page by the GET half. */
const ROW_PAGE = 200;

/** Batches scanned, newest first, when the console asks what is unfinished. */
const RESUME_SCAN = 25;

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
    periodId?: unknown;
    csv?: unknown;
    filename?: unknown;
    defaultTier?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const periodId = typeof body.periodId === "string" ? body.periodId.trim() : "";
  const csv = typeof body.csv === "string" ? body.csv : "";
  const filename =
    typeof body.filename === "string"
      ? body.filename.trim().slice(0, MEMBERSHIP_IMPORT_LIMITS.filename)
      : "";
  const defaultTier: MembershipTier = isMembershipTier(body.defaultTier)
    ? body.defaultTier
    : "paid";

  if (!periodId) {
    return NextResponse.json(
      { error: "Pick the membership period this list is for." },
      { status: 400 },
    );
  }
  if (csv.trim() === "") {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (csv.length > MEMBERSHIP_IMPORT_LIMITS.maxCsvChars) {
    return NextResponse.json(
      {
        error:
          "That file is too big to read in one go. Split it and import the "
          + "halves separately.",
      },
      { status: 413 },
    );
  }

  const parsed = parseCsv(csv);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const columns = resolveColumns(parsed.header);
  if ("error" in columns) {
    return NextResponse.json({ error: columns.error }, { status: 400 });
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json(
      { error: "That file has a header and no people under it." },
      { status: 400 },
    );
  }
  if (parsed.rows.length > MEMBERSHIP_IMPORT_LIMITS.maxRows) {
    return NextResponse.json(
      {
        error:
          `That file has ${parsed.rows.length} rows and the limit is `
          + `${MEMBERSHIP_IMPORT_LIMITS.maxRows}. Split it rather than trimming it.`,
      },
      { status: 413 },
    );
  }

  try {
    const periodSnap = await db
      .collection(MEMBERSHIP_PERIODS_COLLECTION)
      .doc(periodId)
      .get();
    if (!periodSnap.exists) {
      return NextResponse.json({ error: "No such membership period" }, { status: 404 });
    }

    const accounts = await readAccounts(db);
    const index = buildMatchIndex(accounts);
    const candidates = candidatesFrom(parsed.rows, columns, defaultTier);
    const planned = planImportRows(index, candidates);
    const receipt = summariseImport(planned);

    const uploadedAt = new Date();
    const batchId = membershipImportBatchId(periodId, uploadedAt);
    const batchRef = db.collection(MEMBERSHIP_IMPORTS_COLLECTION).doc(batchId);
    const rowsRef = batchRef.collection(MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION);

    // THE BATCH DOCUMENT FIRST, in `writing`, then the rows, then the flip to
    // `dry-run`.
    //
    // Rows-first was the tidier-looking order, because a batch that exists is
    // then a batch whose rows are all there. What it costs is the crash case:
    // up to five thousand row documents under a parent that does not exist,
    // which nothing lists, nothing can find and nobody can clean up without
    // the console. A parent in `writing` is visible in the unfinished list
    // from the first write, and Abandon closes it. The commit route refuses a
    // `writing` batch, so the property rows-first was protecting is kept: a
    // commit never walks a `totalRows` the rows have not made good on.
    await batchRef.create({
      periodId,
      filename,
      status: "writing",
      totalRows: planned.length,
      counts: {
        uniEmail: receipt.uniEmail,
        personalEmail: receipt.personalEmail,
        needsConfirm: receipt.needsConfirm,
        duplicate: receipt.duplicate,
        unmatched: receipt.unmatched,
      },
      committedRows: 0,
      skippedRows: 0,
      awaitingConfirm: 0,
      nextRowSeq: 1,
      uploadedAt: FieldValue.serverTimestamp(),
      uploadedByUid: user.uid,
      uploadedByName: user.displayName ?? "",
      lastCommitAt: null,
      lastCommitByUid: "",
    });

    for (let i = 0; i < planned.length; i += WRITE_CHUNK) {
      const writes = db.batch();
      for (const row of planned.slice(i, i + WRITE_CHUNK)) {
        writes.create(rowsRef.doc(row.rowId), {
          seq: row.seq,
          line: row.line,
          name: row.name,
          email: row.email,
          uniEmail: row.uniEmail,
          tier: row.tier,
          matchKind: row.match.kind,
          // Null, never undefined, and never absent: the commit branches on
          // it and an absent key would read as "no match" on a row that had
          // one.
          matchedUid: row.match.uid,
          matchNote: row.match.note,
          state: "pending",
          skipReason: "",
          committedAt: null,
          confirmedByUid: "",
          confirmedByName: "",
        });
      }
      await writes.commit();
    }

    // Every row landed. The batch is now what it claims to be.
    await batchRef.update({ status: "dry-run" });

    return NextResponse.json({
      batchId,
      periodId,
      receipt,
      accountsScanned: accounts.length,
      // The rows a human has to look at, first page. Everything else is
      // reported as a count: an admin confirms name matches one by one and
      // reads the rest as a total.
      rows: planned
        .filter((row) => row.match.kind === "name")
        .slice(0, ROW_PAGE)
        .map((row) => ({
          rowId: row.rowId,
          line: row.line,
          name: row.name,
          email: row.email,
          uniEmail: row.uniEmail,
          tier: row.tier,
          matchKind: row.match.kind,
          matchedUid: row.match.uid,
          matchNote: row.match.note,
          state: "pending" as const,
          skipReason: "",
          confirmedByName: "",
        })),
      rowsTruncated: receipt.needsConfirm > ROW_PAGE,
    });
  } catch (err) {
    console.error("[membership/import] failed:", periodId, err);
    return NextResponse.json(
      { error: "Could not read that file into an import." },
      { status: 500 },
    );
  }
}

/**
 * The batch and a page of its rows.
 *
 * The console needs this after a reload and after every commit chunk: which
 * rows are still waiting on a confirmation is a fact about Firestore, not
 * about what the browser remembers from the upload.
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
  const batchId = (url.searchParams.get("batchId") ?? "").trim();
  const cursor = (url.searchParams.get("cursor") ?? "").trim();
  const pendingOnly = url.searchParams.get("pendingOnly") !== "false";

  if (!batchId) {
    // THE RESUME LIST. No batch named, so the question is "what is still
    // open on this period", which is what the console asks on mount. Without
    // it a reload orphans an unfinished import: the batch id lived only in the
    // panel's state, and nothing else lists one.
    const periodId = (url.searchParams.get("periodId") ?? "").trim();
    if (!periodId) {
      return NextResponse.json(
        { error: "Name the import to read, or the period to list." },
        { status: 400 },
      );
    }
    return listUnfinished(db, periodId);
  }

  try {
    const batchRef = db.collection(MEMBERSHIP_IMPORTS_COLLECTION).doc(batchId);
    const snap = await batchRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "No such import" }, { status: 404 });
    }
    const batch = normalizeMembershipImport(snap.id, snap.data() ?? {});

    // Ordered by document id, which IS file order, so no index is owed and a
    // row written by hand without a `seq` still sorts where it belongs.
    let query = batchRef
      .collection(MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(ROW_PAGE + 1);
    if (cursor) query = query.startAfter(cursor);
    const rowsSnap = await query.get();
    const docs = rowsSnap.docs.slice(0, ROW_PAGE);
    const nextCursor =
      rowsSnap.docs.length > ROW_PAGE && docs.length > 0 ? docs[docs.length - 1].id : null;

    const rows = docs
      .map((d) => normalizeMembershipImportRow(d.id, d.data() ?? {}))
      // Filtered in memory rather than by a `where`, so the page size stays
      // the page size and no composite index is owed for a screen that shows
      // at most a few hundred rows.
      .filter((row) => (pendingOnly ? row.state === "pending" : true))
      .map(projectImportRow);

    return NextResponse.json({ batch: projectImportBatch(batch), rows, nextCursor });
  } catch (err) {
    console.error("[membership/import] read failed:", batchId, err);
    return NextResponse.json({ error: "Could not read that import." }, { status: 500 });
  }
}

/**
 * The imports on one period an admin still has work to do on.
 *
 * Equality on `periodId` and a descending document-id order, which the
 * automatic single-field index serves: no composite index is owed. Batch ids
 * are `import {periodId} {ISO minute}` slugged, so descending id order IS
 * newest-first, and the scan is capped at the most recent `RESUME_SCAN`
 * batches. An unfinished import older than the last two dozen uploads on the
 * same period is not something a resume list should be keeping warm; it is
 * findable in the console, and Abandon closes it.
 *
 * `writing` is in the list on purpose. A dry run that died between creating
 * the batch and finishing its rows leaves one, it can never be committed, and
 * this is the only surface that shows it exists.
 */
async function listUnfinished(db: FirebaseFirestore.Firestore, periodId: string) {
  try {
    const snap = await db
      .collection(MEMBERSHIP_IMPORTS_COLLECTION)
      .where("periodId", "==", periodId)
      .orderBy(FieldPath.documentId(), "desc")
      .limit(RESUME_SCAN)
      .get();

    const batches = snap.docs
      .map((d) => normalizeMembershipImport(d.id, d.data() ?? {}))
      .filter((batch) => MEMBERSHIP_IMPORT_UNFINISHED.includes(batch.status))
      .map(projectImportBatch);

    return NextResponse.json({ batches });
  } catch (err) {
    console.error("[membership/import] resume list failed:", periodId, err);
    return NextResponse.json(
      { error: "Could not list the unfinished imports." },
      { status: 500 },
    );
  }
}

/**
 * Every account, reduced to the three things a row can be matched against.
 *
 * Paged by document id so a growing society does not turn this into one
 * unbounded read, and capped: a scan that would run past `USER_MAX_PAGES`
 * throws rather than matching a file against a partial roster, because a
 * partial index does not fail loudly, it just reports people as unmatched.
 */
async function readAccounts(
  db: FirebaseFirestore.Firestore,
): Promise<MatchableAccount[]> {
  const accounts: MatchableAccount[] = [];
  let cursor = "";
  for (let page = 0; page < USER_MAX_PAGES; page += 1) {
    let query = db
      .collection("users")
      .orderBy(FieldPath.documentId())
      .limit(USER_PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return accounts;
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      const profile = (data.profile ?? {}) as Record<string, unknown>;
      accounts.push({
        uid: doc.id,
        email: typeof data.email === "string" ? data.email : "",
        displayName: typeof data.displayName === "string" ? data.displayName : "",
        preferredName:
          typeof profile.preferredName === "string" ? profile.preferredName : "",
        // ONLY the verified address. An unverified one is somebody's typing,
        // not evidence, and matching on it would let anyone claim a stranger's
        // membership by writing their address into a profile field.
        verifiedUniEmail:
          profile.uniEmailVerifiedAt && typeof profile.universityEmail === "string"
            ? profile.universityEmail
            : "",
      });
    }
    if (snap.size < USER_PAGE) return accounts;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
  throw new Error(
    `users did not drain after ${USER_MAX_PAGES} pages; the match index would be partial`,
  );
}

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { FIELD_LIMITS, canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  MembershipYearCapError,
  TIER_COUNTS_AS_MEMBER,
  addPaidMembershipYear,
  isMembershipTier,
  membershipId,
  normalizeMembership,
  removePaidMembershipYear,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import {
  MEMBERSHIP_IMPORTS_COLLECTION,
  MEMBERSHIP_IMPORT_LIMITS,
  MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION,
  membershipImportRowId,
  normalizeMembershipImport,
  normalizeMembershipImportRow,
  planCommitRow,
  tierDeltas,
  type CommitDecision,
} from "@/lib/firestore/membershipImports";

/**
 * Commit one chunk of an import.
 *
 * ## Four rules, and each of them is a thing that went wrong somewhere else
 *
 *  1. THE ROWS ARE READ FROM FIRESTORE. The body carries row IDS to confirm
 *     and nothing else. A commit that trusted a posted row would let the
 *     browser assert the match and the confirmation in the same request, which
 *     is exactly what "the name tier is confirm-only" is meant to prevent.
 *  2. `create()`, NEVER `set()`. An existing membership row is left exactly as
 *     it is, whatever it says, and the row is stamped skipped with the
 *     disagreement written out. A `set()` re-run would rewrite
 *     `provenance.at`, and would silently replace the comped grant an admin
 *     made by hand this morning with the paid row the SU list has been
 *     claiming since last week.
 *  3. CHUNKED AND RESUMABLE. `nextRowSeq` on the batch is the cursor, so a
 *     600-row file commits across three calls and a call that dies halfway
 *     resumes from where it stopped rather than from the top. Rows already
 *     committed or skipped are `done` and are never looked at twice.
 *  4. EVERY ROW IS INDEPENDENT. One person at the ten-year cap, or one account
 *     deleted between the upload and the commit, skips THAT row with a reason
 *     and the chunk carries on. A commit that threw on one bad line would make
 *     the whole file unimportable.
 *
 * ## The transaction, and where the period's totals move
 *
 * Per person: one transaction over the import row, the membership row and the
 * user document, so the row's state, the membership and the badge cache move
 * together or not at all. The PERIOD's cached totals move ONCE per call
 * instead, in a single update built from the tiers actually written: 200
 * increments on one document would be 200 writes queueing behind each other,
 * and the arithmetic is identical either way.
 *
 * `TIER_COUNTS_AS_MEMBER` and `addPaidMembershipYear` are the grant route's,
 * so alumni writes a row and no badge here too, and the ten-year cap refuses
 * by name rather than silently pushing a year off the end of the cache.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */

/** Rows fetched per addressed read while walking the file. */
const READ_CHUNK = 100;

/**
 * How long a call spends committing before it stops and reports what is left.
 * The commit is resumable, so a slow chunk is a shorter chunk rather than a
 * request that dies with an unknown amount of work done.
 */
const TIME_BUDGET_MS = 45_000;

/** Confirmations accepted in one call. The commit chunk is 200; asking for
 *  more than that in one request is a client that has lost the plot. */
const MAX_CONFIRMED = 500;

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/admin/membership/import/[batchId]/commit">,
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

  const { batchId } = await ctx.params;

  let body: { confirmedRowIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // An empty body is a plain "commit the next chunk", which is the common
    // case, so it is not an error.
    body = {};
  }

  const confirmedRowIds = new Set(
    (Array.isArray(body.confirmedRowIds) ? body.confirmedRowIds : [])
      .filter((id): id is string => typeof id === "string" && /^\d{4,}$/.test(id))
      .slice(0, MAX_CONFIRMED),
  );

  const batchRef = db.collection(MEMBERSHIP_IMPORTS_COLLECTION).doc(batchId);
  const rowsRef = batchRef.collection(MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION);

  try {
    const batchSnap = await batchRef.get();
    if (!batchSnap.exists) {
      return NextResponse.json({ error: "No such import" }, { status: 404 });
    }
    const batch = normalizeMembershipImport(batchSnap.id, batchSnap.data() ?? {});
    if (batch.status === "abandoned") {
      return NextResponse.json(
        { error: "That import was abandoned. Upload the list again." },
        { status: 409 },
      );
    }
    if (batch.status === "writing") {
      // The dry run died between creating the batch and finishing its rows,
      // so `totalRows` is a promise the rows have not kept and the walk would
      // read past the end of the file. Abandon it and upload again.
      return NextResponse.json(
        {
          error:
            "That upload did not finish writing its rows, so it cannot be "
            + "committed. Abandon it and read the file again.",
        },
        { status: 409 },
      );
    }

    const periodRef = db
      .collection(MEMBERSHIP_PERIODS_COLLECTION)
      .doc(batch.periodId);
    const periodSnap = await periodRef.get();
    if (!periodSnap.exists) {
      return NextResponse.json(
        { error: "That membership period is gone, so nothing can be recorded against it." },
        { status: 404 },
      );
    }
    const year = periodSnap.data()?.year;
    if (typeof year !== "string" || year === "") {
      return NextResponse.json(
        { error: "That membership period has no academic year on it." },
        { status: 409 },
      );
    }

    const startedAt = Date.now();
    const committedTiers: MembershipTier[] = [];
    const results: { rowId: string; action: string; reason: string }[] = [];
    const confirmed: { rowId: string; name: string }[] = [];
    let committed = 0;
    let skipped = 0;
    let failed = 0;
    let cursor = batch.nextRowSeq;
    const handled = new Set<string>();

    /** Act on one row, record the outcome, and say which it was. */
    const act = async (rowId: string): Promise<OneRowResult["action"]> => {
      if (handled.has(rowId)) return "done";
      handled.add(rowId);
      const outcome = await commitOneRow({
        db,
        rowRef: rowsRef.doc(rowId),
        rowId,
        periodId: batch.periodId,
        year,
        batchId,
        actorUid: user.uid,
        actorName: user.displayName ?? "",
        confirmedRowIds,
      });
      if (outcome.action === "commit") {
        committed += 1;
        committedTiers.push(outcome.tier);
        if (confirmedRowIds.has(rowId)) confirmed.push({ rowId, name: outcome.name });
        results.push({ rowId, action: "committed", reason: "" });
      } else if (outcome.action === "skip") {
        skipped += 1;
        results.push({ rowId, action: "skipped", reason: outcome.reason });
      } else if (outcome.action === "await-confirm") {
        results.push({ rowId, action: "awaiting-confirm", reason: outcome.reason });
      } else if (outcome.action === "failed") {
        failed += 1;
        results.push({ rowId, action: "failed", reason: outcome.reason });
      } else {
        results.push({ rowId, action: "already-done", reason: "" });
      }
      return outcome.action;
    };

    /** Whether there is room for another person in this call. */
    const roomLeft = () =>
      committed + skipped < MEMBERSHIP_IMPORT_LIMITS.commitChunk
      && Date.now() - startedAt < TIME_BUDGET_MS;

    // PHASE 1: rows the caller has just confirmed. Addressed, and first,
    // because a confirmation for a row the cursor has already passed would
    // otherwise never be acted on. Nothing is counted here: how many rows are
    // still waiting is RECOUNTED from Firestore below rather than accumulated
    // as a delta, because a confirmation on the first press decrements a
    // number that the walk has not incremented yet.
    for (const rowId of [...confirmedRowIds].sort()) {
      await act(rowId);
      if (!roomLeft()) break;
    }

    // PHASE 2: the walk, from the cursor, in file order. The cursor advances
    // only past a row that has been DEALT WITH, so a call that stops early
    // resumes at the right place. A row whose transaction failed stops the
    // chunk WITHOUT advancing the cursor: the next call retries it, rather
    // than the file walking on and leaving one person silently unrecorded.
    let stop = !roomLeft();
    while (!stop && cursor <= batch.totalRows) {
      const ids: string[] = [];
      for (let seq = cursor; seq < cursor + READ_CHUNK && seq <= batch.totalRows; seq += 1) {
        ids.push(membershipImportRowId(seq));
      }
      for (const rowId of ids) {
        const outcome = await act(rowId);
        if (outcome === "failed") {
          stop = true;
          break;
        }
        cursor += 1;
        if (!roomLeft()) {
          stop = true;
          break;
        }
      }
    }

    // The period's cached totals: ONE update per call, built from the tiers
    // actually written. A failure here is logged and does not fail the commit:
    // the memberships are the record and the totals are a cache, and refusing
    // an import because a counter did not move would be the tail wagging the
    // dog.
    //
    // It is REPORTED, though. A cache that silently stopped agreeing with the
    // rows is a console quietly lying about a headcount, so the response says
    // `totalsMoved: false`, the panel says so in words, and the Recount button
    // on the console rebuilds the four numbers from the membership rows.
    let totalsMoved = true;
    const deltas = tierDeltas(committedTiers);
    if (Object.keys(deltas).length > 0) {
      const update: Record<string, FirebaseFirestore.FieldValue> = {};
      for (const [tier, by] of Object.entries(deltas)) {
        update[`totals.${tier}`] = FieldValue.increment(by);
      }
      try {
        await periodRef.update(update);
      } catch (err) {
        console.error("[membership/commit] totals update failed:", batch.periodId, err);
        totalsMoved = false;
      }
    }

    // TWO ADMINS PRESSING AT ONCE is safe but not tidy. Each row's transaction
    // re-reads the row and refuses anything that is not still pending, and the
    // membership is a `create`, so nobody is recorded twice and no total moves
    // twice. The BATCH's own cursor is last-write-wins, so the loser of a race
    // can walk rows the winner already dealt with; every one of them comes back
    // `already-done`, which costs a read and records nothing. `Math.max` keeps
    // the cursor from going backwards within a call.
    const nextRowSeq = Math.max(batch.nextRowSeq, cursor);
    const walked = nextRowSeq > batch.totalRows;

    // HOW MANY NAME ROWS ARE STILL WAITING, counted from the rows themselves.
    //
    // This used to be a running delta: minus one per confirmation acted on,
    // plus one per row the walk found waiting. On the normal first press that
    // subtracts confirmations from a number nothing has added to yet, and the
    // two errors cancel out to zero, so a file with six name matches and three
    // ticked was stamped `committed` with three people still unrecorded and
    // nothing on the console saying so. A count cannot drift the way a delta
    // can, and this one is one aggregate read per call rather than per row.
    const recounted = await countAwaitingConfirm(rowsRef);

    // A count that could not be read is UNKNOWN, not zero. The previous number
    // is kept and the batch stays `committing`, so the worst case is an admin
    // pressing commit once more rather than a file declared finished on a
    // number nobody could check.
    const awaitingConfirm = recounted ?? batch.awaitingConfirm;
    const status = walked && recounted === 0 ? "committed" : "committing";
    const remaining = Math.max(0, batch.totalRows - (nextRowSeq - 1));

    await batchRef.update({
      status,
      nextRowSeq,
      awaitingConfirm,
      committedRows: FieldValue.increment(committed),
      skippedRows: FieldValue.increment(skipped),
      lastCommitAt: FieldValue.serverTimestamp(),
      lastCommitByUid: user.uid,
    });

    return NextResponse.json({
      batchId,
      committed,
      skipped,
      failed,
      remaining,
      awaitingConfirm,
      status,
      /** False when the period's cached tier totals could not be moved. The
       *  memberships are written either way; the console's headcount is the
       *  thing that is now behind, and Recount fixes it. */
      totalsMoved,
      // Who confirmed what, in this call. The durable record is on each row
      // (`confirmedByUid` and `confirmedByName`), which is what makes a name
      // match auditable after the fact rather than only in this response.
      confirmed: confirmed.map((c) => ({ ...c, byName: user.displayName ?? "" })),
      results: results.slice(0, MEMBERSHIP_IMPORT_LIMITS.commitChunk),
    });
  } catch (err) {
    console.error("[membership/commit] failed:", batchId, err);
    return NextResponse.json(
      { error: "Could not commit that import." },
      { status: 500 },
    );
  }
}

/**
 * Name matches on this batch that are still pending, or null if the count
 * could not be read.
 *
 * Two equality filters and an aggregate, so it is one billed read whatever the
 * file's size, and it asks the rows the question directly instead of trusting
 * a counter that a previous call maintained. A row confirmed and committed is
 * `committed`, a row refused is `skipped`; only a name match nobody has
 * answered yet is still `pending`, which is exactly the set an admin has left
 * to work through.
 *
 * Null rather than a throw: the rows this call committed are already written,
 * and losing the summary count is not a reason to report the whole chunk as
 * failed. The caller treats null as "unknown" and refuses to stamp the batch
 * finished on it.
 */
async function countAwaitingConfirm(
  rowsRef: FirebaseFirestore.CollectionReference,
): Promise<number | null> {
  try {
    const agg = await rowsRef
      .where("state", "==", "pending")
      .where("matchKind", "==", "name")
      .count()
      .get();
    const n = agg.data().count;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  } catch (err) {
    console.error("[membership/commit] awaiting-confirm recount failed:", err);
    return null;
  }
}

type OneRowResult =
  | { action: "commit"; tier: MembershipTier; name: string }
  | { action: "skip"; reason: string }
  | { action: "await-confirm"; reason: string }
  | { action: "done" }
  /** The transaction itself failed. The row stays PENDING and the cursor does
   *  not move past it, so the next call retries it. */
  | { action: "failed"; reason: string };

/**
 * One person, in one transaction: the import row, the membership row and the
 * badge cache.
 *
 * The DECISION is made inside the transaction, against the membership row as
 * it is at that instant, because "is there already a membership here" is
 * exactly the question a re-run has to answer correctly. `planCommitRow` is
 * pure and holds the rules; this function holds the writes.
 */
async function commitOneRow({
  db,
  rowRef,
  rowId,
  periodId,
  year,
  batchId,
  actorUid,
  actorName,
  confirmedRowIds,
}: {
  db: FirebaseFirestore.Firestore;
  rowRef: FirebaseFirestore.DocumentReference;
  rowId: string;
  periodId: string;
  year: string;
  batchId: string;
  actorUid: string;
  actorName: string;
  confirmedRowIds: ReadonlySet<string>;
}): Promise<OneRowResult> {
  try {
    return await db.runTransaction(async (tx) => {
      const rowSnap = await tx.get(rowRef);
      if (!rowSnap.exists) return { action: "done" } as OneRowResult;
      const row = normalizeMembershipImportRow(rowSnap.id, rowSnap.data() ?? {});

      const uid = row.matchedUid;
      const membershipRef = uid
        ? db.collection(MEMBERSHIPS_COLLECTION).doc(membershipId(uid, periodId))
        : null;
      const userRef = uid ? db.collection("users").doc(uid) : null;

      const [membershipSnap, userSnap] = await Promise.all([
        membershipRef ? tx.get(membershipRef) : Promise.resolve(null),
        userRef ? tx.get(userRef) : Promise.resolve(null),
      ]);

      const existing =
        membershipSnap && membershipSnap.exists
          ? (() => {
              const m = normalizeMembership(membershipSnap.id, membershipSnap.data() ?? {});
              return { tier: m.tier, source: m.source };
            })()
          : null;

      const decision: CommitDecision = planCommitRow(
        {
          rowId,
          state: row.state,
          matchKind: row.matchKind,
          matchedUid: row.matchedUid,
          tier: isMembershipTier(row.tier) ? row.tier : "paid",
        },
        existing,
        confirmedRowIds,
      );

      if (decision.action === "done" || decision.action === "await-confirm") {
        return decision as OneRowResult;
      }
      if (decision.action === "skip") {
        tx.update(rowRef, { state: "skipped", skipReason: decision.reason });
        return decision as OneRowResult;
      }

      // A commit needs the account to still be there: an import can outlive an
      // account deletion by minutes, and writing a membership for a uid with
      // no user document would leave a row nothing can ever render.
      if (!userSnap || !userSnap.exists || !membershipRef || !userRef) {
        const reason = "That account no longer exists.";
        tx.update(rowRef, { state: "skipped", skipReason: reason });
        return { action: "skip", reason };
      }

      const rawCache = userSnap.data()?.paidMembershipYears;
      const cache = Array.isArray(rawCache)
        ? rawCache.filter((y): y is string => typeof y === "string")
        : [];

      // AN ALUMNI ROW DOES NOT STRIP A YEAR NOTHING ACCOUNTS FOR.
      //
      // Alumni means "not a member this year", so committing one takes the
      // year out of the badge cache. The plan has already refused every row
      // that had a membership for this period, so if the cache still holds
      // this year the entry came from somewhere this import cannot see: a tag
      // set by hand, or a record from before the membership rows existed.
      // Taking it away would erase somebody's badge unattended on the strength
      // of one line in a file, with nothing to reverse it from. Skip it and
      // say why; a human settles it from the Members page.
      if (!TIER_COUNTS_AS_MEMBER[decision.tier] && cache.includes(year)) {
        const reason =
          `Their badge says ${year} with no membership row behind it, so an `
          + "alumni row was not allowed to take it away. Settle it from the "
          + "Members page.";
        tx.update(rowRef, { state: "skipped", skipReason: reason });
        return { action: "skip", reason };
      }

      let years: string[];
      try {
        years = TIER_COUNTS_AS_MEMBER[decision.tier]
          ? addPaidMembershipYear(cache, year, FIELD_LIMITS.maxPaidMembershipYears)
          : removePaidMembershipYear(cache, year);
      } catch (err) {
        if (err instanceof MembershipYearCapError) {
          // ONE row, refused by name, and the chunk carries on. The cap is
          // about that person's document and says nothing about the file.
          tx.update(rowRef, { state: "skipped", skipReason: err.message });
          return { action: "skip", reason: err.message };
        }
        throw err;
      }

      // `create`, never `set`. The plan already refused an existing row, and
      // this is the second half of that refusal: if one appeared between the
      // read and the write, the transaction fails rather than overwriting it.
      tx.create(membershipRef, {
        uid: decision.uid,
        periodId,
        tier: decision.tier,
        source: "su-import",
        matchedOn: decision.matchedOn,
        provenance: {
          at: FieldValue.serverTimestamp(),
          byUid: actorUid,
          batchId,
        },
      });
      // Written only when it CHANGES. An alumni row leaves the cache exactly
      // as it was, and a member who has never been recorded keeps the field
      // ABSENT rather than gaining an empty array, which is the shape
      // `normalizeUser` documents.
      if (years.join("\u0000") !== cache.join("\u0000")) {
        tx.update(userRef, { paidMembershipYears: years });
      }
      tx.update(rowRef, {
        state: "committed",
        skipReason: "",
        committedAt: FieldValue.serverTimestamp(),
        // Stamped only when this row needed confirming, so the record says who
        // vouched for a name match rather than who happened to press commit.
        ...(row.matchKind === "name"
          ? { confirmedByUid: actorUid, confirmedByName: actorName }
          : {}),
      });

      return {
        action: "commit",
        tier: decision.tier,
        name: row.name,
      };
    });
  } catch (err) {
    // A failed transaction leaves the row PENDING and stops the chunk without
    // moving the cursor past it, so the next call retries this exact row. The
    // alternative, counting it as skipped and walking on, would leave one
    // person silently unrecorded in a file that reported itself finished.
    console.error("[membership/commit] row failed:", rowId, err);
    return {
      action: "failed",
      reason: "That row could not be written. Press commit again to retry it.",
    };
  }
}

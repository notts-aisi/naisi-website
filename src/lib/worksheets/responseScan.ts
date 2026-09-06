import "server-only";
import { FieldPath, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  CIRCULATIONS_COLLECTION,
  normalizeResponse,
  RESPONSES_SUBCOLLECTION,
  type ResponseDoc,
} from "@/lib/firestore/circulations";

/**
 * EVERY response on one circulation, read with the Admin SDK.
 *
 * Three routes need exactly this and arrive at it for three different reasons:
 * the aggregate counts one question's answers, the export writes them all to a
 * file, and the close collects the task id each response points at. Written
 * out three times it would be three chances to forget the page cap, and the
 * one that forgot would be an unbounded read on whichever circulation grew.
 *
 * ── PAGED, AND CAPPED RATHER THAN TRUNCATED ─────────────────────────────────
 * The same shape as the membership export's own reader. A circulation adds
 * recipients a hundred at a time and has no ceiling of its own, so this pages
 * rather than reading the subcollection in one go. `MAX_PAGES` is well past
 * any plausible circulation; a bigger one THROWS rather than returning a short
 * list, because a silently partial export is a file somebody makes decisions
 * from and a silently partial close is a set of tasks nobody archives.
 *
 * ── ORDERED BY DOCUMENT ID, WHICH EVERY DOCUMENT HAS ────────────────────────
 * Not by `addedAt`, and not by the stored `uid` field either. `orderBy` on a
 * field DROPS every document missing it (the repo-wide sparse-field trap), and
 * on this subcollection that would silently leave a recipient out of an export
 * and out of a close. The document id is the recipient's uid by construction,
 * so ordering on it is ordering on something that cannot be absent, and it
 * needs no composite index. Callers wanting add-order sort the returned array
 * themselves, in memory, on a list this size.
 *
 * The cursor is the SNAPSHOT rather than an id string: `startAfter` takes a
 * document snapshot whatever the query is ordered by, so the paging cannot
 * come apart from the ordering above it.
 */

/** Responses per page. */
const PAGE = 500;

/** Pages before this gives up. 500 x 40 is twenty thousand recipients. */
const MAX_PAGES = 40;

export async function scanResponses(
  db: Firestore,
  circulationId: string,
): Promise<ResponseDoc[]> {
  const responses = db
    .collection(CIRCULATIONS_COLLECTION)
    .doc(circulationId)
    .collection(RESPONSES_SUBCOLLECTION);

  const out: ResponseDoc[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = responses.orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return out;
    for (const doc of snap.docs) {
      out.push(normalizeResponse(doc.id, doc.data() ?? {}));
    }
    if (snap.size < PAGE) return out;
    cursor = snap.docs[snap.docs.length - 1];
  }
  throw new Error(
    `circulations/${circulationId}/responses did not drain after ${MAX_PAGES} pages`,
  );
}

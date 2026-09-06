import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import { WORKSHEETS_COLLECTION } from "@/lib/firestore/worksheets";
import { isAddressableId } from "@/lib/worksheets/access";
import { deleteWorksheetDocument, worksheetDeleteBlockers } from "@/lib/worksheets/destroy";

/**
 * DELETE a library worksheet: the document, and its question images when no
 * circulation of it is left to show them.
 *
 * ── WHY THIS IS A ROUTE AND NOT A CLIENT DELETE ─────────────────────────────
 * It used to be `deleteDoc` from `worksheetMutations.ts`, which could remove
 * the document and nothing else. Two things were left behind. The question
 * images under `worksheet-images/{worksheetId}/` are written from the browser
 * but can only be REMOVED by the Admin SDK (storage.rules grants no client
 * delete), so every deleted worksheet stranded its pictures in the bucket
 * forever. And a worksheet with a live circulation could be deleted out from
 * under the people answering it, because a rule cannot count the documents in
 * another collection. Both are the events-delete story exactly (`POST
 * /api/events/[id]/delete`, and the orphan scan that prompted it), so this
 * follows that route's shape: the cascade moves server-side and the client
 * `allow delete` on `worksheets` is withdrawn, or a client could still delete
 * the document alone and strand the rest.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 * The author or an admin, which is what the withdrawn rule allowed, so nothing
 * is taken away. Unlike the destroy routes, authorisation cannot run before
 * the existence check: "may you delete this" is a question about the document,
 * and the id is one the caller already had (they were reading the worksheet).
 *
 * ── WHAT REFUSES IT ─────────────────────────────────────────────────────────
 * An OPEN circulation of this worksheet, and only an open one: a closed
 * circulation is its own document with its own copy of the questions, its own
 * responses and its own tasks, and this delete leaves every one of them alone.
 * The 409 names the number, because "close them first" without a count sends
 * the author hunting for the size of the job.
 *
 * ── THE ONE THING A CIRCULATION SHARES WITH ITS WORKSHEET ───────────────────
 * Its copied items point at the WORKSHEET's image folder, so emptying that
 * folder would blank the pictures inside every circulation ever made from this
 * worksheet, closed and archived ones included. It therefore does not: the
 * images are kept whenever any circulation of the worksheet exists, and the
 * response says how many were kept. `deleteWorksheetDocument` carries the
 * argument and the cost (an orphaned folder, which is a scan job, against an
 * unrecoverable hole in a record of what somebody was asked).
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ worksheetId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { worksheetId } = await ctx.params;
  if (!isAddressableId(worksheetId)) {
    return NextResponse.json({ error: "Worksheet not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const snap = await db.collection(WORKSHEETS_COLLECTION).doc(worksheetId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Worksheet not found" }, { status: 404 });
  }
  const worksheet = snap.data() ?? {};

  const isAuthor = worksheet.authorUid === actor.uid;
  if (actor.role !== "admin" && !isAuthor) {
    return NextResponse.json(
      { error: "Only the author or an admin can delete this worksheet." },
      { status: 403 },
    );
  }

  const blockers = await worksheetDeleteBlockers(db, worksheetId);
  if (blockers.length > 0) {
    return NextResponse.json({ error: blockers[0], blockers }, { status: 409 });
  }

  try {
    const result = await deleteWorksheetDocument(db, getAdminStorage() ?? null, worksheetId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[worksheets delete] failed:", worksheetId, err);
    return NextResponse.json(
      { error: "That worksheet could not be deleted. Try again." },
      { status: 500 },
    );
  }
}

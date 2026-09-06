import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import { CIRCULATIONS_COLLECTION } from "@/lib/firestore/circulations";
import { isAddressableId, isCirculationStaff, loadCirculation } from "@/lib/worksheets/access";
import { scanResponses } from "@/lib/worksheets/responseScan";

/**
 * "That's enough": a circulation stops taking answers and its cards come off
 * everybody's board.
 *
 * ── WHY A ROUTE ─────────────────────────────────────────────────────────────
 * `status` is not in the key list `firestore.rules` allows staff to write on a
 * circulation, deliberately: closing is not a field edit, it is a field edit
 * plus one write per recipient's task, and a client that could do the first
 * without the second would leave a worksheet nobody can finish sitting in
 * everybody's To do for the rest of term. The submit route reads `status`
 * transactionally, so the moment this lands, submissions are refused.
 *
 * ── THE ORDER IS TASKS FIRST, THEN THE STATUS, AND IT IS DELIBERATE ─────────
 * Either order has a window. Closing first and failing on the tasks leaves
 * archived-nothing on a closed circulation that this route will never revisit,
 * because the idempotent branch below returns early on a closed one: the cards
 * would have to be archived by hand, one per recipient. Archiving first and
 * failing on the status leaves cards off the board on a circulation that is
 * still open for a few hundred milliseconds, and a retry finishes the job,
 * because archiving an already-archived task writes the same value again. So
 * the recoverable failure is the one chosen. During that window a recipient
 * can still submit, which is the correct behaviour for a circulation that is
 * still open.
 *
 * ── IDEMPOTENT, AND HONEST ABOUT IT ─────────────────────────────────────────
 * A closed circulation answers 200 with `archivedTasks: 0` rather than 409.
 * Two staff pressing Close within a second of each other are agreeing, not
 * conflicting, and an error in front of the second one would say something
 * went wrong when the thing they wanted is exactly what happened. The count is
 * of tasks THIS call moved, so the second caller's zero is the truth about
 * their own request rather than a claim that the circulation had no tasks.
 *
 * ── NOT REVERSIBLE FROM HERE ────────────────────────────────────────────────
 * There is no reopen route in v1 and the button says so. Adding one is a
 * decision about the archived tasks (which recipients' boards they go back to,
 * and in what status), not a matter of flipping the field back, so it is left
 * to whoever needs it rather than half-built here.
 */

/**
 * Task documents read and written per pass. Firestore's own batch ceiling is
 * 500 operations; `mint.ts` works in 200 for two documents per recipient, and
 * this writes one, so 200 is the same conservative budget with room to spare.
 */
const TASK_BATCH = 200;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId } = await ctx.params;
  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }
  if (!isCirculationStaff(circulation, actor)) {
    return NextResponse.json(
      { error: "You can't close this circulation." },
      { status: 403 },
    );
  }

  if (circulation.status === "closed") {
    return NextResponse.json({ ok: true, archivedTasks: 0 });
  }

  let archivedTasks = 0;
  try {
    const responses = await scanResponses(db, circulationId);
    const taskIds = responses
      .map((response) => response.taskId)
      .filter((taskId): taskId is string => Boolean(taskId));

    for (const chunk of chunked(taskIds, TASK_BATCH)) {
      // READ BEFORE WRITE, for two reasons that both end in a failed batch: an
      // admin may have deleted a task (a blind `update` on a missing document
      // fails the WHOLE batch, so one deleted card would stop the close), and
      // a task already archived should not be counted again, or the number
      // reported back would describe the circulation rather than this call.
      const snaps = await db.getAll(...chunk.map((taskId) => db.collection("tasks").doc(taskId)));
      const batch = db.batch();
      let queued = 0;
      for (const snap of snaps) {
        if (!snap.exists) continue;
        if ((snap.data() ?? {}).archived === true) continue;
        batch.update(snap.ref, {
          archived: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        queued += 1;
      }
      if (queued === 0) continue;
      await batch.commit();
      archivedTasks += queued;
    }
  } catch (err) {
    console.error("[worksheets close] archiving tasks failed", circulationId, err);
    return NextResponse.json(
      {
        error:
          "The cards on people's boards could not be archived, so this was left open. Try again.",
      },
      { status: 500 },
    );
  }

  try {
    await db.collection(CIRCULATIONS_COLLECTION).doc(circulationId).update({
      status: "closed",
      closedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[worksheets close] status write failed", circulationId, err);
    return NextResponse.json(
      { error: "This circulation is still open. Try closing it again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, archivedTasks });
}

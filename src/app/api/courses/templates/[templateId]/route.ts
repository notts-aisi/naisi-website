import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { COURSE_TEMPLATES_COLLECTION } from "@/lib/firestore/courseTemplates";

/**
 * Delete one frozen curriculum snapshot: the doc and its `weeks`
 * subcollection.
 *
 * ADMIN ONLY, refused before any read — one indistinguishable 403 for
 * everyone else, so this route cannot be used to probe which snapshots exist.
 *
 * NOT the destroy cascade. A snapshot owns nothing but its own weeks: no
 * member work references it (progress is keyed on RUN ids, never template
 * ids), no counters move, nothing else in the database points at it except a
 * run's `templateId` provenance field — which is deliberately left dangling,
 * exactly as `destroyCourseCascade` leaves template provenance orphaned. What
 * a cohort was given is a fact about that cohort; deleting the snapshot does
 * not un-teach it, and rewriting the run's record to say "no template" would
 * be the falsification. `templateLabel` is stored alongside the id for this
 * reason: the human answer survives the row.
 *
 * So the cascade is a bounded paged delete (≤ 60 week docs by construction —
 * `COURSE_FIELD_LIMITS.maxWeekPlanEntries`) rather than the resumable,
 * audited, budgeted machinery of `courseDeletion.ts`, which exists because a
 * RUN destroy takes member work with it. Nothing here does.
 *
 * ORDER: weeks first, parent doc last. While the parent exists a failed call
 * can be repeated and still find the leftovers; deleting the parent first
 * would strand a subcollection nothing names (a parent-doc delete does NOT
 * delete subcollections in Firestore).
 */

/** Rows per page. One page in practice; the loop is the safety net. */
const PAGE_SIZE = 100;

/**
 * Ceiling on the drain loop. A run caps at 60 weeks, so two pages is already
 * generous; more than this means deletes are not landing, and the honest
 * response is a 500 leaving the parent doc in place rather than a spin (the
 * `courseDeletion` drained-guard lesson, in miniature). The parent surviving
 * is what makes the retry find the leftovers.
 */
const MAX_PAGES = 10;

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ templateId: string }> },
) {
  const { templateId } = await ctx.params;

  // Authorization BEFORE existence.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const ref = db.collection(COURSE_TEMPLATES_COLLECTION).doc(templateId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const weeksCol = ref.collection("weeks");
  let deletedWeeks = 0;
  let prevFirstId: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      return NextResponse.json(
        {
          error:
            "Couldn't finish deleting that snapshot — some of its weeks may remain. Try again.",
        },
        { status: 500 },
      );
    }
    // `select()` with no fields fetches ids only — the content is about to be
    // deleted, there is no reason to read it.
    const pageSnap = await weeksCol.select().limit(PAGE_SIZE).get();
    if (pageSnap.empty) break;

    // The first-doc-id guard: a page that did not shrink after a committed
    // delete means deletes are not taking effect, and looping would burn
    // requests while reporting progress over rows that are still there.
    const firstId = pageSnap.docs[0].id;
    if (firstId === prevFirstId) {
      return NextResponse.json(
        {
          error:
            "Couldn't finish deleting that snapshot — some of its weeks may remain. Try again.",
        },
        { status: 500 },
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const d of pageSnap.docs) batch.delete(d.ref);
    await batch.commit();
    deletedWeeks += pageSnap.size;

    if (pageSnap.size < PAGE_SIZE) break;
  }

  await ref.delete();

  return NextResponse.json({ ok: true, deletedWeeks });
}

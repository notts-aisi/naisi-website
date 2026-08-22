import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentReference } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  COURSE_FIELD_LIMITS,
  normalizeCourseWeek,
  sanitizeWeekPlan,
} from "@/lib/firestore/courses";
import {
  COURSE_TEMPLATES_COLLECTION,
  normalizeCourseTemplate,
  templateWeekFields,
} from "@/lib/firestore/courseTemplates";

/**
 * Apply a frozen snapshot's curriculum INTO a run — the "spawn next year's
 * cohort from Autumn 2026 final" half of v2 decision 2.
 *
 * Admin or `approveCourse`: this is the same authority as
 * `/api/courses/runs/[runId]/clone-weeks`, which does the identical job
 * run-to-run, plus the status lane's bar because applying a template is a
 * decision about what a cohort will be taught.
 *
 * ## The copy is id-preserving. That is the platform invariant.
 *
 * Week doc ids ("w01".."w60") and every `material.id` / `exercise.id` /
 * `checklist.id` inside them are carried across verbatim, through the same
 * `templateWeekFields()` the snapshot was written with. Member progress is
 * keyed on those ids — `courseProgress/{runId}__{uid}__{itemId}` and
 * `courseExerciseResponses/{runId}__{uid}__{weekId}__{exerciseId}` — so a copy
 * that re-minted ids would silently orphan every check-off and submission on
 * a re-run of the same material. Nothing in this file may generate an id.
 *
 * ## `replace` never orphans member work — and the gate is a TRANSACTION
 *
 * A run that already has authored weeks is refused (409) unless the caller
 * asks to `replace`. And `replace` itself is refused the moment ANY
 * `courseProgress` or `courseExerciseResponses` row exists for the run:
 * overwriting a week whose materials people have already ticked off and
 * answered would leave their rows pointing at item ids the curriculum no
 * longer contains — work that is still billed to them, invisible to
 * everyone, and unrecoverable without console archaeology.
 *
 * That refusal is deliberately unconditional rather than a warning with a
 * count. Decision 6's "orphaned rows tolerated" governs a facilitator
 * deleting ONE item they can see the cost of; this route would do it to a
 * whole term in one press. The way to replace a curriculum a cohort has
 * started is to make a new run — which is what templates are for.
 *
 * WHY THE WHOLE THING RUNS IN ONE `runTransaction`. The gate used to be two
 * `count()` aggregations followed, some hundreds of milliseconds later, by an
 * unrelated batch write — a time-of-check/time-of-use hole with a member on
 * the other side of it. `courseProgress` is a DIRECT CLIENT WRITE (rules let
 * an actively enrolled member write their own rows), so a member ticking a
 * checklist item inside that window was orphaned the instant after the gate
 * said nothing existed. Firestore's server-side transactions are
 * serialisable and `tx.get(aggregateQuery)` takes a pessimistic lock on the
 * documents its query matches, so the counts and the week writes now commit
 * as one unit: a racing `courseProgress` create either serialises BEFORE the
 * transaction, where the re-check counts it and the whole apply is refused,
 * or AFTER the commit, where the row it creates is keyed on the new
 * curriculum's ids and there is nothing to orphan. There is no third
 * ordering left for it to land in.
 *
 * The existing-weeks read is inside the same transaction for the same reason
 * one step out: two admins pressing Copy at the same instant would otherwise
 * both read an empty (or matching) run and both write, interleaving two
 * curricula into one set of week documents. Serialising them costs nothing
 * here — it is the read this route was already doing, moved inside.
 *
 * The SNAPSHOT is read OUTSIDE the transaction on purpose. `courseTemplates`
 * is append-only by construction (rules deny every client write to a template
 * and its weeks, and no route updates one after the save batch), so there is
 * no writer to serialise against and nothing a lock on it would buy — while
 * putting ~60 immutable documents in the read set would make every apply
 * retry on contention it cannot actually have.
 *
 * ## WHAT THE GATE DOES NOT PROTECT — the honest scope
 *
 * The gate protects THIS PRESS. It is not a guarantee that member work on
 * this run can never be orphaned, and it must not be read as one: the check
 * and the copy are atomic with respect to each other, and that is the whole
 * of the claim.
 *
 * The remaining door is the WEEK EDITOR. Deleting a run's weeks by hand there
 * is not gated on member work at all — no warning exists on that path yet —
 * so an admin can empty the run in one surface and then apply a snapshot onto
 * the now-empty run here, which this route accepts because by then there
 * genuinely are no weeks in the way. The progress rows the deleted weeks left
 * behind are orphaned by the FIRST press, not the second; this route is not
 * where that is fixed. V2-3 decision 6 owns the closure — the week editor's
 * own deletion warning, at the surface where the deletion actually happens —
 * and until it lands the honest statement of this route's guarantee is the
 * one above.
 *
 * ## Provenance
 *
 * The run is stamped with `templateId` + `templateLabel` (decision 3), in the
 * SAME transaction as the weeks: the stamp and the content it describes are
 * now atomic, so there is no window where a run claims a provenance whose
 * weeks did not land. Both fields are pinned in `firestore.rules` against
 * every non-admin writer, so the people who edit the curriculum all term
 * cannot rewrite the record of which version they started from.
 * `templateLabel` is a point-in-time copy so the answer survives the snapshot
 * being relabelled or deleted.
 */

/**
 * Ceiling on the documents one apply may write. Firestore's hard limit on a
 * transaction is 500 writes, and this whole operation is now ONE transaction
 * — there is no chunking to fall back on, so an apply that would exceed the
 * limit has to be refused with a sentence rather than fail as a raw 500 half
 * way through. A run holds at most 60 weeks
 * (`COURSE_FIELD_LIMITS.maxWeekPlanEntries`), so the real bound is ~121
 * writes (60 sets + 60 stale deletes + the run doc) and this is unreachable
 * in practice; it exists for the hand-made snapshot that is not.
 */
const MAX_APPLY_WRITES = 400;

type WeekWrite = { ref: DocumentReference; data: Record<string, unknown> };

/**
 * Thrown out of the write transaction to abort it with a specific response.
 * A `Response` cannot be returned from inside the callback — it would abort
 * nothing and be swallowed as the transaction's result — so the refusal
 * travels as a typed sentinel and is mapped back in the catch. (The
 * `SubmitError` shape from the exercise-submit route, and the same lane
 * `DestroyPassInFlightError` uses: a refusal is a decision, not a failure,
 * and its sentence has to reach the operator intact.)
 */
class ApplyRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Extra keys merged into the JSON body — counts the client renders. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApplyRefusedError";
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  // Authorization BEFORE existence: the tier is role/permission-only, so the
  // single 403 lands before this route reads anything at all.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveCourse)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { templateId?: unknown; replace?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  if (!templateId) {
    return NextResponse.json({ error: "Choose a saved version." }, { status: 400 });
  }
  const replace = body.replace === true;

  const runRef = db.collection("courseRuns").doc(runId);
  const templateRef = db.collection(COURSE_TEMPLATES_COLLECTION).doc(templateId);
  const [runSnap, templateSnap] = await Promise.all([runRef.get(), templateRef.get()]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (!templateSnap.exists) {
    return NextResponse.json(
      { error: "That saved version no longer exists." },
      { status: 404 },
    );
  }
  const runRaw = runSnap.data() ?? {};
  const template = normalizeCourseTemplate(templateSnap.id, templateSnap.data() ?? {});

  // A run mid-destroy is frozen: writing a curriculum into a cohort that is
  // being deleted would race the cascade's own week drain. Read outside the
  // transaction deliberately — the marker is written by an admin action, not
  // by a member, so this is the accepted admin-vs-admin TOCTOU the destroy
  // engine documents, not the member race the transaction below closes.
  if (runRaw.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and can't be edited." },
      { status: 409 },
    );
  }

  // Same-course only. A snapshot names the curriculum of ONE course; applying
  // "AI Governance, Autumn 2026" into a Technical AISF run would leave a
  // cohort's public catalogue entry and its actual content describing two
  // different programmes.
  const courseId = typeof runRaw.courseId === "string" ? runRaw.courseId : "";
  if (!courseId || courseId !== template.courseId) {
    return NextResponse.json(
      { error: "That saved version belongs to a different course." },
      { status: 400 },
    );
  }

  // The snapshot's weeks, read once and outside the transaction — see the
  // module comment's append-only note for why locking them would buy nothing.
  const sourceWeeks = await templateRef.collection("weeks").get();
  if (sourceWeeks.empty) {
    return NextResponse.json(
      { error: "That saved version has no weeks in it." },
      { status: 400 },
    );
  }

  /**
   * The TARGET run's plan decides what number a copied week carries — the
   * same `w03` can be week 3 in a run with no breaks and week 3 of a
   * differently shaped plan elsewhere, and the number the cohort sees must
   * match the plan they are paced by. Falls back to the snapshot's own number
   * when the target plan has no slot for that id yet (apply-first,
   * plan-later is a normal order to work in). Lifted verbatim from
   * clone-weeks: the two copy paths must agree.
   */
  const planNumbers = new Map<string, number>();
  for (const entry of sanitizeWeekPlan(runRaw.weekPlan)) {
    if (entry.kind === "week") planNumbers.set(entry.weekId, entry.weekNumber);
  }

  const targetWeeks = runRef.collection("weeks");
  // Built once, outside the transaction: the payloads depend only on the
  // snapshot and the run's plan, both already read, and a transaction
  // callback can re-run on contention — rebuilding 60 week bodies per retry
  // would be waste.
  const pending: WeekWrite[] = [];
  const incomingIds = new Set<string>();
  for (const docSnap of sourceWeeks.docs) {
    const week = normalizeCourseWeek(docSnap.id, docSnap.data() ?? {});
    incomingIds.add(docSnap.id);
    const rawNumber = planNumbers.get(docSnap.id) ?? week.weekNumber;
    const weekNumber = Math.min(
      COURSE_FIELD_LIMITS.maxWeekPlanEntries,
      Math.max(1, Math.floor(rawNumber) || 1),
    );
    pending.push({
      // The SNAPSHOT's doc id, never `weekDocId(weekNumber)` — the
      // id-preserving half of the invariant (see the module comment).
      ref: targetWeeks.doc(docSnap.id),
      data: {
        ...templateWeekFields(week),
        weekNumber,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
      },
    });
  }

  let outcome: { created: number; replaced: number; removedIds: string[] };
  try {
    outcome = await db.runTransaction(async (tx) => {
      // ---- READS. Every one of them, before the first write. --------------

      // `select()` with no fields fetches ids only — an existence check, not a
      // read of content we may be about to replace.
      const existing = await tx.get(targetWeeks.select());

      if (!existing.empty && !replace) {
        throw new ApplyRefusedError(
          `This run already has ${existing.size} week${existing.size === 1 ? "" : "s"} of content. Replacing it will overwrite what's there.`,
          409,
          { needsReplace: true, existingWeeks: existing.size },
        );
      }

      if (!existing.empty && replace) {
        // THE NEVER-ORPHAN GATE. Both collections, counted live INSIDE the
        // transaction — a member who ticked one box counts exactly as much as
        // a cohort that finished the term, because the failure mode is the
        // same: rows keyed on item ids the new curriculum does not contain.
        // Count aggregations, not document reads: this is a yes/no question
        // with a number attached for the copy. `runId` alone is served by the
        // automatic single-field index.
        //
        // `tx.get()` on an aggregate query holds a pessimistic lock on what
        // the underlying query matches, which is what makes this a gate
        // rather than an observation — see the module comment.
        const [progressAgg, responseAgg] = await Promise.all([
          tx.get(db.collection("courseProgress").where("runId", "==", runId).count()),
          tx.get(
            db.collection("courseExerciseResponses").where("runId", "==", runId).count(),
          ),
        ]);
        const progressCount = progressAgg.data().count;
        const responseCount = responseAgg.data().count;
        if (progressCount > 0 || responseCount > 0) {
          const parts: string[] = [];
          if (progressCount > 0) {
            parts.push(`${progressCount} progress row${progressCount === 1 ? "" : "s"}`);
          }
          if (responseCount > 0) {
            parts.push(`${responseCount} exercise answer${responseCount === 1 ? "" : "s"}`);
          }
          throw new ApplyRefusedError(
            `Members have already recorded work on this run (${parts.join(" and ")}). Replacing its weeks would orphan that work — start a new run from this version instead.`,
            409,
            { memberWork: { progress: progressCount, exerciseResponses: responseCount } },
          );
        }
      }

      /**
       * On replace, week docs the snapshot has no counterpart for are
       * REMOVED. "Replace" has to mean the run now IS this version — a run
       * left holding w09 and w10 from a longer previous curriculum is a third
       * thing that matches neither the snapshot nor what anyone chose. Safe
       * by construction: the never-orphan gate above has already proved, in
       * this same transaction, that no member work exists on this run, so
       * there is nothing for a removed week to strand.
       */
      const stale: DocumentReference[] = replace
        ? existing.docs.filter((d) => !incomingIds.has(d.id)).map((d) => d.ref)
        : [];

      // The run doc's provenance stamp is the +1.
      if (pending.length + stale.length + 1 > MAX_APPLY_WRITES) {
        throw new ApplyRefusedError(
          "That saved version has too many weeks to apply in one go. Trim the snapshot, or copy it into a run in smaller pieces.",
          400,
          { weeks: pending.length, removing: stale.length },
        );
      }

      // ---- WRITES. Nothing above this line may follow one. ----------------

      for (const write of pending) {
        // `set` (not `update`): most targets don't exist yet, and a replace
        // must swap the week wholesale rather than merge two curricula.
        tx.set(write.ref, write.data);
      }
      for (const ref of stale) {
        tx.delete(ref);
      }

      // Provenance travels WITH the weeks now rather than after them: the
      // stamp is true the instant it is visible. Strings, never null —
      // firestore.rules pins these with a `''` default and a stored null would
      // compare unequal to it, wedging every legitimate non-admin run edit
      // thereafter (see CourseRunDoc).
      tx.update(runRef, {
        templateId: template.id,
        templateLabel: template.label,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const existingIds = new Set(existing.docs.map((d) => d.id));
      return {
        created: pending.length,
        replaced: pending.filter((w) => existingIds.has(w.ref.id)).length,
        removedIds: stale.map((ref) => ref.id),
      };
    });
  } catch (err) {
    if (err instanceof ApplyRefusedError) {
      return NextResponse.json(
        { error: err.message, ...err.detail },
        { status: err.status },
      );
    }
    console.error("[courses apply-template] transaction failed", runId, templateId, err);
    return NextResponse.json(
      { error: "That copy didn't go through — nothing was changed." },
      { status: 500 },
    );
  }

  // Three numbers and the names behind one of them, because they are
  // different things to the admin reading the receipt: how much curriculum is
  // now on the run, how much of it landed on top of a week that was already
  // there, and how much of the run's previous shape went away. `created` is
  // the total written (the phrasing clone-weeks already uses), `replaced` a
  // subset of it. `removedIds` exists because "removed 2" is the one figure
  // an admin cannot reconstruct from the screen they are looking at — the
  // weeks it names are gone by the time they read it.
  return NextResponse.json({
    ok: true,
    created: outcome.created,
    replaced: outcome.replaced,
    removed: outcome.removedIds.length,
    removedIds: outcome.removedIds,
    templateId: template.id,
    templateLabel: template.label,
  });
}

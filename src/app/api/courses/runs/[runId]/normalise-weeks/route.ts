import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  normalizeCourseWeek,
  sanitizeWeekPlan,
  weekDocId,
  type WeekPlanEntry,
} from "@/lib/firestore/courses";

/**
 * Re-address a DRAFT run's weeks so the plan's `weekId` and the doc id every
 * member-facing surface derives (`weekDocId(weekNumber)`) are the same string
 * again.
 *
 * WHY THIS EXISTS. `WeekPlanBuilder.renumber()` renumbers positionally and
 * deliberately preserves `weekId`, so moving a slot leaves the plan saying
 * "slot 2 is week 2, document w05" while every reader of that cohort opens
 * `weekDocId(2)` = `w02`. Admin surfaces follow the plan, members follow the
 * number, and the two quietly disagree from the first press of the up arrow.
 *
 * WHY AT THE DRAFT BOUNDARY. The preserved id is not a mistake: once a cohort
 * is live it is what keeps authored curriculum and everyone's saved work
 * attached to the same slot across a renumber, and repointing it would move
 * real progress under real people. In DRAFT none of that exists yet, so the
 * two spellings can be reconciled for free. That is the whole design of this
 * route: it is not a general repair tool, it is the one window where the
 * repair is free, and it refuses to run outside it.
 *
 * The companion half is `weekPlanLockRespected()` in firestore.rules, which
 * pins `weekPlan` for non-admins once a run leaves draft, so a plan that
 * leaves this window canonical stays canonical unless an admin deliberately
 * reshapes it.
 *
 * REFUSALS, all 409 with a sentence the admin can act on:
 *  - the run is not a draft;
 *  - any `courseProgress` or `courseExerciseResponses` row exists for the run
 *    (belt and braces: in draft there should be none, and if there are, the
 *    "moving repoints nothing" premise is false);
 *  - a group of this run has forked weeks or per-week session overrides, both
 *    of which are keyed by week doc id and would strand;
 *  - a week document exists that the plan does not reference and it sits on an
 *    id the move needs, which would clobber authored content.
 */

/** One week doc that has to change address. */
type Move = { from: string; to: string; weekNumber: number; hasDoc: boolean };

/** What the plan and the docs would become. Shared by the preview and the write. */
type Normalisation = {
  plan: WeekPlanEntry[];
  moves: Move[];
  /** Docs already at the right id whose stored `weekNumber` field has drifted. */
  restamps: { weekId: string; from: number; to: number }[];
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveCourse)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // `dryRun` is how the builder previews the moves without asking the admin to
  // trust a client-side reimplementation of this maths. Optional, and a body
  // that isn't JSON at all is simply a live run.
  let dryRun = false;
  try {
    const body = (await req.json()) as { dryRun?: unknown };
    dryRun = body?.dryRun === true;
  } catch {
    dryRun = false;
  }

  const runRef = db.collection("courseRuns").doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = runSnap.data() ?? {};

  if (run.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and its weeks can't be moved." },
      { status: 409 },
    );
  }

  if ((run.status ?? "draft") !== "draft") {
    return NextResponse.json(
      {
        error:
          "Week ids can only be normalised while a run is a draft. Once a cohort is live, moving a week would repoint their saved work.",
      },
      { status: 409 },
    );
  }

  const plan = sanitizeWeekPlan(run.weekPlan);

  // ---- What needs to change ----

  const weeksCol = runRef.collection("weeks");
  const weekDocs = await weeksCol.get();
  const stored = new Map(
    weekDocs.docs.map((d) => [d.id, normalizeCourseWeek(d.id, d.data() ?? {})]),
  );

  const next: WeekPlanEntry[] = [];
  const moves: Move[] = [];
  const restamps: Normalisation["restamps"] = [];
  let taught = 0;
  for (const entry of plan) {
    if (entry.kind !== "week") {
      next.push(entry);
      continue;
    }
    taught += 1;
    const to = weekDocId(taught);
    next.push({ kind: "week", weekNumber: taught, weekId: to });
    if (entry.weekId !== to) {
      moves.push({
        from: entry.weekId,
        to,
        weekNumber: taught,
        hasDoc: stored.has(entry.weekId),
      });
    } else {
      const doc = stored.get(to);
      if (doc && doc.weekNumber !== taught) {
        restamps.push({ weekId: to, from: doc.weekNumber, to: taught });
      }
    }
  }

  if (moves.length === 0 && restamps.length === 0) {
    return NextResponse.json({ ok: true, moves: [], restamps: [], changed: 0 });
  }

  // ---- Refusals ----

  // The premise. `limit(1)` because the question is "any", not "how many": a
  // single row is enough to mean this run is not the empty draft it claims.
  const [progress, responses] = await Promise.all([
    db.collection("courseProgress").where("runId", "==", runId).limit(1).get(),
    db
      .collection("courseExerciseResponses")
      .where("runId", "==", runId)
      .limit(1)
      .get(),
  ]);
  if (!progress.empty || !responses.empty) {
    return NextResponse.json(
      {
        error:
          "This draft already has member progress or exercise answers against it, so its weeks can't be re-addressed. Sort the stray rows first.",
      },
      { status: 409 },
    );
  }

  // Group-level content is keyed by week doc id too (`courseGroups/{id}/weeks`
  // and the `sessionOverrides` map), and neither is this route's to rewrite.
  const groups = await db.collection("courseGroups").where("runId", "==", runId).get();
  for (const group of groups.docs) {
    const overrides = group.get("sessionOverrides");
    if (overrides && typeof overrides === "object" && Object.keys(overrides).length > 0) {
      return NextResponse.json(
        {
          error: `Group "${group.get("name") ?? group.id}" has per-week session overrides, which are keyed by week id. Clear them before normalising.`,
        },
        { status: 409 },
      );
    }
    const forked = await group.ref.collection("weeks").limit(1).get();
    if (!forked.empty) {
      return NextResponse.json(
        {
          error: `Group "${group.get("name") ?? group.id}" has its own copy of a week, which is keyed by week id. Remove the group copy before normalising.`,
        },
        { status: 409 },
      );
    }
  }

  // A document the plan never mentions, parked on an id a move is about to
  // take. Overwriting it would silently destroy authored content, so this is a
  // refusal rather than a decision the route makes on the admin's behalf.
  const planIds = new Set(
    plan.flatMap((e) => (e.kind === "week" ? [e.weekId] : [])),
  );
  const collision = moves.find((m) => stored.has(m.to) && !planIds.has(m.to));
  if (collision) {
    return NextResponse.json(
      {
        error: `A week document "${collision.to}" exists that this plan doesn't use, and week ${collision.weekNumber} needs that id. Delete or re-add it first.`,
      },
      { status: 409 },
    );
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      moves,
      restamps,
      changed: moves.length + restamps.length,
    });
  }

  // ---- The write ----
  //
  // Copy then delete, in ONE batch, because the moves are a permutation: `w05`
  // becoming `w02` while `w02` becomes `w03` means a source id is very often
  // also a destination id. Writing every destination first and only then
  // deleting the sources that no destination claimed is the ordering that
  // survives that without a temporary id. At 60 slots the worst case is 121
  // operations, comfortably inside the 500-op batch limit.
  //
  // The skip set is built ONLY from the moves that actually write. A move whose
  // source has no document copies nothing, so its destination holds no fresh
  // content and is not a reason to keep the old doc alive. Counting those as
  // destinations is how "w05 -> w01" (plan-only) protected the real w01 from
  // deletion after w01 -> w02 had already copied it, leaving the same week
  // authored at two addresses.
  const batch = db.batch();
  const written = new Set(moves.filter((m) => m.hasDoc).map((m) => m.to));

  for (const move of moves) {
    const doc = stored.get(move.from);
    if (!doc) continue;
    batch.set(weeksCol.doc(move.to), {
      weekNumber: move.weekNumber,
      title: doc.title,
      summary: doc.summary,
      guideBlocks: doc.guideBlocks,
      materials: doc.materials,
      exercises: doc.exercises,
      checklist: doc.checklist,
      estimatedMinutes: doc.estimatedMinutes,
      published: doc.published,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
    });
  }
  for (const move of moves) {
    if (!move.hasDoc) continue;
    if (written.has(move.from)) continue;
    batch.delete(weeksCol.doc(move.from));
  }
  for (const restamp of restamps) {
    batch.update(weeksCol.doc(restamp.weekId), {
      weekNumber: restamp.to,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
    });
  }

  batch.update(runRef, {
    weekPlan: next,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return NextResponse.json({
    ok: true,
    moves,
    restamps,
    changed: moves.length + restamps.length,
  });
}

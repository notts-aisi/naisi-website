import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseWeek } from "@/lib/firestore/courses";
import { asUidList } from "@/lib/firestore/events";
import {
  COURSE_TEMPLATES_COLLECTION,
  RETRO_PROGRESS_LIMIT,
  TEMPLATE_LIMITS,
  aggregateRetrospective,
  courseTemplateId,
  normalizeCourseTemplate,
  summarizeRetrospective,
  templateRowOrder,
  templateWeekFields,
  toTemplateRow,
  type CourseTemplateRow,
  type RetroProgressRow,
} from "@/lib/firestore/courseTemplates";

/**
 * `courseTemplates` for ONE course — the save half (POST) and the picker half
 * (GET) of v2 decision 2.
 *
 * ## POST — freeze a finished cohort's curriculum
 *
 * ADMIN ONLY. A snapshot is the record of what a cohort was actually taught,
 * and it is the thing future runs are minted from; that is a step above the
 * `approveCourse` content lane, which is why the gate here is the governance
 * role rather than a permission. The refusal is a single indistinguishable
 * 403 issued BEFORE any read, so a non-admin cannot use this route to learn
 * whether a course or a run exists.
 *
 * The copy is ID-PRESERVING — week doc ids and every material / exercise /
 * checklist id inside them ride across untouched, through the one shared
 * `templateWeekFields()`. See `courseTemplates.ts` for why an id-minting copy
 * would orphan every check-off the next time the material was taught, and
 * `clone-weeks/route.ts` for the precedent this mirrors.
 *
 * The snapshot also freezes its RETROSPECTIVE evidence (decision 3):
 * cohort size and how many materials carried a rating, computed from the same
 * aggregation the retrospective view renders, so the two can never disagree.
 *
 * APPEND-ONLY. Every POST mints a fresh id (`courseTemplateId`), so saving
 * twice under one label produces two rows rather than overwriting the origin.
 * Nothing in this file updates an existing snapshot, and no route anywhere
 * writes `courseTemplates/{id}/weeks` after this batch: template weeks are
 * IMMUTABLE (rules deny every client write; the rules suite pins it).
 *
 * ## GET — the nested picker's list
 *
 * Admin / `draftCourse` / `approveCourse` / a track lead OF THIS COURSE.
 * Drafters and leads need to BROWSE versions to pick one, so the read tier is
 * wider than the save tier. Nothing in a snapshot is PII — no member ids, no
 * addresses, no per-member anything — so the row goes out whole.
 *
 * The lead branch is scoped to `courseId` because `firestore.rules` scopes
 * the client's own template read to the SOURCE RUN's leads, and a route that
 * admitted "lead of any run anywhere" would be the one surface where leading
 * one delivery opened every other course's snapshots. Course-level is
 * deliberately coarser than the per-template check in rules: this is a LIST,
 * and resolving each row against its own source run would be a get() per row
 * to narrow an answer that is already the same for every row of one course.
 */

/** Writes per batch. Firestore's hard limit is 500; a run holds ≤ 60 weeks. */
const MAX_DOCS_PER_BATCH = 300;

/** Cost ceiling on one course's version list. Five families, a few each. */
const MAX_TEMPLATES_LISTED = 200;

/**
 * Cost ceiling on the track-lead check's field-masked scan of THIS course's
 * runs (see the GET handler). A course gets one or two runs a year, so this
 * is decades of deliveries; the bound exists so a bugged or hand-made data
 * set cannot turn one 403 decision into an unbounded read. A lead whose run
 * fell past the bound reads as not-a-lead, which is the safe direction for a
 * permission check to fail in.
 */
const MAX_RUNS_SCANNED = 100;

/**
 * Display-name fallback chain: what the member asked to be called, then their
 * account name, then a neutral placeholder — NEVER an email address.
 *
 * (Duplicated from the applications route on purpose: route handlers don't
 * import from one another, and the plan's integration checklist already
 * carries "extract shared displayNameOf()" as its own cleanup.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

// ---------------------------------------------------------------------------
// POST — save a snapshot
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await ctx.params;

  // Authorization BEFORE existence: one 403 for every non-admin, whatever the
  // course id names.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { label?: unknown; sourceRunId?: unknown; sourceGroupId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "Give this version a label." }, { status: 400 });
  }
  if (label.length > TEMPLATE_LIMITS.label) {
    return NextResponse.json(
      { error: `Labels are limited to ${TEMPLATE_LIMITS.label} characters.` },
      { status: 400 },
    );
  }

  const sourceRunId =
    typeof body.sourceRunId === "string" ? body.sourceRunId.trim() : "";
  if (!sourceRunId) {
    return NextResponse.json(
      { error: "Choose the run to snapshot." },
      { status: 400 },
    );
  }

  // `sourceGroupId` is in the contract from day one so V2-2 and V2-3 snapshots
  // are the same document type (see the field comment in courseTemplates.ts).
  // Until per-group curriculum exists there is nothing to snapshot but the run
  // canonical, so a caller naming a group is REFUSED rather than quietly given
  // the canonical copy under a `sourceGroupId: null` that says it asked for no
  // such thing. Absent or explicit null is the supported call today.
  if (body.sourceGroupId !== undefined && body.sourceGroupId !== null) {
    return NextResponse.json(
      {
        error:
          "Per-group snapshots aren't available yet — this saves the run's canonical curriculum.",
      },
      { status: 400 },
    );
  }

  const [courseSnap, runSnap] = await Promise.all([
    db.collection("courses").doc(courseId).get(),
    db.collection("courseRuns").doc(sourceRunId).get(),
  ]);
  if (!courseSnap.exists) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const course = courseSnap.data() ?? {};
  const run = runSnap.data() ?? {};
  if (run.courseId !== courseId) {
    return NextResponse.json(
      { error: "That run belongs to a different course." },
      { status: 400 },
    );
  }

  const weekSnap = await db
    .collection("courseRuns")
    .doc(sourceRunId)
    .collection("weeks")
    .get();
  if (weekSnap.empty) {
    return NextResponse.json(
      { error: "That run has no weeks to snapshot yet." },
      { status: 400 },
    );
  }
  // Normalising on the way through caps every array at the authored limits and
  // drops anything stale — and, critically, preserves the ids INSIDE
  // materials / exercises / checklist items (see the module comment).
  const weeks = weekSnap.docs.map((d) => normalizeCourseWeek(d.id, d.data() ?? {}));

  // ---- Retrospective evidence, from the same aggregation the read view uses.
  // One progress query for the run (field-masked — nothing else on a progress
  // row belongs near a snapshot, `privateNote` least of all) plus one count
  // aggregation. `runId` alone is served by the automatic single-field index;
  // (runId, status) is served by index merging. No composite was added.
  const [progressSnap, enrolledAgg] = await Promise.all([
    db
      .collection("courseProgress")
      .where("runId", "==", sourceRunId)
      .select("itemId", "rating", "completed")
      .limit(RETRO_PROGRESS_LIMIT)
      .get(),
    db
      .collection("courseEnrolments")
      .where("runId", "==", sourceRunId)
      .where("status", "==", "active")
      .count()
      .get(),
  ]);
  const progress: RetroProgressRow[] = progressSnap.docs.map((d) => {
    const raw = d.data() ?? {};
    return {
      itemId: typeof raw.itemId === "string" ? raw.itemId : "",
      rating: typeof raw.rating === "number" ? raw.rating : null,
      completed: raw.completed === true,
    };
  });
  const memberCount = enrolledAgg.data().count;
  const retrospective = summarizeRetrospective(
    // Notes are not needed for the three scalars a snapshot freezes, so the
    // save path skips that query entirely.
    aggregateRetrospective({ weeks, progress, notes: [], enrolledCount: memberCount }),
    typeof run.label === "string" ? run.label : "",
    memberCount,
  );

  // ---- Write the snapshot.
  const courseTitle = typeof course.title === "string" ? course.title : "";
  const templateId = courseTemplateId(courseTitle, label);
  const templateRef = db.collection(COURSE_TEMPLATES_COLLECTION).doc(templateId);

  const actorSnap = await db.collection("users").doc(actor.uid).get();
  const savedByName = displayNameOf(actorSnap.data() ?? {});

  const firstBatch = db.batch();
  firstBatch.create(templateRef, {
    courseId,
    courseTitle,
    label,
    sourceRunId,
    // Always null today — see the refusal above.
    sourceGroupId: null,
    savedAt: FieldValue.serverTimestamp(),
    savedByUid: actor.uid,
    savedByName,
    weekCount: weeks.length,
    retrospective,
  });

  // `create` (not `set`) throughout: a fresh random suffix per save means a
  // collision is a bug, and the honest response to a bug is a 500, not a
  // silent overwrite of somebody else's frozen snapshot.
  const weekWrites = weeks.map((week) => ({
    // THE DOC ID COMES FROM THE SOURCE DOC, never from `weekDocId(weekNumber)`
    // — `normalizeCourseWeek` carries `snap.id` through as `week.id`, and that
    // is the id-preserving half of the invariant.
    ref: templateRef.collection("weeks").doc(week.id),
    data: templateWeekFields(week),
  }));

  for (const write of weekWrites.slice(0, MAX_DOCS_PER_BATCH - 1)) {
    firstBatch.create(write.ref, write.data);
  }
  await firstBatch.commit();

  for (
    let i = MAX_DOCS_PER_BATCH - 1;
    i < weekWrites.length;
    i += MAX_DOCS_PER_BATCH
  ) {
    const batch = db.batch();
    for (const write of weekWrites.slice(i, i + MAX_DOCS_PER_BATCH)) {
      batch.create(write.ref, write.data);
    }
    await batch.commit();
  }

  return NextResponse.json({ ok: true, templateId });
}

// ---------------------------------------------------------------------------
// GET — list this course's snapshots
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // Authorization before existence, again: the course is never read, so a
  // refusal cannot leak whether it exists.
  const staff =
    actor.role === "admin" ||
    actor.permissions.draftCourse ||
    actor.permissions.approveCourse;
  if (!staff) {
    // Track leads browse versions when they take a run over — but a lead of
    // THIS course's runs, not of any run anywhere.
    //
    // This used to be a bare `trackLeadUids array-contains actor` with NO
    // courseId filter, on the reasoning that the read tier is staff-wide and
    // a snapshot carries no PII. That is an argument for the tier, not for
    // the scope: `firestore.rules` deliberately resolves the client's own
    // template read against the SOURCE RUN's leads, so the route was the one
    // surface where leading a single run of one course opened every other
    // course's snapshots. A route and its rules disagreeing about who may
    // read something is a bug even when the wider answer is defensible.
    //
    // ⚠ WHY THIS IS A SCAN AND NOT A TWO-FILTER QUERY. Pairing
    // `array-contains` with an equality filter is exactly the combination
    // this codebase has already decided not to rely on: the material-notes
    // route says so in as many words, and whether Firestore's index merging
    // serves it or demands a composite index is not something to leave to
    // luck in a permission check — a missing index fails the query, and a
    // failed query here is a 500 in front of a legitimate lead. So the
    // EQUALITY goes in the query (`courseId`, automatic single-field index,
    // no composite) and the array membership is answered in memory over a
    // field-masked page. One course's runs is a handful of documents; the
    // mask means each is a few bytes.
    const leadCandidates = await db
      .collection("courseRuns")
      .where("courseId", "==", courseId)
      .select("trackLeadUids")
      .limit(MAX_RUNS_SCANNED)
      .get();
    const isLead = leadCandidates.docs.some((d) =>
      asUidList((d.data() ?? {}).trackLeadUids).includes(actor.uid),
    );
    if (!isLead) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // No `orderBy`: `savedAt` is a serverTimestamp on every row this route
  // writes, but the house rule is not to order on a field a legacy or
  // hand-made row could be missing (Firestore drops those docs entirely).
  // Sorted in memory below.
  const snap = await db
    .collection(COURSE_TEMPLATES_COLLECTION)
    .where("courseId", "==", courseId)
    .limit(MAX_TEMPLATES_LISTED)
    .get();

  // A missing course is NOT a 404 here. Snapshots deliberately outlive their
  // course (`destroyCourseCascade` leaves template provenance orphaned rather
  // than deleting frozen history), so listing by `courseId` is the honest
  // read even when nothing answers to that id any more.
  const templates: CourseTemplateRow[] = snap.docs
    .map((d) => toTemplateRow(normalizeCourseTemplate(d.id, d.data() ?? {})))
    .sort(templateRowOrder);

  return NextResponse.json({ templates });
}

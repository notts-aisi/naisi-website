import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  addDaysToKey,
  currentWeekFor,
  isValidDateKey,
  londonWallClockToInstant,
} from "@/lib/courses/weekPlan";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { buildMirroredTask, courseTaskId } from "@/lib/firestore/courseTasks";
import {
  normalizeCourseRun,
  normalizeCourseWeek,
  weekDocId,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import { TASK_FIELD_LIMITS } from "@/lib/firestore/tasks";

/**
 * Lazy task mirroring — projecting the cohort's CURRENT week into the caller's
 * own My Work board as a `tasks/{id}` doc.
 *
 * ── ONE-WAY PROJECTION (the invariant this whole route exists to protect) ────
 * Course progress is the source of truth; the task is a VIEW of it. This route
 * only ever `.create()`s a task. It never updates one, never deletes one, and
 * never reconciles a task back onto course data. Ticking a mirrored subtask in
 * My Work, renaming it, archiving it, or dismissing it writes NOTHING to
 * `courseProgress`, `courseExerciseResponses`, or the week doc — and nothing in
 * the courses feature reads a task back. The arrow points one way, and any
 * future edit that makes a task write influence course state breaks the model:
 * the member's board would become a second, divergent record of what they have
 * done, and the deterministic re-create below would then silently clobber it.
 * If a course surface ever needs "did they do it?", it asks `courseProgress`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY LAZY, AND WHY THAT IS SAFE ON EVERY MOUNT ───────────────────────────
 * App Hosting has no scheduler (Cloud Run, 60s request ceiling), so nothing in
 * this app advances a cohort on a timer. Mirroring is therefore driven by page
 * mounts: the learning space and the dashboard POST here, and this route is
 * built to be called that often.
 *
 * The HOT PATH is three doc reads, one Auth RPC, and zero writes: the
 * `getCurrentUser()` session verification runs `verifySessionCookie(cookie,
 * true)` — checkRevoked, so an Admin Auth `getUser` call — plus a `users/{uid}`
 * read, before the enrolment and run reads this route makes itself. The
 * enrolment carries `lastTaskSyncedWeek`, a high-water mark; once it equals the
 * recomputed anchor week, this route returns without reading the week doc or
 * touching `tasks`. Only the first mount of a new cohort week does real work —
 * and callers dedupe per (run, week) for the browsing session on top of that,
 * so the steady state is no request at all rather than a cheap one.
 *
 * IDEMPOTENCY IS STRUCTURAL, not a check-then-write. The task id is
 * `courseTaskId(runId, weekNumber, uid)` and the write is `.create()`, so two
 * concurrent mounts both aim at the same document: one wins, the other gets
 * ALREADY_EXISTS, which is counted as `alreadyPresent` and is NOT an error.
 * Exactly one task exists afterwards, and neither caller sees a 500. There is
 * no transaction here on purpose — `tx.create` would abort the whole callback
 * on ALREADY_EXISTS, taking the high-water-mark stamp down with it and leaving
 * every subsequent mount to repeat the same doomed work.
 *
 * ── …BUT WHOSE DOCUMENT IS AT THAT ID? ──────────────────────────────────────
 * A deterministic id is a GUESSABLE id, and the tasks rules constrain a
 * personal task's FIELDS without constraining its DOC ID. So any signed-in
 * member who knows another member's uid can `.set()` their own task at the id
 * this route will target for that member's next week. "Exactly one task exists"
 * would still hold — it would just be the squatter's task, while the victim's
 * create fails with ALREADY_EXISTS and the high-water mark below marks the week
 * delivered. The card would then never appear and never be retried.
 *
 * ALREADY_EXISTS is therefore not taken on trust: the document is read back and
 * counted as `alreadyPresent` only when it really is this member's mirror
 * (`source: "fellowship-reminder"` and the caller among its completers).
 * Anything else is reported as `conflicted`, LEAVES THE HIGH-WATER MARK
 * UNSTAMPED so the next mount retries, and is logged — an id nobody should have
 * been able to reach is worth seeing in the logs. Nothing is overwritten or
 * deleted either way; this route still only ever `.create()`s.
 *
 * ── DISMISSAL STICKS ────────────────────────────────────────────────────────
 * firestore.rules lets the member delete their own mirror (`source ==
 * 'fellowship-reminder' && isCompleter()`). The high-water mark is what makes
 * that dismissal permanent: `lastTaskSyncedWeek` is already stamped by the time
 * the member can see the card, so the next mount short-circuits rather than
 * resurrecting it. A dismissed week stays dismissed until the cohort rolls into
 * the next one. That is deliberate — a reminder you cannot get rid of is not a
 * reminder, it is nagging.
 *
 * ── WHO MAY CALL ────────────────────────────────────────────────────────────
 * An ACTIVE enrolment on this run, learner or facilitator, and nobody else.
 * There is no admin bypass and there is nothing to bypass TO: the mirror lands
 * on the caller's OWN board, addressed by their own session uid, so an admin
 * with no enrolment has no week of their own to mirror. Every refusal is ONE
 * indistinguishable 403 raised BEFORE the run document is consulted, so a
 * member poking at run ids learns nothing about which ones exist.
 *
 * SERVERS ALWAYS RECOMPUTE. This route reads no body and accepts no week
 * number; the week is derived from `(run, now)` by `currentWeekFor`. A client
 * cannot ask to have a future week materialised early, nor backfill a term's
 * worth of missed weeks — only the ANCHOR week is ever written.
 */

// ---------------------------------------------------------------------------
// Wire type (the contract the mount-time caller reads)
// ---------------------------------------------------------------------------

/**
 * `weekNumber: null` means "nothing to mirror" and is a SUCCESS, not a
 * failure: the run has not started, has finished, sits on a break with no
 * taught week behind it yet, or the anchor week is unpublished/unauthored.
 *
 * `created`, `alreadyPresent` and `conflicted` are 0-or-1 today (one member,
 * one week) and are counts rather than booleans so an admin-triggered backfill
 * can reuse the shape without changing it. They satisfy
 * `created + alreadyPresent + conflicted === (weekNumber === null ? 0 : 1)`.
 *
 * `conflicted: 1` is the honest answer to "something else already occupies this
 * member's mirror id" (see …BUT WHOSE DOCUMENT IS AT THAT ID? above). It is
 * still `ok: true` — there is nothing for the caller to do about it and nothing
 * to show a member mid-page — but it is deliberately NOT `alreadyPresent`,
 * because the week was not in fact delivered and the high-water mark is left
 * unstamped so the next mount tries again.
 *
 * Note that `alreadyPresent: 1` on the short-circuit path is asserted from the
 * high-water mark, not from a read of the task — which is exactly right, since
 * a member who dismissed the card should not have it counted as missing and
 * re-created (see DISMISSAL STICKS above).
 */
export type SyncTasksResult = {
  ok: true;
  weekNumber: number | null;
  created: number;
  alreadyPresent: number;
  conflicted: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/** A week-plan slot is exactly 7 days, so its last day is start + 6. */
const SLOT_LAST_DAY_OFFSET = 6;

/** The week's work is due by the end of the cohort's slot, London wall clock. */
const DUE_WALL_CLOCK = "23:59";

/**
 * Run statuses that may materialise a task, as an ALLOWLIST so a status added
 * later fails closed. `draft` has no cohort yet; `completed` and `cancelled`
 * must not hand anybody new work, even if the calendar says a slot is still
 * running (an admin who ends a run early has said so with the status).
 */
const MIRRORING_STATUSES = new Set<CourseRunStatus>([
  "applications-open",
  "applications-closed",
  "running",
]);

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw — a 500 out of a mount-time call. Same
 * guard as `runAccess.ts` and the sibling member routes, deliberately identical
 * so the gate and the routes agree about what counts as an addressable id.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/** The success-with-no-work answer. Fresh object per call; never shared. */
function nothingToMirror(): NextResponse {
  const result: SyncTasksResult = {
    ok: true,
    weekNumber: null,
    created: 0,
    alreadyPresent: 0,
    conflicted: 0,
  };
  return NextResponse.json(result);
}

/**
 * ALREADY_EXISTS out of `.create()`. The Admin SDK surfaces the raw gRPC status
 * (6) on the error; the string form is accepted too because the emulator and
 * some transport paths report the canonical name instead. Anything else is a
 * real failure and must not be swallowed as "the task was already there".
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  // 403 rather than 404 even for a malformed id: every refusal on this route is
  // the same refusal (see WHO MAY CALL).
  if (!isAddressableId(runId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  try {
    // Both reads in one round trip — the hot path needs both anyway (the
    // enrolment to gate and to read the high-water mark, the run to recompute
    // the anchor). Issuing them together discloses nothing: the RESPONSE is the
    // boundary, and no run-derived byte, status code included, is emitted
    // before the enrolment gate below.
    //
    // The enrolment is ADDRESSED, never queried: `courseEnrolmentId` binds
    // (run, uid) and the uid comes from the session, so there is no way to
    // spell another member's row and no way to widen this to a scan.
    const [enrolSnap, runSnap] = await Promise.all([
      db.collection("courseEnrolments").doc(courseEnrolmentId(runId, actor.uid)).get(),
      db.collection("courseRuns").doc(runId).get(),
    ]);

    const enrolment = enrolSnap.exists
      ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
      : null;
    // ACTIVE only — stricter than the read routes, which also serve
    // `completed`. A finished cohort is the member's history to re-read, not a
    // source of new work; `withdrawn` and `removed` lose the mirror the moment
    // they are written. Either ROLE qualifies: a facilitator works the same
    // week their group does, so they get the same weekly card.
    if (!enrolment || enrolment.status !== "active") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Past the gate, so the caller is enrolled and a missing run tells them
    // nothing they did not already know. An active enrolment pointing at a run
    // that no longer exists is corrupt state (or a delete mid-pagination), and
    // saying so beats a silent "nothing to mirror" that hides it forever.
    if (!runSnap.exists) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

    if (!MIRRORING_STATUSES.has(run.status)) return nothingToMirror();

    // SERVERS ALWAYS RECOMPUTE — the week is a pure function of (run, now), and
    // `now` is captured once so the pacing decision, the due date and the
    // task's own timestamps all describe the same instant.
    //
    // `currentWeekFor` throws `RangeError` on a malformed start date by design,
    // and a half-authored run (created, no start date chosen) is a legitimate
    // state, so the guard is required rather than defensive noise.
    if (!isValidDateKey(run.startDate)) return nothingToMirror();
    const now = new Date();
    const currentWeek = currentWeekFor(
      { startDate: run.startDate, weekPlan: run.weekPlan },
      now,
    );

    // ONLY THE ANCHOR WEEK MATERIALISES. `anchorWeekNumber` is the last taught
    // week that has STARTED, so a cohort mid-break stays anchored to the week
    // behind it (already mirrored → short-circuit) and a cohort that has not
    // begun anchors to 0. There is deliberately no backlog pass: a member who
    // joined at week 6 gets week 6, not five stale cards, and no future week is
    // ever reachable because the anchor cannot run ahead of the calendar.
    const weekNumber = currentWeek.anchorWeekNumber;
    if (currentWeek.phase !== "running") return nothingToMirror();
    if (
      !Number.isInteger(weekNumber) ||
      weekNumber < 1 ||
      weekNumber > MAX_WEEK_NUMBER
    ) {
      // Includes the "on a break before any taught week" case (anchor 0) and a
      // corrupt plan entry, which must not be allowed to build a doc id.
      return nothingToMirror();
    }

    // ---- THE SHORT-CIRCUIT (the hot path) --------------------------------
    // Every mount lands here. Two reads, no write, no week doc, no `tasks`
    // touch. See DISMISSAL STICKS for why this deliberately does not verify
    // that the task is still there.
    if (enrolment.lastTaskSyncedWeek === weekNumber) {
      const result: SyncTasksResult = {
        ok: true,
        weekNumber,
        created: 0,
        alreadyPresent: 1,
        conflicted: 0,
      };
      return NextResponse.json(result);
    }

    // ---- The week doc supplies the content -------------------------------
    // Addressed as `weekDocId(anchor)`, which is what the member-facing week
    // page resolves (`WeekView` → `useWeek(runId, weekDocId(n))`) and what
    // `courseTaskId` embeds. The plan entry's own `weekId` is NOT used here on
    // purpose: it can drift from the display number across a copy-forward, and
    // a mirror built from a different doc than the page shows would carry
    // subtask ids the member never sees.
    const weekSnap = await db
      .collection("courseRuns")
      .doc(runId)
      .collection("weeks")
      .doc(weekDocId(weekNumber))
      .get();
    // An unpublished or unauthored week mirrors NOTHING — a titleless card with
    // no checklist is worse than no card, and the high-water mark is left
    // unstamped so the mirror appears on the first mount after publication.
    if (!weekSnap.exists) return nothingToMirror();
    const week = normalizeCourseWeek(weekSnap.id, weekSnap.data() ?? {});
    if (!week.published) return nothingToMirror();

    // Due at the end of the CURRENT slot, 23:59 Europe/London. The slot is the
    // one the cohort is in right now rather than the anchor week's own slot:
    // during a break that is the break's end, which gives a late-mirrored week
    // a deadline in the future instead of one that is already overdue.
    // Timezone maths belongs to `weekPlan` — never hand-rolled, so the 25 Oct
    // fold and the 28 Mar gap resolve the way the rest of the feature resolves
    // them.
    const dueDate = londonWallClockToInstant(
      addDaysToKey(currentWeek.slotStartKey, SLOT_LAST_DAY_OFFSET),
      DUE_WALL_CLOCK,
    );

    // The course title is the run's denormalised copy; `label` then a neutral
    // word cover a half-authored run. Clamped because `TASK_FIELD_LIMITS.title`
    // is what the tasks rules enforce on client-authored tasks, and a mirror
    // that a member cannot re-save would be a mirror the board treats as
    // second-class. `summary` is plain text BY DESIGN (never `Block[]`) and is
    // rendered as text nodes by the task UI — nothing here does any HTML
    // processing and nothing may start.
    const courseTitle = run.courseTitle || run.label || "Course";
    const payload = buildMirroredTask({
      runId,
      weekNumber,
      uid: actor.uid,
      title: `${courseTitle} — Week ${weekNumber}`.slice(0, TASK_FIELD_LIMITS.title),
      description: week.summary.slice(0, TASK_FIELD_LIMITS.description),
      // A published week with no `mirrorToMyWork` items still earns a card: the
      // task IS the weekly nudge (source `fellowship-reminder`), and the
      // checklist is a bonus rather than its reason to exist.
      checklist: week.checklist,
      dueDate,
      now,
    });

    const taskRef = db.collection("tasks").doc(courseTaskId(runId, weekNumber, actor.uid));

    let created = 0;
    let alreadyPresent = 0;
    let conflicted = 0;
    try {
      await taskRef.create(payload);
      created = 1;
    } catch (err) {
      // The idempotency guarantee cashing out. NOT an error, and emphatically
      // not an overwrite: whatever is at that id — including a task the member
      // has since ticked, renamed nothing of, or half-completed — is left
      // exactly as it stands.
      if (!isAlreadyExists(err)) throw err;

      // …but "something is there" and "the member's mirror is there" are not
      // the same claim, and only the second one may stamp the high-water mark
      // (see …BUT WHOSE DOCUMENT IS AT THAT ID? above). One extra read, on the
      // cold path only — the hot path short-circuited long before here.
      //
      // The test is deliberately about IDENTITY, not shape: the stored `source`
      // (which the tasks rules pin — a member can neither create a task
      // claiming `fellowship-reminder` nor relabel one) plus the caller's own
      // uid among the completers. A squatter can spell either field, but not
      // both: claiming the source is refused at create time, and a `personal`
      // task fails the source test whoever is listed on it.
      //
      // A doc that has VANISHED between the create and this read counts as a
      // conflict too. That ordering is essentially unreachable in practice (the
      // member cannot have seen, let alone dismissed, a card in that window),
      // and failing closed costs at most one re-created card while failing open
      // would hand a squatter a permanent, silent suppression.
      const existing = await taskRef.get();
      const data = existing.data();
      const isOurMirror =
        existing.exists &&
        data?.source === "fellowship-reminder" &&
        Array.isArray(data.completerUids) &&
        (data.completerUids as unknown[]).includes(actor.uid);
      if (isOurMirror) {
        alreadyPresent = 1;
      } else {
        conflicted = 1;
        console.error(
          "[courses sync-tasks] mirror id occupied by a foreign task",
          runId,
          actor.uid,
          weekNumber,
          taskRef.id,
          { exists: existing.exists, source: data?.source ?? null },
        );
      }
    }

    // Stamped AFTER the write lands, so a failure above simply retries on the
    // next mount rather than marking a week done that was never mirrored. Same
    // reasoning skips the stamp entirely on `conflicted`: the mark's whole job
    // is to say "this week has been delivered", and it has not been.
    // `updatedAt` is deliberately NOT bumped: on an enrolment it means "this
    // placement changed", and moving it once a week per member would turn the
    // roster's last-changed column into noise.
    //
    // The stamp is a CACHE, not the record — the record is the task itself, at
    // a deterministic id. So a stamp failure is logged and swallowed rather
    // than 500ing a page mount over an optimisation: the caller's mirror
    // exists, and the next mount re-runs the (now ALREADY_EXISTS) create and
    // tries the stamp again. Self-healing, at a bounded cost of three reads.
    if (conflicted === 0) {
      try {
        await enrolSnap.ref.update({ lastTaskSyncedWeek: weekNumber });
      } catch (err) {
        console.error(
          "[courses sync-tasks] high-water stamp failed",
          runId,
          actor.uid,
          weekNumber,
          err,
        );
      }
    }

    const result: SyncTasksResult = {
      ok: true,
      weekNumber,
      created,
      alreadyPresent,
      conflicted,
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error("[courses sync-tasks] failed", runId, actor.uid, err);
    return NextResponse.json(
      { error: "Couldn't sync your course tasks." },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import { normalizeExerciseResponse } from "@/lib/firestore/courseExercises";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseWeek, weekDocId } from "@/lib/firestore/courses";
import type { ExerciseResponseWire } from "@/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route";

/**
 * THE FACILITATOR REVIEW QUEUE for one group, one week: the week's exercise
 * prompts, every active member of the group, and what each of them has written.
 *
 * ── WHO MAY READ (locked product decision) ──────────────────────────────────
 * A facilitator of THIS group, while it is LIVE (`courseGroups.facilitatorUids`
 * on a group that is not archived) ∪ admins. That is the whole list.
 *  · An archived group staffs nobody but an admin — the same rule `runAccess.ts`
 *    and the page gate apply, spelled out at the gate below.
 *  · Plain members get 403 — being in a group does not mean reading the
 *    group's homework. Peer visibility is a per-exercise flag (`peerVisible`)
 *    that a future peer lane will honour; this route is not that lane.
 *  · Another group's facilitator gets 403 — the point of small groups is that
 *    they are small, and staffing one grants nothing about the others.
 *  · Admissions reviewers and track leads get 403. Admissions is a SEPARATE
 *    LANE from the cohort (locked decision): reading applications grants no
 *    sight of anyone's work, and staffing a run is not facilitating a group.
 *    Someone who needs this view gets named on the group like everyone else —
 *    which is why the run doc is not read here at all.
 *
 * ── ENUMERATION-SAFE ────────────────────────────────────────────────────────
 * The caller passes no uids. The server derives the roster from the group's own
 * enrolment rows, so you only ever see the work of people already placed in a
 * group you facilitate. The `groupId` in the path is likewise non-disclosing:
 * the facilitator check runs BEFORE any "does this group exist" answer, so a
 * missing group and someone else's group are the same 403 (see the gate below).
 *
 * ── EMPTY ROWS ARE THE POINT ────────────────────────────────────────────────
 * Every active member appears, including those who have submitted nothing. A
 * queue that listed only submissions would make "nobody did exercise 2" look
 * identical to "exercise 2 doesn't exist" — the gap IS the signal a facilitator
 * is looking for.
 *
 * PII: NAMES ONLY, via `displayNameOf`, never an email. Anything that needs to
 * reach these people by email goes through the group email route, which
 * resolves addresses server-side and never hands them out. Every field added
 * below has to be checked against that line.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the two-pane review queue renders from)
// ---------------------------------------------------------------------------

export type GroupExercisesPayload = {
  group: { id: string; name: string };
  /**
   * The week's exercise DEFINITIONS, straight off the week doc — the queue
   * heads each answer with its prompt, and a response carries only an
   * `exerciseId`. Authored content, no member data.
   */
  week: {
    /** Week doc id ("w03"). */
    weekId: string;
    weekNumber: number;
    title: string;
    exercises: Array<{
      id: string;
      /** Plain text — rendered as a text node, never as HTML. */
      prompt: string;
      helpText: string | null;
      responseType: "text" | "link";
      required: boolean;
    }>;
  };
  /**
   * One row per ACTIVE member of the group, name-sorted. `responses` is empty
   * for a member who has submitted nothing this week — see the module comment.
   */
  rows: Array<{
    uid: string;
    displayName: string;
    responses: ExerciseResponseWire[];
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/** Same cap the roster route applies — a group is small by design. */
const MAX_MEMBERS = 100;

/**
 * The run-week response slice this route filters down (see the query comment):
 * `MAX_MEMBERS` × `COURSE_FIELD_LIMITS.maxExercises` (15) is the structural
 * maximum, so a truncated read is not reachable by a cohort that fits the
 * roster cap.
 */
const MAX_RUN_WEEK_RESPONSES = MAX_MEMBERS * 15;

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw. Same guard as `runAccess.ts`.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for a facilitator-facing queue. (Duplicated per route by house convention.)
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

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** `?week=N` — a positive integer inside the plan's bounds, or null. */
function parseWeek(raw: string | null): number | null {
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_WEEK_NUMBER ? n : null;
}

/**
 * ── THE `weekNumber` INVARIANT (why this route needs no fallback) ────────────
 * `weekNumber` is stored on the response doc but is not part of
 * `CourseExerciseResponseDoc`. It never has to be re-derived here: the SUBMIT
 * ROUTE IS THE ONLY WRITER of that collection (`allow write: if false` in
 * firestore.rules) and it always stores the number derived from `weekId`, and
 * the response query below FILTERS on `weekNumber == week`. So every row this
 * queue can see carries exactly `week`, which is also the number the payload's
 * week header uses.
 *
 * An id-derived fallback would be dead code, not a safety net: Firestore
 * excludes docs missing a filtered field, so a field-less row could never reach
 * one — it would simply be invisible to this query (and to the member's own
 * my-exercises page). The single writer stamping the field is the invariant
 * that matters, and the only place it can be broken.
 */

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const week = parseWeek(new URL(req.url).searchParams.get("week"));
  if (week === null) {
    return NextResponse.json(
      { error: `week must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }

  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  // The whole access decision, in one expression and off ONE document.
  //
  // ARCHIVING A GROUP UNSTAFFS IT — ONE RULE, stated the same everywhere.
  // `runAccess.ts` already drops facilitator status for an archived group, the
  // run overview omits its card, and the page gate at
  // `(app)/learn/[runId]/group/[groupId]/review` redirects a non-admin whose
  // group is archived. This route used to say the opposite (serve the queue a
  // facilitator cannot open), which left the two gates asserting different
  // rules about the same people. Admins bypass in both places: an archived
  // cohort is exactly the thing an admin is asked to go back and look at.
  //
  // AUTHORIZATION BEFORE EXISTENCE. A missing group, an ARCHIVED group and a
  // group you do not facilitate collapse onto the SAME 403, so probing group
  // ids tells you nothing about which ones exist — the same non-disclosure
  // `runAccess.ts` gives a missing run. The honest 404/400 below are reachable
  // ONLY by someone already past this gate, which is why they may be specific.
  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  if (!group.runId) {
    return NextResponse.json(
      { error: "Group is not attached to a run" },
      { status: 400 },
    );
  }

  const weekId = weekDocId(week);

  // Three reads in one round trip, all scoped by the GROUP's own `runId` — never
  // a caller parameter.
  const [weekSnap, memberSnap, responseSnap] = await Promise.all([
    db
      .collection("courseRuns")
      .doc(group.runId)
      .collection("weeks")
      .doc(weekId)
      .get(),
    // Exact match for the existing (runId, groupId, status) composite index, and
    // the same query the roster route runs.
    db
      .collection("courseEnrolments")
      .where("runId", "==", group.runId)
      .where("groupId", "==", groupId)
      .where("status", "==", "active")
      .limit(MAX_MEMBERS)
      .get(),
    // ONE query per group, filtered to the group's uids IN MEMORY below.
    //
    // WHY NOT NARROWER: `courseExerciseResponses` stores no `groupId` (the doc
    // shape is fixed in courseExercises.ts, and denormalising a placement that
    // moves would give two sources of truth for where someone sits), and an
    // `in` over the roster's uids is capped at 30 values — it would mean
    // chunking into N queries whose count depends on the cohort. So this reads
    // the run's whole week slice, bounded above by MAX_RUN_WEEK_RESPONSES, and
    // discards everyone outside the group. (runId, weekNumber) is a PREFIX of
    // the existing (runId, weekNumber, uid) composite, so no new index. If
    // cohorts ever outgrow the slice, the escape hatch is uid-chunked `in`
    // queries against that same index — not a schema change.
    db
      .collection("courseExerciseResponses")
      .where("runId", "==", group.runId)
      .where("weekNumber", "==", week)
      .limit(MAX_RUN_WEEK_RESPONSES)
      .get(),
  ]);

  if (!weekSnap.exists) {
    return NextResponse.json({ error: "Week not found" }, { status: 404 });
  }
  const weekDoc = normalizeCourseWeek(weekSnap.id, weekSnap.data() ?? {});

  const memberUids = memberSnap.docs
    .map((d) => normalizeCourseEnrolment(d.id, d.data() ?? {}).uid)
    .filter(Boolean);
  const memberSet = new Set(memberUids);

  const responses = responseSnap.docs
    .map((d) => normalizeExerciseResponse(d.id, d.data() ?? {}))
    // The group filter. Everything outside it is dropped before a single field
    // is copied into the payload.
    .filter((r) => memberSet.has(r.uid));

  // One `getAll` for every name the payload needs: the group's members, plus
  // whoever reviewed each response. Names only — see the PII line above.
  const uids = [
    ...new Set([
      ...memberUids,
      ...responses.map((r) => r.reviewerUid).filter((u): u is string => Boolean(u)),
    ]),
  ];
  const userDocs = uids.length
    ? await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  const byUid = new Map<string, ExerciseResponseWire[]>();
  for (const uid of memberUids) byUid.set(uid, []);
  for (const doc of responses) {
    byUid.get(doc.uid)?.push({
      id: doc.id,
      weekId: doc.weekId,
      // The queried number, echoed straight back: the response query is an
      // equality on this field, so every row here holds exactly it — the same
      // number the week header below carries.
      weekNumber: week,
      exerciseId: doc.exerciseId,
      responseType: doc.responseType,
      text: doc.text ?? null,
      linkUrl: doc.linkUrl ?? null,
      submittedAt: iso(doc.submittedAt),
      reviewStatus: doc.reviewStatus,
      reviewerName: doc.reviewerUid
        ? (nameByUid.get(doc.reviewerUid) ?? "NAISI member")
        : null,
      reviewerComment: doc.reviewerComment ?? null,
      reviewedAt: iso(doc.reviewedAt),
    });
  }

  const payload: GroupExercisesPayload = {
    group: { id: group.id, name: group.name },
    week: {
      weekId: weekDoc.id,
      // The ID-DERIVED number, not the week doc's `weekNumber` field — the same
      // invariant the response rows carry (see the note above). `weekId` here IS
      // `weekDocId(week)`, so a week doc whose display label drifted (a break
      // inserted upstream) cannot make this header disagree with the rows
      // underneath it or with the queue's own `?week=` address.
      weekNumber: week,
      title: weekDoc.title,
      exercises: weekDoc.exercises.map((x) => ({
        id: x.id,
        prompt: x.prompt,
        helpText: x.helpText ?? null,
        responseType: x.responseType,
        required: x.required,
      })),
    },
    rows: memberUids
      .map((uid) => ({
        uid,
        displayName: nameByUid.get(uid) ?? "NAISI member",
        // Response order matches the week's exercise order where it can, so the
        // queue reads down the prompts; anything orphaned by a deleted exercise
        // sorts to the end rather than vanishing.
        responses: (byUid.get(uid) ?? []).sort((a, b) => {
          const rank = (id: string) => {
            const i = weekDoc.exercises.findIndex((x) => x.id === id);
            return i === -1 ? weekDoc.exercises.length : i;
          };
          return rank(a.exerciseId) - rank(b.exerciseId) ||
            a.exerciseId.localeCompare(b.exerciseId);
        }),
      }))
      .sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid),
      ),
  };

  return NextResponse.json(payload);
}

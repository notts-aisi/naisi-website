import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import type { WeekPlanEntry } from "@/lib/courses/weekPlan";
import { normalizeCourseApplication } from "@/lib/firestore/courseApplications";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
  type CourseEnrolmentDoc,
} from "@/lib/firestore/courseEnrolments";
import {
  normalizeCourseGroup,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import { hasPaidMembership, normalizeUser } from "@/lib/firestore/users";

/**
 * The allocation board's read — one payload with everything the board needs:
 * the run, its groups (with live member counts), and every ACCEPTED applicant
 * joined with their enrolment (if any).
 *
 * WHO MAY READ: admins ∪ the run's `trackLeadUids`. Allocation is a staffing
 * act — placing accepted people into groups — so it belongs to the people who
 * staff and steer the run, NOT to admissions reviewers (whose job ended at the
 * decision) and not to facilitators (who see only their own group's roster,
 * later, via the facilitator routes).
 *
 * PII: name-only, same boundary as the P5 admissions queue — the board is
 * shown to non-admin track leads, and nothing in this payload may carry an
 * email address. `reviewerPreferredFacilitatorUid` is resolved to a display
 * NAME server-side for the same reason.
 *
 * THE INVARIANT, visible here: `groupId` on each row is the single scalar off
 * the deterministic `courseEnrolments/{runId}__{uid}` doc, so a person appears
 * on the board exactly once and can be in at most one group by construction.
 * "Everyone placed" is a count of rows with a null/inactive placement — the
 * publish route refuses while that count is non-zero.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the allocation board renders from)
// ---------------------------------------------------------------------------

export type AllocGroup = {
  id: string;
  name: string;
  /** Allocation cap; null = uncapped. Capacity is HARD at allocate time. */
  capacity: number | null;
  /** e.g. "Tuesdays 18:00–19:30"; empty when the slot isn't set up yet. */
  sessionLabel: string;
  /** Names only — this board is shown to non-admin track leads too. */
  facilitatorNames: string[];
  /** The server-owned counter maintained by the allocation transaction. */
  memberCount: number;
  /**
   * ── THE AUTONOMY FIELDS (V2-3) ────────────────────────────────────────────
   * Exactly `GroupDivergenceInput` in `src/lib/courses/groupResolve.ts`, so the
   * board hands a column straight to `groupsDiverge` with no defaulting and no
   * cast. A move between two columns can now change which WEEK a member is on
   * and which VERSION of it they read; none of that shows on a card, and the
   * allocator is the last person who can catch it.
   *
   * Not member data: a group's pacing and the ids of the weeks its facilitator
   * has forked are staffing facts about the group, the same tier as
   * `sessionLabel` and `facilitatorNames` this payload already carries to
   * non-admin track leads. No week CONTENT travels — ids only.
   *
   * `null` on either pace field means "tracks the run", which is also what an
   * unplaced member reads, so the unallocated pool compares equal to a group
   * that has overridden nothing and the note stays silent on the common move.
   */
  paceStartDate: string | null;
  paceWeekPlan: WeekPlanEntry[] | null;
  /** Doc ids ("w03") under `courseGroups/{id}/weeks`. Order irrelevant. */
  forkedWeekIds: string[];
};

export type AllocRow = {
  uid: string;
  displayName: string;
  paidMembership: boolean;
  /** The session labels the applicant ticked, split back out of storage. */
  availability: string[];
  reviewerPreferredGroupId: string | null;
  /** Resolved to a NAME server-side — the uid's address never travels. */
  reviewerPreferredFacilitatorName: string | null;
  reviewerNotes: string | null;
  /** The single placement scalar; null = accepted but not yet placed. */
  groupId: string | null;
  enrolmentStatus: "none" | "active" | "withdrawn" | "removed";
  /** ISO 8601 — when the placement email for the current group was sent. */
  allocatedEmailAt: string | null;
};

export type AllocationPayload = {
  run: {
    id: string;
    label: string;
    courseTitle: string;
    academicYear: string;
    /** ISO 8601, or null while allocation has never been published. */
    allocationPublishedAt: string | null;
  };
  groups: AllocGroup[];
  people: AllocRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ceiling on the keys-only fork read per group. A plan holds at most
 * `COURSE_FIELD_LIMITS.maxWeekPlanEntries` (60) slots, so a group cannot have
 * more forks than that — the limit is a cost guard on a corrupt subcollection,
 * not a real bound anyone reaches.
 */
const MAX_FORKED_WEEKS = 60;

/** Index = `GroupSession.weekday` (`Date.getDay()`, 0 = Sunday). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function endTimeLabel(start: string, minutes: number): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * "Tuesdays 18:00–19:30" — byte-for-byte the label the apply page renders as
 * availability chips and the P5 queue shows per group, so a row's
 * `availability` strings and this payload's group labels compare EQUAL on the
 * board (that equality is what powers the availability-conflict chips).
 * Deliberately duplicated from the P5 applications route — route handlers
 * don't import from one another. The format is the contract; change together.
 */
function sessionLabel(session: GroupSession): string {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for the track-lead-facing board. (Same local helper as P1/P5 carry; the
 * plan's integration checklist owns the eventual shared extraction.)
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

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

/**
 * Split the stored availability line back into chips — P4 stores the ticked
 * session labels as one comma-joined string (see the apply route's WIRE vs
 * STORED note); the labels themselves never contain a comma.
 */
function splitAvailability(stored: string): string[] {
  return stored
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Collapse an enrolment onto the board's four-state contract. `completed`
 * maps to "active": for placement purposes a completed enrolment is a placed
 * one (it holds a seat and must not be re-placed elsewhere), and the board
 * only ever runs pre/mid-run where the state shouldn't occur anyway.
 */
function boardStatus(e: CourseEnrolmentDoc | null): AllocRow["enrolmentStatus"] {
  if (!e) return "none";
  if (e.status === "completed") return "active";
  return e.status;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const runData = runSnap.data() ?? {};
  const run = normalizeCourseRun(runSnap.id, runData);

  const isAdmin = actor.role === "admin";
  const isTrackLead = run.trackLeadUids.includes(actor.uid);
  if (!isAdmin && !isTrackLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // `runId` alone is single-field auto-indexed. Same cost ceilings and same
  // rationale as the P5 queue: the board is a whole-cohort surface, loaded in
  // one shot; a run approaching 500 applicants needs a paged board, not a
  // bigger number here. Status is filtered in memory so no composite index is
  // needed.
  const [appSnap, groupSnap] = await Promise.all([
    db.collection("courseApplications").where("runId", "==", runId).limit(500).get(),
    db.collection("courseGroups").where("runId", "==", runId).limit(50).get(),
  ]);

  const accepted = appSnap.docs
    .map((d) => normalizeCourseApplication(d.id, d.data() ?? {}))
    .filter((a) => a.status === "accepted");

  // Archived groups are dropped: the board must not offer a column that no
  // longer runs (the allocate route refuses them independently).
  const groups = groupSnap.docs
    .map((d) => normalizeCourseGroup(d.id, d.data() ?? {}))
    .filter((g) => !g.archived)
    .sort((a, b) => {
      // Monday-first for display; `weekday` is stored Sunday-first.
      const day = ((a.session.weekday + 6) % 7) - ((b.session.weekday + 6) % 7);
      return (
        day ||
        a.session.startTimeLocal.localeCompare(b.session.startTimeLocal) ||
        a.name.localeCompare(b.name)
      );
    });

  // The join is by CONSTRUCTION, not by query: the enrolment doc id is
  // `courseEnrolmentId(runId, uid)`, so each accepted applicant's enrolment —
  // if it exists — lives at exactly one known path. One `getAll` fetches the
  // lot; a missing doc is an honest "not placed yet".
  const enrolmentRefs = accepted.map((a) =>
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, a.uid)),
  );
  const enrolmentSnaps = enrolmentRefs.length ? await db.getAll(...enrolmentRefs) : [];
  const enrolmentByUid = new Map<string, CourseEnrolmentDoc>();
  for (const snap of enrolmentSnaps) {
    if (!snap.exists) continue;
    const e = normalizeCourseEnrolment(snap.id, snap.data() ?? {});
    enrolmentByUid.set(e.uid, e);
  }

  // THE FORKED WEEK IDS, one keys-only read per group (V2-3). `select()` with
  // no field mask returns the doc IDS and nothing else — no week content
  // crosses this boundary, and the fan-out is bounded by the same 50-group
  // ceiling the query above already imposes, times the 60-slot plan ceiling.
  //
  // It cannot be derived any more cheaply: "has this group forked anything" is
  // the existence of documents in a subcollection, and there is no denormalised
  // counter on the group doc to read instead (adding one would be a second
  // source of truth for the fork state that the fork route would have to keep
  // in step). Groups are read in parallel with each other, in one round trip.
  const forkedIdsByGroup = new Map<string, string[]>();
  const forkSnaps = await Promise.all(
    groups.map((g) =>
      db
        .collection("courseGroups")
        .doc(g.id)
        .collection("weeks")
        .select()
        .limit(MAX_FORKED_WEEKS)
        .get(),
    ),
  );
  groups.forEach((g, i) => {
    forkedIdsByGroup.set(g.id, forkSnaps[i].docs.map((d) => d.id));
  });

  // One `getAll` for every name this payload needs: applicants, the groups'
  // facilitators, and each row's reviewer-preferred facilitator. Names only —
  // see the PII note in the module comment.
  const uids = new Set<string>();
  for (const app of accepted) {
    if (app.uid) uids.add(app.uid);
    if (app.reviewerPreferredFacilitatorUid) uids.add(app.reviewerPreferredFacilitatorUid);
  }
  for (const group of groups) {
    for (const uid of group.facilitatorUids) uids.add(uid);
  }
  const uidList = [...uids];
  const userDocs = uidList.length
    ? await db.getAll(...uidList.map((uid) => db.collection("users").doc(uid)))
    : [];

  const nameByUid = new Map<string, string>();
  const paidByUid = new Map<string, boolean>();
  for (const doc of userDocs) {
    if (!doc.exists) continue;
    const data = doc.data() ?? {};
    nameByUid.set(doc.id, displayNameOf(data));
    // Against the RUN's academic year, not today's — same reasoning as the P5
    // queue: the badge must not blank when `currentAcademicYear()` rolls over
    // mid-cycle on 1 August.
    paidByUid.set(
      doc.id,
      hasPaidMembership(normalizeUser(doc.id, data), run.academicYear),
    );
  }

  const people: AllocRow[] = accepted.map((app) => {
    const enrolment = enrolmentByUid.get(app.uid) ?? null;
    return {
      uid: app.uid,
      displayName: nameByUid.get(app.uid) ?? app.displayName ?? "NAISI member",
      paidMembership: paidByUid.get(app.uid) ?? app.paidMembershipAtApply,
      availability: splitAvailability(app.availability),
      reviewerPreferredGroupId: app.reviewerPreferredGroupId ?? null,
      reviewerPreferredFacilitatorName: app.reviewerPreferredFacilitatorUid
        ? (nameByUid.get(app.reviewerPreferredFacilitatorUid) ?? "NAISI member")
        : null,
      reviewerNotes: app.reviewerNotes ?? null,
      groupId: enrolment?.groupId ?? null,
      enrolmentStatus: boardStatus(enrolment),
      allocatedEmailAt: iso(enrolment?.allocatedEmailAt),
    };
  });
  // Unplaced first (the work), then alphabetical — the board reads as a queue.
  people.sort((a, b) => {
    const rank = (r: AllocRow) => (r.groupId && r.enrolmentStatus === "active" ? 1 : 0);
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
  });

  const payload: AllocationPayload = {
    run: {
      id: run.id,
      label: run.label,
      courseTitle: run.courseTitle,
      academicYear: run.academicYear,
      // Not part of `normalizeCourseRun` (the field is owned by this feature's
      // publish route), so it is read off the raw doc here.
      allocationPublishedAt: iso(tsToDate(runData.allocationPublishedAt)),
    },
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      capacity: g.capacity,
      sessionLabel: sessionLabel(g.session),
      facilitatorNames: g.facilitatorUids.map(
        (uid) => nameByUid.get(uid) ?? "NAISI member",
      ),
      memberCount: g.memberCount,
      // The autonomy triple, straight off the normalised doc plus the keys-only
      // subcollection read above. `normalizeCourseGroup` already coerces a
      // garbled pace date and a malformed plan to `null` (= tracks the run), so
      // the board never has to interpret these — see AllocGroup.
      paceStartDate: g.paceStartDate,
      paceWeekPlan: g.paceWeekPlan,
      forkedWeekIds: forkedIdsByGroup.get(g.id) ?? [],
    })),
    people,
  };

  return NextResponse.json(payload);
}

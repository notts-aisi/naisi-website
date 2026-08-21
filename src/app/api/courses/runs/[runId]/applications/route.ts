import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  normalizeCourseApplication,
  type CourseApplicationStatus,
} from "@/lib/firestore/courseApplications";
import {
  normalizeCourseGroup,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
  type ApplicationCounts,
} from "@/lib/firestore/courses";
import { hasPaidMembership, normalizeUser } from "@/lib/firestore/users";

/**
 * The admissions review queue for one run — the read half of P5.
 *
 * WHO MAY READ (locked product decision): admins ∪ the run's
 * `admissionsReviewerUids` ∪ its `trackLeadUids`. Admissions is deliberately a
 * SEPARATE role from facilitation: being a group facilitator grants no sight of
 * anyone's application, and reviewing applications grants no access to the
 * cohort. Track leads are here to READ (they staff and steer the run); only
 * admins and admissions reviewers may decide — see the decide route.
 *
 * ── THE PII BOUNDARY ────────────────────────────────────────────────────────
 * `email` is populated ONLY when the caller is an admin. A non-admin reviewer
 * gets `email: null` on every row and sees names only. That is a locked product
 * decision, not a nicety: reviewers are ordinary members assigned to one run's
 * queue, and handing them a list of applicant addresses would hand them a
 * mailing list nobody consented to. `courseApplications` is own-row-read + admin
 * in firestore.rules precisely so this route is the only reviewer-facing path,
 * and this is the one place the stripping happens. Every future field added
 * below must be checked against the same line — `decidedByName` is resolved from
 * a uid the same PII-free way, never from an address.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here reads the paid-membership tag as a gate: it travels as
 * `paidMembership`, a BADGE for the reviewer's judgement, and no branch in this
 * feature may condition access on it.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the admissions queue renders from)
// ---------------------------------------------------------------------------

export type AdmissionsGroup = {
  id: string;
  name: string;
  /** e.g. "Tuesdays 18:00–19:30"; empty when the slot isn't set up yet. */
  sessionLabel: string;
  /** Names only — this list is shown to non-admin reviewers too. */
  facilitators: Array<{ uid: string; displayName: string }>;
};

export type AdmissionsRow = {
  uid: string;
  displayName: string;
  /** ADMINS ONLY — null for every non-admin reviewer. See the PII boundary. */
  email: string | null;
  paidMembership: boolean;
  status: CourseApplicationStatus;
  answers: Record<string, unknown>;
  /** The session labels the applicant ticked, split back out of storage. */
  availability: string[];
  reviewerNotes: string | null;
  reviewerPreferredGroupId: string | null;
  reviewerPreferredFacilitatorUid: string | null;
  decidedByName: string | null;
  /** ISO 8601, or null while the application is still pending. */
  decidedAt: string | null;
  decisionReason: string | null;
  /** ISO 8601. Empty string only for a legacy row with no createdAt. */
  createdAt: string;
};

export type AdmissionsPayload = {
  run: {
    id: string;
    label: string;
    courseId: string;
    courseTitle: string;
    academicYear: string;
    applicationCounts: ApplicationCounts;
    /**
     * The run's application-form question labels, so the queue can head each
     * answer with its question — `answers` is keyed by opaque question ids
     * (`q_<base36>_<rand>`) and is unreadable without them. Admin-authored
     * form copy, carries no applicant data, so every reviewer gets it.
     */
    questions: Array<{ id: string; label: string }>;
  };
  groups: AdmissionsGroup[];
  applications: AdmissionsRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * "Tuesdays 18:00–19:30" — byte-for-byte the label
 * `fetchCourses.getApplyContext()` renders as availability chips, so a row's
 * `availability` strings and this run's group labels compare equal in the queue.
 *
 * DELIBERATE DUPLICATION. Importing `features/courses/fetchCourses` from a route
 * handler would be legal (`server-only` bars client bundles, not routes), but
 * that module exports no per-run group fetcher and no facilitators — its
 * `getApplyContext` is keyed by courseId and picks the open run itself — and the
 * formatter isn't exported. Copying ~15 lines beats bending a public-page
 * fetcher into a reviewer API. The format is the contract; change both together.
 */
function sessionLabel(session: GroupSession): string {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

/**
 * Display-name fallback chain: what the member asked to be called, then their
 * account name, then a neutral placeholder — NEVER an email address, which is
 * what makes this safe to call for reviewer-facing rows.
 *
 * (P1's roles route carries the same local helper; route handlers don't import
 * from one another, so this is duplicated on purpose. The plan's integration
 * checklist has "extract shared `displayNameOf()`" as its own cleanup — when
 * that lands, all three call sites collapse into it.)
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

/**
 * Split the stored availability line back into chips. P4 stores the ticked
 * session labels as ONE comma-joined string (see the apply route's WIRE vs
 * STORED note) because the labels are regenerated on every read and an array of
 * them would rot as groups are renamed; the queue wants them as chips again.
 * Splitting on ", " is exact: the labels themselves never contain a comma.
 */
function splitAvailability(stored: string): string[] {
  return stored
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pending first, then oldest first — the queue reads as a work list. */
function queueOrder(a: AdmissionsRow, b: AdmissionsRow): number {
  const rank = (r: AdmissionsRow) => (r.status === "pending" ? 0 : 1);
  return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt);
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
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const isAdmin = actor.role === "admin";
  const isReviewer = run.admissionsReviewerUids.includes(actor.uid);
  const isTrackLead = run.trackLeadUids.includes(actor.uid);
  if (!isAdmin && !isReviewer && !isTrackLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // `runId` alone is single-field auto-indexed — no composite needed, and no
  // `orderBy` (createdAt is sparse on legacy rows; ordering happens below).
  // The queue is a whole-cohort work list, so it loads in one shot; the limits
  // are a cost ceiling on a hand-crafted or runaway run, not a paging scheme.
  // A cohort that ever approaches 500 applicants needs a paged queue, not a
  // bigger number here.
  const [appSnap, groupSnap] = await Promise.all([
    db.collection("courseApplications").where("runId", "==", runId).limit(500).get(),
    db.collection("courseGroups").where("runId", "==", runId).limit(50).get(),
  ]);

  const applications = appSnap.docs.map((d) =>
    normalizeCourseApplication(d.id, d.data() ?? {}),
  );

  // Archived groups are dropped: a reviewer must not be able to record a
  // preference for a group that no longer runs.
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

  // One `getAll` for every name this payload needs: applicants, whoever decided
  // each application, and the groups' facilitators. Names only — see the PII
  // boundary in the module comment.
  const uids = new Set<string>();
  for (const app of applications) {
    if (app.uid) uids.add(app.uid);
    if (app.decidedByUid) uids.add(app.decidedByUid);
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
    // Computed against the RUN's academic year, not today's. A spring run
    // reviewed in the summer, or a queue re-opened after 1 August (when
    // `currentAcademicYear()` rolls over), must still show the tag for the year
    // the run belongs to — otherwise every badge silently blanks mid-cycle.
    // A run with no `academicYear` set yields false, which is the honest answer.
    paidByUid.set(
      doc.id,
      hasPaidMembership(normalizeUser(doc.id, data), run.academicYear),
    );
  }

  const rows: AdmissionsRow[] = applications.map((app) => ({
    uid: app.uid,
    // Live name first (people change what they're called), then the denormalised
    // one captured at apply time.
    displayName: nameByUid.get(app.uid) ?? app.displayName ?? "NAISI member",
    // THE PII BOUNDARY, asserted in one expression: non-admin reviewers get null.
    email: isAdmin ? app.email : null,
    // Falls back to the apply-time snapshot when the user doc is gone (deleted
    // account) — the badge then reflects what was true when they applied.
    paidMembership: paidByUid.get(app.uid) ?? app.paidMembershipAtApply,
    status: app.status,
    answers: app.answers,
    availability: splitAvailability(app.availability),
    reviewerNotes: app.reviewerNotes ?? null,
    reviewerPreferredGroupId: app.reviewerPreferredGroupId ?? null,
    reviewerPreferredFacilitatorUid: app.reviewerPreferredFacilitatorUid ?? null,
    decidedByName: app.decidedByUid
      ? (nameByUid.get(app.decidedByUid) ?? "NAISI member")
      : null,
    decidedAt: iso(app.decidedAt),
    decisionReason: app.decidedReason ?? null,
    createdAt: iso(app.createdAt) ?? "",
  }));
  rows.sort(queueOrder);

  const payload: AdmissionsPayload = {
    run: {
      id: run.id,
      label: run.label,
      courseId: run.courseId,
      courseTitle: run.courseTitle,
      academicYear: run.academicYear,
      applicationCounts: run.applicationCounts,
      questions: run.applicationForm.map((q) => ({ id: q.id, label: q.label })),
    },
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      sessionLabel: sessionLabel(g.session),
      facilitators: g.facilitatorUids.map((uid) => ({
        uid,
        displayName: nameByUid.get(uid) ?? "NAISI member",
      })),
    })),
    applications: rows,
  };

  return NextResponse.json(payload);
}

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { sendCourseApplicationEmail } from "@/lib/email/courseApplicationEmails";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  COURSE_TZ,
  addDaysToKey,
  isValidDateKey,
} from "@/lib/courses/weekPlan";
import { normalizeCourseApplication } from "@/lib/firestore/courseApplications";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
  type CourseEnrolmentDoc,
} from "@/lib/firestore/courseEnrolments";
import {
  normalizeCourseGroup,
  sessionForWeek,
  type CourseGroupDoc,
} from "@/lib/firestore/courseGroups";
import {
  courseRunChannel,
  normalizeCourseRun,
  weekDocId,
  type CourseRunDoc,
} from "@/lib/firestore/courses";
import { subscribe } from "@/lib/firestore/subscriptions";

/**
 * Publish the allocation: the moment placements stop being a draft on a board
 * and become the cohort — everyone placed gets their "you've been placed"
 * email and joins the run's cohort channel.
 *
 * WHO MAY PUBLISH: admins ∪ the run's `trackLeadUids` — same gate as the
 * board and the allocate route.
 *
 * ── "EVERYONE PLACED" IS A PRECONDITION, NOT A HOPE ─────────────────────────
 * Publishing REFUSES (409, with names) while any accepted applicant lacks an
 * active, grouped enrolment. The board shows the same count in its status
 * rail, so this refusal is the backstop, not the discovery mechanism — but it
 * is a hard one: nothing is stamped and nobody is emailed on the refusal
 * path. An accepted application with no seat is a person who was promised a
 * placement email and would silently never get one.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * RE-PUBLISH IS EXPECTED, not an error: late acceptances get placed, someone
 * gets moved, publish runs again. `enrolment.allocatedEmailAt` is the
 * idempotency guard — only enrolments LACKING the stamp are emailed, and the
 * stamp is written per-recipient after their send succeeds, so a re-publish
 * emails exactly the newly placed (and newly moved — the allocate route
 * clears the stamp on a group change) and nobody twice. The run-level
 * `allocationPublishedAt` re-stamps on every publish.
 *
 * This mail is TRANSACTIONAL (the recipient is owed it), so it goes to the
 * proven `users.email` directly — the same address discipline as the P5
 * decision emails — rather than through the notification-preference fan-out
 * used for bulk mail. The cohort-channel subscribe alongside it is what the
 * later announcement emails (P9) will fan out over.
 */

type Ctx = { params: Promise<{ runId: string }> };

/**
 * Hard cap on sends per request: App Hosting's 60s request budget is the real
 * constraint (each send is SMTP + a 200ms pacing sleep). Recipients beyond the
 * cap are NOT failed — the per-enrolment stamp means running publish again
 * simply continues where this request stopped, and the response says so.
 */
const MAX_EMAILS_PER_REQUEST = 200;

const SLEEP_MS = 200;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Display-name fallback chain — names only, never an email (P5's local twin). */
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

/** "Priya and Sam" / "Priya, Sam and Alex" — the {facilitatorNames} token. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The civil date's weekday, 0 = Sunday (noon UTC — DST can't move the date). */
function weekdayOfKey(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

/**
 * "{Weekday} {day} {month}, {HH:MM}" for a group's first taught session —
 * the {firstSessionWhen} token. A HUMAN label, deliberately not an instant:
 * the session is a London wall-clock slot and the email should read the way a
 * facilitator would say it. Undefined (token stays literal — an admin
 * notices) when the run has no valid start date, no taught week, or the
 * group's slot has no time yet.
 */
function firstSessionWhen(run: CourseRunDoc, group: CourseGroupDoc): string | undefined {
  if (!isValidDateKey(run.startDate)) return undefined;
  const planIndex = run.weekPlan.findIndex((e) => e.kind === "week");
  if (planIndex < 0) return undefined;
  const firstWeek = run.weekPlan[planIndex];
  // weekDocId(weekNumber), NOT the plan entry's weekId — the number-derived id
  // is what every member-facing surface resolves sessionOverrides by, and the
  // two can disagree on a renumbered plan. The allocation email's "first
  // session" must match what the member will see on their week page.
  const weekId =
    firstWeek.kind === "week" ? weekDocId(firstWeek.weekNumber) : weekDocId(1); // narrowing aid; findIndex guarantees "week"
  const session = sessionForWeek(group, weekId);
  if (!session.startTimeLocal) return undefined;

  // The first taught week's 7-day window starts at planIndex * 7 days; the
  // session lands on the day inside it matching the slot's weekday.
  const slotStart = addDaysToKey(run.startDate, planIndex * 7);
  const offset = (session.weekday - weekdayOfKey(slotStart) + 7) % 7;
  const sessionKey = addDaysToKey(slotStart, offset);

  const dayLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${sessionKey}T12:00:00Z`));
  return `${dayLabel}, ${session.startTimeLocal}`;
}

export async function POST(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const runRef = db.collection("courseRuns").doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const isAdmin = actor.role === "admin";
  const isTrackLead = run.trackLeadUids.includes(actor.uid);
  if (!isAdmin && !isTrackLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Same cost ceilings as the board's GET. Groups are NOT filtered on
  // archived here: a group archived after placements landed still owns those
  // placements, and its members' emails still need its name and slot.
  const [appSnap, groupSnap] = await Promise.all([
    db.collection("courseApplications").where("runId", "==", runId).limit(500).get(),
    db.collection("courseGroups").where("runId", "==", runId).limit(50).get(),
  ]);
  const accepted = appSnap.docs
    .map((d) => normalizeCourseApplication(d.id, d.data() ?? {}))
    .filter((a) => a.status === "accepted");
  const groupById = new Map(
    groupSnap.docs.map((d) => {
      const g = normalizeCourseGroup(d.id, d.data() ?? {});
      return [g.id, g] as const;
    }),
  );

  // Join by construction: each accepted applicant's enrolment lives at
  // exactly one deterministic path (see the allocate route's invariant note).
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

  // ── The precondition ──────────────────────────────────────────────────────
  // Unplaced = accepted but without an active, grouped enrolment. Names come
  // from the application's denormalised displayName — the refusal path does
  // no user-doc reads on purpose (nothing else happens on it), and the board
  // already shows live names for the same people.
  const unplaced = accepted
    .filter((app) => {
      const e = enrolmentByUid.get(app.uid);
      return !e || e.groupId === null || e.status !== "active";
    })
    .map((app) => app.displayName || "NAISI member");
  if (unplaced.length > 0) {
    return NextResponse.json(
      {
        error: `${unplaced.length} accepted applicant${unplaced.length === 1 ? " is" : "s are"} not placed in a group yet. Everyone must be placed before allocation can be published.`,
        unplaced,
      },
      { status: 409 },
    );
  }

  // The publish fact, stamped before the sends: re-publish is allowed and
  // re-stamps. If the process dies mid-send, the per-enrolment stamps below
  // record exactly who was reached, and running publish again finishes the
  // job — that is the recovery path, so the run-level stamp going first
  // loses nothing.
  await runRef.update({
    allocationPublishedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Everyone placed but not yet told. The stamp is the idempotency guard —
  // see the module comment.
  const pendingAll = accepted.filter((app) => {
    const e = enrolmentByUid.get(app.uid);
    return e && !e.allocatedEmailAt;
  });
  const pending = pendingAll.slice(0, MAX_EMAILS_PER_REQUEST);
  const remaining = pendingAll.length - pending.length;

  // One getAll for every user doc this needs: recipients (proven address +
  // greeting name) and the facilitators of their groups (names for the
  // {facilitatorNames} token — names only; a facilitator's address never
  // enters this payload or the email body).
  const uids = new Set<string>();
  for (const app of pending) {
    uids.add(app.uid);
    const gid = enrolmentByUid.get(app.uid)?.groupId;
    const group = gid ? groupById.get(gid) : undefined;
    for (const f of group?.facilitatorUids ?? []) uids.add(f);
  }
  const uidList = [...uids];
  const userDocs = uidList.length
    ? await db.getAll(...uidList.map((uid) => db.collection("users").doc(uid)))
    : [];
  const userByUid = new Map<string, Record<string, unknown>>();
  for (const doc of userDocs) {
    if (doc.exists) userByUid.set(doc.id, doc.data() ?? {});
  }

  const channel = courseRunChannel(runId);
  const actorLabel =
    actor.displayName?.trim() || (isAdmin ? "Admin" : "Track lead");

  let emailed = 0;
  let skipped = 0;

  for (const app of pending) {
    const enrolment = enrolmentByUid.get(app.uid);
    const group = enrolment?.groupId ? groupById.get(enrolment.groupId) : undefined;
    if (!enrolment || !group) {
      // Can't happen post-precondition unless a group doc vanished between
      // the reads; skip rather than send a placement email naming nothing.
      skipped += 1;
      continue;
    }

    const userData = userByUid.get(app.uid);
    // The proven address: `users.email` is the Google sign-in address. The
    // application's session-captured copy is the fallback for a since-deleted
    // user doc. No address at all → skipped, stamp NOT written, so fixing the
    // account and re-publishing still reaches them.
    const to = (typeof userData?.email === "string" && userData.email) || app.email;
    if (!to) {
      skipped += 1;
      continue;
    }
    const name = userData ? displayNameOf(userData) : app.displayName || "NAISI member";

    const facilitatorNames = group.facilitatorUids
      .map((uid) => {
        const d = userByUid.get(uid);
        return d ? displayNameOf(d) : "";
      })
      .filter(Boolean);

    try {
      // Channel membership first, then the email that mentions the course.
      // `confirmed: true` via `inboxProven` — this is the account's own
      // sign-in address, exactly the "signed-in user's verified email" case
      // subscribe() documents. Non-fatal: a bookkeeping failure must not
      // block the placement email the person is owed.
      try {
        await subscribe(db, {
          email: to,
          channel,
          audience: "user",
          audienceId: app.uid,
          source: "course-allocation",
          actor: {
            kind: isAdmin ? "admin" : "member",
            uid: actor.uid,
            label: actorLabel,
          },
          inboxProven: true,
          name,
        });
      } catch (err) {
        console.warn("[allocation publish] subscribe failed", runId, app.uid, err);
      }

      await sendCourseApplicationEmail({
        kind: "allocated",
        to,
        name,
        courseTitle: run.courseTitle,
        runLabel: run.label,
        groupName: group.name,
        facilitatorNames:
          facilitatorNames.length > 0 ? joinNames(facilitatorNames) : undefined,
        firstSessionWhen: firstSessionWhen(run, group),
        uid: app.uid,
        runId,
      });

      // The stamp goes AFTER the successful send — it is the idempotency
      // guard, so it must record "told", never "tried".
      await db
        .collection("courseEnrolments")
        .doc(courseEnrolmentId(runId, app.uid))
        .update({
          allocatedEmailAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      emailed += 1;
      await sleep(SLEEP_MS);
    } catch (err) {
      // Per-recipient: one bad address must not strand the rest of the
      // cohort. The stamp wasn't written, so the next publish retries them.
      console.error("[allocation publish] send failed", runId, app.uid, err);
      skipped += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    emailed,
    skipped,
    unplaced: [],
    // Honest over-cap note (additive field; absent in the common case): the
    // stamps make publish resumable, so "run it again" is the whole fix.
    ...(remaining > 0
      ? {
          note: `${remaining} placement email${remaining === 1 ? "" : "s"} still to send — publish again to continue (each request sends at most ${MAX_EMAILS_PER_REQUEST}).`,
        }
      : {}),
  });
}

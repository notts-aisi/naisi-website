import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { isValidDateKey, type WeekPlanEntry } from "@/lib/courses/weekPlan";
import { memberCurrentWeek, resolveCalendar } from "@/lib/courses/groupResolve";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseAttendance } from "@/lib/firestore/courseAttendance";
import { normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import {
  COURSE_FIELD_LIMITS,
  normalizeCourseRun,
  sanitizeWeekPlan,
} from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * RE-PACE ONE GROUP — the calendar half of v2 decision 4's copy-on-write.
 *
 * PATCHes the group doc's `paceStartDate` / `paceWeekPlan` overrides. `null`
 * clears a field back to TRACKING THE RUN — stored as a REAL null, because
 * the rules pin these fields with a `null` default and absent-vs-null must
 * compare equal (`courseGroups.ts` documents the storage contract). Every
 * consumer then reads the result through `resolveCalendar()`; nothing else
 * may interpret these two fields.
 *
 * ── WHO MAY RE-PACE ─────────────────────────────────────────────────────────
 * A facilitator of THIS group while it is LIVE, ∪ admins (the pinned
 * decision: "facilitator/admin"). Track leads re-pace the RUN, client-direct;
 * this route is the room's own clock. AUTHORIZATION BEFORE EXISTENCE, one
 * indistinguishable 403 — the group email route's ordering.
 *
 * ── VALIDATED LIKE A RUN'S CALENDAR, THEN STRICTER ──────────────────────────
 * `paceWeekPlan` goes through `sanitizeWeekPlan` — the SAME sanitiser the run
 * normaliser trusts — and then through the range/uniqueness checks the
 * attendance route applies (`taughtWeeksOf`), REFUSING what the sanitiser
 * would merely drop: this route is the field's ONLY writer, so a malformed
 * entry here is a caller bug to surface, not data to accommodate.
 * `paceStartDate` must pass `isValidDateKey` — a REAL civil date, so the
 * impossible-date hole the run's client lane still carries (documented as a
 * PROVEN GAP in `scripts/rules-tests/tests/courses-schedule.test.mjs`) does
 * not get a second door here.
 *
 * ── THE STRAND GATE: A MARKED REGISTER CANNOT VANISH FROM THE PLAN ──────────
 * Decision, stated: a pace change that would remove a taught week whose
 * attendance register already carries marks is REFUSED — for everyone,
 * admins included, the apply-template stance — with the stranded week
 * numbers and mark counts in the response. Registers are keyed by
 * (run, group, weekNumber), so a plan that drops week 5 makes
 * `…__w05`'s marks invisible AND un-editable (the attendance route refuses
 * non-taught weeks): exactly the orphaning
 * `tests/course-schedule-changes.test.mjs` proves for the RUN plan, which
 * this route declines to reproduce for the group plan. Re-cut the plan to
 * keep the week, or leave it in as history.
 *
 * Only NEWLY stranded weeks refuse: a register already orphaned by earlier
 * run-plan surgery does not hold this group's pacing hostage — the gate
 * compares the OLD effective calendar with the NEW one, both through
 * `resolveCalendar`. Start-date changes alone can never strand (registers
 * key by week NUMBER), so a date-only change with a stranded past sails
 * through, as it must.
 *
 * The check runs in ONE transaction with the write — group, run, register and
 * enrolment reads all `tx.get` — so the plan the gate approved is the plan the
 * write lands on (the apply-template shape; here the racing writer is
 * staff-tier rather than a member, but the transaction costs four reads and
 * closes the window outright).
 *
 * ── RE-OPENING THE MIRROR WINDOW (the pace-REWIND repair) ───────────────────
 * `courseEnrolments.lastTaskSyncedWeek` is the task mirror's HIGH-WATER MARK,
 * and it is monotonic BY DESIGN: `sync-tasks` compares `mark >= anchor` so that
 * an admin editing the RUN's calendar backwards cannot resurrect a card a
 * member deliberately dismissed ("DISMISSAL STICKS"). That design has a hole
 * this route is the only place that can close:
 *
 *     pace a group AHEAD → members mount → the mark stamps 8 → the facilitator
 *     clears the pace → the group is back on week 3 → weeks 3-7 are BELOW every
 *     member's mark, so they never mirror again. Five weeks of cards, silently
 *     owed to nobody.
 *
 * So on any pace CHANGE — set OR clear — the marks of this group's ACTIVE
 * enrolments are reset DOWN to ONE BELOW the group's NEW anchor week wherever
 * they sit above it. Never up: a mark below the new anchor is a member who has
 * genuinely not had those weeks yet, and `sync-tasks` will deliver the anchor
 * on their next mount exactly as it always did.
 *
 * WHY ONE BELOW AND NOT THE ANCHOR ITSELF. `sync-tasks` short-circuits on
 * `mark >= weekNumber`, so a mark reset to exactly the anchor skips the anchor
 * week — the week the group has just been rewound ONTO, and in the case this
 * repair exists for, the one week most certainly never delivered: a group
 * paced ahead to week 8 had week 8 mirrored and weeks 3-7 never. Resetting to
 * the anchor handed back weeks 4..8 of an 8→3 rewind and silently dropped
 * week 3. The correction is safe in the other direction because of the
 * ALREADY_EXISTS argument two paragraphs down: re-creating a card for a week
 * that WAS delivered and kept is a proven no-op, so the cost of being one week
 * generous is nothing, while the cost of being one week mean is a card nobody
 * ever gets. Clamped at 0 (the absent-mark default), so a rewind to week 1
 * delivers week 1.
 *
 * WHY THAT DOES NOT BREAK MONOTONICITY'S PURPOSE. The mark defends against an
 * edit nobody announced; a pace change is a FACILITATOR ACT on their own room,
 * the one edit whose entire point is to move which week their group is on. The
 * mirror's own contract already says a dismissed week stays dismissed "until
 * the cohort rolls into the next one" — a rewind means the cohort is going to
 * roll through those weeks again, and the weekly card is owed again with them.
 *
 * VERIFIED interaction with the deterministic mirror ids, both halves:
 *  · a card the member KEPT — `tasks/{courseTaskId(runId, weekNumber, uid)}`
 *    still exists, so the re-mirror's `.create()` fails ALREADY_EXISTS, is
 *    counted `alreadyPresent`, and NOTHING is overwritten. A true no-op.
 *  · a card the member DISMISSED — dismissal is a DELETE (the rules let a
 *    member remove their own mirror), so that document is gone and the
 *    re-mirror recreates it when the group next reaches that week. Stated
 *    plainly rather than glossed: this is the one behaviour the reset changes,
 *    it is bounded to the weeks between the new anchor and the old mark, and it
 *    is the correct reading of a facilitator rewinding their group's schedule.
 *    Suppressing it would need a per-member record of WHICH weeks were
 *    dismissed, which the data model deliberately does not keep.
 *
 * Bounded by GROUP SIZE (`MAX_GROUP_MEMBERS`), inside the same transaction as
 * the pace write so a group can never be left re-paced with its members' marks
 * still describing the old calendar.
 */

/** Same one-path-segment guard as the sibling group routes. */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

const WEEK_ID = /^w[0-9][0-9]$/;

/** Break labels are display text on a calendar row; cap them like a name. */
const MAX_BREAK_LABEL = 80;

/**
 * Ceiling on the mirror-mark reset (see the header). A facilitated group is
 * small by design — the group email and notice lanes refuse above 100 — and a
 * Firestore transaction admits 500 writes, so this leaves a wide margin. A
 * group somehow past it gets a truncated repair and a logged warning rather
 * than a failed pace change: the calendar edit is the thing the facilitator
 * asked for, and the mark reset is a repair that the next pace change repeats.
 */
const MAX_GROUP_MEMBERS = 200;

class PaceRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaceRefusedError";
  }
}

/**
 * Taught week numbers of a plan, deduplicated and range-checked — the
 * attendance route's `taughtWeeksOf` discipline, duplicated per route by
 * house convention.
 */
function taughtNumbersOf(weekPlan: WeekPlanEntry[]): Set<number> {
  const out = new Set<number>();
  for (const entry of weekPlan) {
    if (entry.kind !== "week") continue;
    const n = entry.weekNumber;
    if (!Number.isInteger(n) || n < 1 || n > 60) continue;
    out.add(n);
  }
  return out;
}

/**
 * Strict validation for an incoming plan. Returns an error sentence or null.
 * `sanitizeWeekPlan` first (the run's own sanitiser, per the pinned
 * contract), then the checks it deliberately leaves to callers.
 */
function weekPlanError(raw: unknown[]): string | null {
  if (raw.length > COURSE_FIELD_LIMITS.maxWeekPlanEntries) {
    return `A plan holds at most ${COURSE_FIELD_LIMITS.maxWeekPlanEntries} slots.`;
  }
  const plan = sanitizeWeekPlan(raw);
  if (plan.length !== raw.length) return "One or more plan entries are malformed.";
  const seen = new Set<number>();
  for (const entry of plan) {
    if (entry.kind === "break") {
      if (!entry.label.trim()) return "Break slots need a label.";
      if (entry.label.length > MAX_BREAK_LABEL) {
        return `Break labels must be ${MAX_BREAK_LABEL} characters or fewer.`;
      }
      continue;
    }
    if (!Number.isInteger(entry.weekNumber) || entry.weekNumber < 1 || entry.weekNumber > 60) {
      return "Week numbers must be whole numbers from 1 to 60.";
    }
    if (seen.has(entry.weekNumber)) {
      return `Week ${entry.weekNumber} appears twice in the plan.`;
    }
    seen.add(entry.weekNumber);
    if (!WEEK_ID.test(entry.weekId)) {
      return "Week entries must reference a week id like \"w03\".";
    }
  }
  return null;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE, before the body is parsed (see header).
  const groupRef = db.collection("courseGroups").doc(groupId);
  const groupSnap = await groupRef.get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

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
  const runId = group.runId;

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  }

  const hasStart = "paceStartDate" in body;
  const hasPlan = "paceWeekPlan" in body;
  if (!hasStart && !hasPlan) {
    return NextResponse.json(
      { error: "Send paceStartDate, paceWeekPlan, or both." },
      { status: 400 },
    );
  }
  for (const key of Object.keys(body)) {
    if (key !== "paceStartDate" && key !== "paceWeekPlan") {
      return NextResponse.json({ error: `Unknown field "${key}".` }, { status: 400 });
    }
  }

  let nextStart: string | null = null;
  if (hasStart) {
    if (body.paceStartDate === null) {
      nextStart = null;
    } else if (
      typeof body.paceStartDate === "string" &&
      isValidDateKey(body.paceStartDate)
    ) {
      nextStart = body.paceStartDate;
    } else {
      return NextResponse.json(
        { error: "paceStartDate must be a real YYYY-MM-DD date, or null to track the run." },
        { status: 400 },
      );
    }
  }

  let nextPlan: WeekPlanEntry[] | null = null;
  if (hasPlan) {
    if (body.paceWeekPlan === null) {
      nextPlan = null;
    } else if (Array.isArray(body.paceWeekPlan)) {
      const err = weekPlanError(body.paceWeekPlan);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      nextPlan = sanitizeWeekPlan(body.paceWeekPlan);
    } else {
      return NextResponse.json(
        { error: "paceWeekPlan must be a plan, or null to track the run." },
        { status: 400 },
      );
    }
  }

  let effective;
  let rewound = 0;
  try {
    const result = await db.runTransaction(async (tx) => {
      // ---- READS. Every one of them, before the write. --------------------
      const [freshGroupSnap, runSnap, registersSnap, enrolmentsSnap] =
        await Promise.all([
          tx.get(groupRef),
          tx.get(db.collection("courseRuns").doc(runId)),
          tx.get(
            db
              .collection("courseAttendance")
              .where("runId", "==", runId)
              .where("groupId", "==", groupId),
          ),
          // The group's ACTIVE members, for the mirror-mark reset below —
          // exactly the (runId, groupId, status) composite the roster and
          // review-queue routes already use, so no new index.
          tx.get(
            db
              .collection("courseEnrolments")
              .where("runId", "==", runId)
              .where("groupId", "==", groupId)
              .where("status", "==", "active")
              .limit(MAX_GROUP_MEMBERS),
          ),
        ]);
      if (!freshGroupSnap.exists) {
        throw new PaceRefusedError("Group not found", 404);
      }
      if (!runSnap.exists) {
        throw new PaceRefusedError("This group's run no longer exists.", 409);
      }
      const fresh = normalizeCourseGroup(freshGroupSnap.id, freshGroupSnap.data() ?? {});
      const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

      const nextPace = {
        paceStartDate: hasStart ? nextStart : fresh.paceStartDate,
        paceWeekPlan: hasPlan ? nextPlan : fresh.paceWeekPlan,
      };

      // THE STRAND GATE (see header). Old vs new EFFECTIVE plan, both through
      // the one resolver; only newly-vanishing MARKED weeks refuse.
      const oldTaught = taughtNumbersOf(resolveCalendar(run, fresh).weekPlan);
      const newTaught = taughtNumbersOf(resolveCalendar(run, nextPace).weekPlan);
      const stranded: Array<{ weekNumber: number; marks: number }> = [];
      for (const doc of registersSnap.docs) {
        const register = normalizeCourseAttendance(doc.id, doc.data() ?? {});
        const marks = Object.keys(register.records).length;
        if (marks === 0) continue;
        if (!oldTaught.has(register.weekNumber)) continue; // already orphaned
        if (newTaught.has(register.weekNumber)) continue;
        stranded.push({ weekNumber: register.weekNumber, marks });
      }
      if (stranded.length > 0) {
        stranded.sort((a, b) => a.weekNumber - b.weekNumber);
        const weeks = stranded.map((s) => s.weekNumber).join(", ");
        throw new PaceRefusedError(
          `That plan removes taught week${stranded.length === 1 ? "" : "s"} ${weeks}, whose attendance register${stranded.length === 1 ? " already carries" : "s already carry"} marks. Keep ${stranded.length === 1 ? "that week" : "those weeks"} in the plan — nothing was changed.`,
          409,
          { strandedWeeks: stranded },
        );
      }

      // THE MIRROR WINDOW (see the header). Computed BEFORE the first write,
      // like everything else in this callback — `memberCurrentWeek` is pure,
      // but its inputs are the reads above and the ordering has to stay
      // obvious to the next person adding a step here.
      //
      // A calendar with no usable start date resolves no anchor at all, and
      // `sync-tasks` refuses to mirror against one — so there is nothing
      // stranded to repair and the marks are left exactly as they stand rather
      // than being reset to a number this route cannot compute.
      const nextCalendar = resolveCalendar(run, nextPace);
      const nextAnchor = isValidDateKey(nextCalendar.startDate)
        ? memberCurrentWeek(run, nextPace).anchorWeekNumber
        : null;
      // ONE BELOW the new anchor, and the −1 is the whole repair (see the
      // header). `sync-tasks` short-circuits on `mark >= weekNumber`, so a mark
      // reset TO the anchor skips the anchor week itself — the very week the
      // group has just been rewound onto, and the one week of the re-lived term
      // most likely never to have been delivered (a group paced ahead to week 8
      // had week 8 mirrored, never weeks 3-7). Clamped at 0, the absent-mark
      // default, so a rewind to week 1 delivers week 1.
      const resetMark = nextAnchor === null ? null : Math.max(0, nextAnchor - 1);
      const rewinds =
        nextAnchor === null
          ? []
          : enrolmentsSnap.docs.filter((doc) => {
              const enrolment = normalizeCourseEnrolment(doc.id, doc.data() ?? {});
              // DOWN ONLY. A mark at or below the new anchor belongs to a
              // member who has not been over-delivered, and raising it would
              // swallow the weeks they are still owed.
              return (enrolment.lastTaskSyncedWeek ?? 0) > nextAnchor;
            });
      if (enrolmentsSnap.size >= MAX_GROUP_MEMBERS) {
        console.warn(
          "[courses group pace] member page full — mirror marks reset only for the first",
          MAX_GROUP_MEMBERS,
          groupId,
        );
      }

      // ---- WRITES. Nothing above this line may follow one. ----------------
      // Real nulls when clearing — see the header.
      const update: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (hasStart) update.paceStartDate = nextStart;
      if (hasPlan) update.paceWeekPlan = nextPlan;
      tx.update(groupRef, update);

      for (const doc of rewinds) {
        // ONLY the mark. `updatedAt` on an enrolment means "this placement
        // changed" and a pace change moves nobody's placement — the sync route
        // declines to bump it for the same reason.
        tx.update(doc.ref, { lastTaskSyncedWeek: resetMark });
      }

      return { calendar: nextCalendar, rewound: rewinds.length };
    });
    effective = result.calendar;
    rewound = result.rewound;
  } catch (err) {
    if (err instanceof PaceRefusedError) {
      return NextResponse.json(
        { error: err.message, ...err.detail },
        { status: err.status },
      );
    }
    console.error("[courses group pace] transaction failed", groupId, err);
    return NextResponse.json(
      { error: "That change didn't go through — nothing was changed." },
      { status: 500 },
    );
  }

  // The receipt: the calendar this group's members are NOW paced by, from
  // the same resolver every consumer reads — `source: "run"` here means the
  // clear landed and the group tracks the run again.
  //
  // `mirrorsReopened` is how many members' task-mirror marks were wound back
  // (see the header). Zero on the ordinary forward re-pace; non-zero says
  // "these people are owed their weekly cards again", which is a fact worth
  // being able to see rather than infer.
  return NextResponse.json({
    ok: true,
    startDate: effective.startDate,
    weekPlan: effective.weekPlan,
    source: effective.source,
    mirrorsReopened: rewound,
  });
}

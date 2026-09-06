/**
 * Rules tests for THE SCHEDULE ITSELF — who may move a run's dates, its week
 * plan and its status client-direct, and what the rules do NOT check when they
 * do.
 *
 * `courses.test.mjs` covers write AUTHORISATION for the courses feature. This
 * file covers the narrower question a schedule-change audit raised: the run's
 * `startDate` and `weekPlan` are the two fields every derived week number,
 * every attendance column, every nudge slot key and every mirrored task id are
 * computed from — and they are **client-writable by a track lead**, with no
 * server route in the path. So whatever the rules check about them is the only
 * thing checked at all.
 *
 * Two kinds of test in here, following `candidate-findings.test.mjs`:
 *
 *  - **GUARD** — a property the rules really hold. Loosen the rule and it
 *    goes red.
 *  - **PROVEN GAP** — the audit found a hole. These assert the hole is STILL
 *    THERE, so they fail the day someone closes it. **When you fix one, invert
 *    the assertion in the same commit** — and note that two of the three below
 *    are arguably NOT rules bugs, because the rules cannot express the check.
 *    Each says which.
 *
 * Namespace: `courses-schedule` (see `getTestEnv` — one project id per file, or
 * a parallel file's `clearFirestore()` wipes these fixtures mid-test).
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  asUser,
  assertFails,
  assertSucceeds,
  cleanup,
  clearData,
  getTestEnv,
  seed,
  seedUser,
} from "../lib/harness.mjs";

before(async () => {
  await getTestEnv("courses-schedule");
});
after(cleanup);
afterEach(clearData);

const ZERO_COUNTS = {
  pending: 0,
  accepted: 0,
  rejected: 0,
  waitlisted: 0,
  withdrawn: 0,
};

/** Eight taught weeks, the shape `WeekPlanBuilder` saves. */
const WEEK_PLAN = Array.from({ length: 8 }, (_, i) => ({
  kind: "week",
  weekNumber: i + 1,
  weekId: `w0${i + 1}`,
}));

function runDoc(id, overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "running",
    startDate: "2026-09-28",
    weekPlan: WEEK_PLAN,
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    authorUid: "drafter",
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: ["lead"],
    applicationCounts: { ...ZERO_COUNTS, pending: 3, accepted: 12 },
    groupCount: 2,
    channel: `cohort:${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("lead", { role: "member" });
  await seedUser("learner", { role: "member" });
  await seedUser("outsider", { role: "member", permissions: { draftCourse: true } });
}

async function seedRun(id, overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseRuns").doc(id).set(runDoc(id, overrides));
  });
}

async function seedEnrolment(runId, uid, overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseEnrolments").doc(`${runId}__${uid}`).set({
      runId,
      courseId: "course1",
      uid,
      groupId: "grp1",
      status: "active",
      role: "learner",
      applicationId: null,
      joinedWeekNumber: 1,
      createdAt: new Date(),
      ...overrides,
    });
  });
}

function progressDoc(overrides = {}) {
  return {
    runId: "run1",
    uid: "learner",
    weekNumber: 3,
    itemKind: "material",
    itemId: "m1",
    completed: true,
    completedAt: new Date(),
    hasPublicComment: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The schedule is a CLIENT WRITE
// ---------------------------------------------------------------------------

describe("courseRuns — who may move the calendar", () => {
  /** The plan with a reading week dropped in after week 1: the everyday edit. */
  const RESHAPED_PLAN = [
    WEEK_PLAN[0],
    { kind: "break", label: "Reading week" },
    ...WEEK_PLAN.slice(1),
  ];

  it("GUARD — a run track lead may reschedule the cohort client-direct", async () => {
    // Not a finding, a PREMISE: every downstream drift in the schedule-change
    // audit starts with this write, and it needs no server route. It is
    // deliberate (a lead moves a cohort's dates mid-term), but it means the
    // rules are the ONLY validation `startDate` ever gets.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("lead");
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ startDate: "2026-10-12" }),
    );
  });

  it("GUARD: the week plan is reshapeable by the run's cast while it is a DRAFT", async () => {
    // The authoring state, and the other half of the lock below. Nobody is
    // enrolled, no register exists, no task has been mirrored, so renumbering
    // the plan repoints nothing, which is exactly why the boundary is drawn
    // at draft and not earlier.
    await seedCast();
    await seedRun("run1", { status: "draft" });
    for (const uid of ["lead", "drafter", "approver"]) {
      const db = await asUser(uid);
      await assertSucceeds(
        db.collection("courseRuns").doc("run1").update({ weekPlan: RESHAPED_PLAN }),
      );
    }
  });

  it("GUARD: the week plan is PINNED to non-admins the moment a run leaves draft", async () => {
    // `weekPlan` is the calendar spine: the Nth taught entry IS week N, and
    // every member-facing surface addresses that week as
    // `weekDocId(weekNumber)`. Reordering or removing a slot on a live run
    // renumbers every entry after it, so a cohort's /learn/{run}/weeks/{n}
    // silently resolves a different document than the one the admin arranged,
    // and the registers, mirrored tasks and exercise responses keyed on the
    // old numbering strand.
    for (const status of [
      "applications-open",
      "applications-closed",
      "running",
      "completed",
      "cancelled",
    ]) {
      await seedCast();
      await seedRun("run1", { status });
      for (const uid of ["lead", "drafter", "approver"]) {
        const db = await asUser(uid);
        await assertFails(
          db.collection("courseRuns").doc("run1").update({ weekPlan: RESHAPED_PLAN }),
        );
      }
      // Not a blanket freeze on the run: the SAME actor may still move the
      // dates, which is the mid-term edit the lock is not trying to stop.
      const lead = await asUser("lead");
      await assertSucceeds(
        lead.collection("courseRuns").doc("run1").update({ startDate: "2026-10-12" }),
      );
      // …and re-sending the plan UNCHANGED still passes, so a section save
      // that always includes the field is not wedged by the pin.
      await assertSucceeds(
        lead.collection("courseRuns").doc("run1").update({ weekPlan: WEEK_PLAN }),
      );
      await clearData();
    }
  });

  it("GUARD: one write cannot both leave draft AND reshape the plan", async () => {
    // The pin used to read only the PRE-write status, so a draft run was still
    // a draft at the moment the rule looked at it. An approver could therefore
    // set status to 'applications-open' and reshape the week plan in the SAME
    // update: the run left draft, and the plan the pin protects for the rest of
    // the cohort's life was the reshaped one nothing ever checked.
    await seedCast();
    await seedRun("run1", { status: "draft" });
    const db = await asUser("approver");
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run1")
        .update({ status: "applications-open", weekPlan: RESHAPED_PLAN }),
    );

    // Neither half is forbidden on its own. The status may move...
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ status: "applications-open" }),
    );
    // ...and a section save that always includes the field still passes while
    // it re-sends the plan verbatim, which is the disjunct that carve-out is
    // for. (Re-seeded as a draft first: the two halves are being tested apart.)
    await clearData();
    await seedCast();
    await seedRun("run1", { status: "draft" });
    const again = await asUser("approver");
    await assertSucceeds(
      again
        .collection("courseRuns")
        .doc("run1")
        .update({ status: "applications-open", weekPlan: WEEK_PLAN }),
    );
  });

  it("GUARD: an ADMIN can still reshape a live run's plan, and owns the consequences", async () => {
    // The carve-out, matching every other pin in this block: admins ride the
    // unconditional branch. Adding a slot to a live run shifts every later
    // date, so it is a change that belongs to the person accountable for it
    // rather than one to forbid outright.
    await seedCast();
    await seedRun("run1", { status: "running" });
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ weekPlan: RESHAPED_PLAN }),
    );
  });

  it("GUARD — a track lead still may not move the status, or the server-owned fields", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("lead");
    await assertFails(db.collection("courseRuns").doc("run1").update({ status: "completed" }));
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run1")
        .update({ applicationCounts: { ...ZERO_COUNTS, accepted: 99 } }),
    );
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ trackLeadUids: ["lead", "learner"] }),
    );
  });

  it("GUARD — nobody outside the run's own cast may touch the schedule", async () => {
    await seedCast();
    await seedRun("run1");
    for (const uid of ["learner", "outsider"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ startDate: "2026-10-12" }),
      );
    }
  });

  it("GUARD — the week plan cannot be grown past the 60-slot ceiling", async () => {
    // The cap the week-number bounds everywhere else assume (MAX_WEEK_NUMBER,
    // `weekDocId` zero-padding, the attendance column filter).
    await seedCast();
    // A DRAFT run: the ceiling is a content cap, and the week-plan lock above
    // would otherwise refuse both of these writes for an unrelated reason.
    await seedRun("run1", { status: "draft" });
    const db = await asUser("lead");
    const tooMany = Array.from({ length: 61 }, (_, i) => ({
      kind: "week",
      weekNumber: i + 1,
      weekId: `w${String(i + 1).padStart(2, "0")}`,
    }));
    await assertFails(db.collection("courseRuns").doc("run1").update({ weekPlan: tooMany }));
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ weekPlan: tooMany.slice(0, 60) }),
    );
  });

  it("GUARD — a malformed startDate is refused on the UPDATE path too", async () => {
    // `courses.test.mjs` pins the create path. Rescheduling is the update path,
    // and it is the one a lead actually uses.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("lead");
    for (const bad of ["05/10/2026", "2026-10", "", "next Monday"]) {
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ startDate: bad }),
      );
    }
  });

  it("GUARD: an IMPOSSIBLE date is the NORMALISER's job, and the rules stay out of it", async () => {
    // Was a PROVEN GAP until 2026-09-02, and it is green for the same reason it
    // always was: `runContentOk` checks the SHAPE with a regex, and
    // `2026-02-31` is the right shape and is not a day, so the write lands.
    //
    // THIS IS NOT A RULES BUG AND MUST NOT BE FIXED HERE. Firestore rules have
    // no date arithmetic, so the regex is the strongest check this layer can
    // make; a rule enumerating month lengths would still miss leap years.
    // The fix lives in `asCivilDate` (src/lib/firestore/courses.ts), which now
    // calls `isValidDateKey`, so an impossible date READS BACK as "" and
    // behaves exactly like an unset one at every consumer. Its sibling in
    // `tests/course-schedule-changes.test.mjs` pins that half.
    //
    // The test survives the fix as the pin on the division of labour: if
    // someone later tries to express the check here, these writes start failing
    // and this comment explains why they should not have.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("lead");
    for (const impossible of ["2026-02-31", "2026-13-01", "2026-00-10", "9999-99-99"]) {
      await assertSucceeds(
        db.collection("courseRuns").doc("run1").update({ startDate: impossible }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The status lifecycle exists in ONE place, and it is not this one
// ---------------------------------------------------------------------------

describe("courseRuns: the status transition table lives in the rules too", () => {
  it("GUARD: an approver can no longer walk a run BACKWARDS, or out of a terminal state", async () => {
    // WAS A PROVEN GAP until V3 W1 PR5. The rules carried no table at all, so
    // `canApproveCourse()` could write any status value, and that mattered
    // because the WEEK-PLAN FREEZE is keyed on the status: an approver could
    // walk a live run back to `draft`, reshape the frozen plan, and walk it
    // forward again. Three writes, no route, and the freeze was defeated.
    //
    // `runStatusMoveAllowed()` in firestore.rules now mirrors
    // src/lib/courses/runStatus.ts exactly. KEEP THE TWO IN STEP: the rules
    // half is the one that decides, and a table edited in only one place
    // leaves the dropdown offering a move the database refuses.
    await seedCast();
    await seedRun("run1", { status: "running" });
    const approver = await asUser("approver");
    await assertFails(
      approver.collection("courseRuns").doc("run1").update({ status: "draft" }),
    );
    // Forward is still fine, and so is cancelling.
    await assertSucceeds(
      approver.collection("courseRuns").doc("run1").update({ status: "completed" }),
    );

    await clearData();
    await seedCast();
    await seedRun("run2", { status: "completed", trackLeadUids: ["lead"] });
    const db = await asUser("approver");
    // `completed` is documented as terminal precisely because un-completing it
    // "would silently re-arm every date-driven surface that reads the status".
    await assertFails(
      db.collection("courseRuns").doc("run2").update({ status: "running" }),
    );
    await assertFails(
      db.collection("courseRuns").doc("run2").update({ status: "cancelled" }),
    );
  });

  it("GUARD: the whole table, walked; every legal move passes and every other one does not", async () => {
    // The table, restated so a rules edit that quietly drops an arrow fails
    // here rather than in October.
    const TABLE = {
      draft: ["applications-open", "cancelled"],
      // `running` reachable straight from `applications-open` is the OPEN
      // ENROLMENT entry: a pre-course keeps its sign-ups open into its first
      // teaching weeks and has no review stage to close.
      "applications-open": ["applications-closed", "running", "cancelled"],
      "applications-closed": ["running", "cancelled"],
      running: ["completed", "cancelled"],
      completed: [],
      cancelled: [],
    };
    const ALL = Object.keys(TABLE);

    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;
        await clearData();
        await seedCast();
        await seedRun("run1", { status: from });
        const db = await asUser("approver");
        const write = db.collection("courseRuns").doc("run1").update({ status: to });
        if (TABLE[from].includes(to)) {
          await assertSucceeds(write);
        } else {
          await assertFails(write);
        }
      }
    }
  });

  it("GUARD: re-sending the SAME status is always legal, whatever the run is", async () => {
    // An ordinary content save re-sends the status it already had. The table
    // must not refuse those, including on a terminal run being archived or
    // relabelled by its own approver.
    await seedCast();
    await seedRun("run1", { status: "completed" });
    const db = await asUser("approver");
    await assertSucceeds(
      db
        .collection("courseRuns")
        .doc("run1")
        .update({ status: "completed", label: "Autumn 2026 (final)" }),
    );
  });

  it("GUARD: a run carrying a status outside the union is FROZEN, not erroring", async () => {
    // `.get(key, [])` on the table literal rather than `[key]`, so a
    // hand-edited doc (or one written before a rename) denies its status moves
    // instead of erroring every update on the branch. The label edit proves
    // the branch still evaluates rather than blowing up.
    await seedCast();
    await seedRun("run1", { status: "archived" });
    const db = await asUser("approver");
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ status: "running" }),
    );
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ label: "Still editable" }),
    );
  });

  it("ADMINS ride their own branch, and can still drift the counters", async () => {
    // Unchanged and deliberate, matching every other pin in the courseRuns
    // block. It costs nothing: an admin already holds unconditional update on
    // runs INCLUDING `weekPlan` itself, so denying them the backwards move
    // would protect nothing they cannot do directly. The actor the table
    // exists to bound is the approver.
    //
    // The counter half is still a PROVEN GAP and is still worth its own line:
    // `applicationCounts` moves only as relative increments inside the apply
    // and decide transactions, and no recount pass exists anywhere, so a
    // direct write is unreconcilable.
    await seedCast();
    await seedRun("run1", { status: "running" });
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({
        status: "applications-open",
        applicationCounts: { ...ZERO_COUNTS, accepted: 999 },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// A finished run is not read-only
// ---------------------------------------------------------------------------

describe("courseProgress — the run's status is invisible to the write gate", () => {
  it("GUARD — an ACTIVE enrolment is what grants the pen, and losing it revokes instantly", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    await seedRun("run1");
    const db = await asUser("learner");
    await assertSucceeds(
      db.collection("courseProgress").doc("run1__learner__m1").set(progressDoc()),
    );

    for (const status of ["removed", "withdrawn"]) {
      await seedEnrolment("run1", "learner", { status });
      const revoked = await asUser("learner");
      await assertFails(
        revoked
          .collection("courseProgress")
          .doc("run1__learner__m2")
          .set(progressDoc({ itemId: "m2" })),
      );
    }
  });

  it("PROVEN GAP — a COMPLETED or CANCELLED run stays fully writable by its members", async () => {
    // The overview route and `runAccess.ts` both state that a completed run is
    // "read-only by construction", and both mean it: they gate the check-off
    // path on an ACTIVE enrolment. But nothing anywhere ever writes
    // `status: "completed"` or `"withdrawn"` onto a `courseEnrolments` row —
    // the only writers are allocate ("active"), remove ("removed") and the
    // facilitators route. So every enrolment stays `active` forever, and
    // `isEnrolledActive(runId)` reads the ENROLMENT, never the run.
    //
    // Two of the four declared ENROLMENT_STATUSES are unreachable, and every
    // behaviour documented as keying off them is dead code.
    await seedCast();
    await seedEnrolment("run1", "learner");
    for (const status of ["completed", "cancelled"]) {
      await seedRun("run1", { status });
      const db = await asUser("learner");
      await assertSucceeds(
        db
          .collection("courseProgress")
          .doc(`run1__learner__m-${status}`)
          .set(progressDoc({ itemId: `m-${status}` })),
      );
    }

    // WHEN YOU FIX THIS: do NOT add a run `get()` to `progressShapeOk`.
    // `isEnrolledActive` is already two document accesses, the courses suite
    // pins a 25-doc list regression against exactly this class of change, and
    // the rules access budget is ~20 per request. The fix is that completing a
    // run should settle its enrolments — which makes the existing gate correct
    // rather than adding a second one.
  });
});

// ---------------------------------------------------------------------------
// Why an orphaned register cannot be repaired
// ---------------------------------------------------------------------------

describe("courseAttendance — no client repair path exists", () => {
  it("GUARD — the register is server-routed for everyone, admins included", async () => {
    // This is what makes an orphaned register (a week removed from the plan
    // after it was marked) PERMANENT rather than merely awkward: the route
    // refuses to write a non-taught week, and there is no second door.
    await seedCast();
    await seed(async (db) => {
      await db.collection("courseAttendance").doc("run1__grp1__w08").set({
        runId: "run1",
        groupId: "grp1",
        weekNumber: 8,
        records: { learner: "present" },
        markedByUid: "lead",
        updatedAt: new Date(),
      });
    });

    for (const uid of ["admin1", "approver", "lead", "learner"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseAttendance").doc("run1__grp1__w08").get());
      await assertFails(
        db.collection("courseAttendance").doc("run1__grp1__w08").update({ records: {} }),
      );
      await assertFails(db.collection("courseAttendance").doc("run1__grp1__w08").delete());
    }
  });
});

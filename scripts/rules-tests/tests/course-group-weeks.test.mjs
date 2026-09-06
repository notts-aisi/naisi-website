/**
 * Rules tests for V2-3's copy-on-write surface — the group week forks
 * (`courseGroups/{groupId}/weeks/{wNN}`) and the NEW server-owned pins on the
 * group doc (`paceStartDate`, `paceWeekPlan`, each override's `mode`).
 *
 * The properties that must hold:
 *  - Forked weeks are readable by any signed-in account (they carry
 *    curriculum, not the meet link — parity with run weeks) and writable by
 *    NOBODY client-side, admins included: the facilitator trust boundary
 *    (guideBlocks) and the delete-warning counts are route work, so the fork
 *    and PATCH routes are the only doors (the courseAttendance stance).
 *  - The pace fields are server-owned like `memberCount`: no non-admin lane
 *    (facilitator, approver, parent-run track lead) can set, change or clear
 *    them; a group cannot be CREATED carrying them; the admin client lane
 *    bypasses the pin exactly as it does for `memberCount`.
 *  - The `sessionModes` map (the stored form of each week's virtual/in-person
 *    mode) is server-owned the same way, while the sessionOverrides map stays
 *    facilitator-editable — one whole-map pin, mutation-checked here from
 *    every angle: set, change, clear, and the benign edit that must keep
 *    working. (A `mode` smuggled INTO a sessionOverrides value is allowed
 *    through as DEAD DATA — the normaliser never reads it; the unit suite
 *    `tests/course-group-resolve.test.mjs` pins that half.)
 *
 * Every pin test is paired with the nearby write that must SUCCEED, so a pin
 * that over-tightens (wedging legitimate session edits) fails here too.
 *
 * Namespace: `course-group-weeks` (see `getTestEnv` — one project id per
 * file, or a parallel file's `clearFirestore()` wipes these fixtures).
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  asAnon,
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
  await getTestEnv("course-group-weeks");
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

/** Seed the cast: one of each hat these rules distinguish. */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("learner", { role: "member" });
  await seedUser("facil", { role: "member" });
  await seedUser("lead", { role: "member" });
  await seedUser("pending1", { role: "pending" });
}

function runDoc(id, overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "running",
    startDate: "2026-09-28",
    weekPlan: [],
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    authorUid: "drafter",
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: { ...ZERO_COUNTS },
    groupCount: 1,
    channel: `cohort:${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function groupDoc(overrides = {}) {
  return {
    runId: "run1",
    courseId: "course1",
    name: "Group A",
    facilitatorUids: [],
    capacity: 12,
    memberCount: 0,
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Monica Partridge Building",
      meetingUrl: null,
      notes: "",
    },
    sessionOverrides: {},
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A forked week as the fork route writes it — id-preserving copy + stamp. */
function forkedWeekDoc(overrides = {}) {
  return {
    weekNumber: 3,
    title: "Goal misgeneralisation",
    summary: "Why a system that learned the right thing can pursue the wrong one.",
    guideBlocks: [],
    materials: [{ id: "m1", type: "reading", title: "Ngo et al.", url: "https://example.com/paper" }],
    exercises: [],
    checklist: [],
    estimatedMinutes: 90,
    published: true,
    forkedAt: new Date(),
    forkedByUid: "facil",
    forkedFromRunWeekAt: null,
    updatedAt: new Date(),
    updatedByUid: "facil",
    ...overrides,
  };
}

async function seedGroup(overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseRuns").doc("run1").set(runDoc("run1"));
    await db.collection("courseGroups").doc("g1").set(groupDoc(overrides));
  });
}

async function seedFork(overrides = {}) {
  await seed(async (db) => {
    await db
      .collection("courseGroups")
      .doc("g1")
      .collection("weeks")
      .doc("w03")
      .set(forkedWeekDoc(overrides));
  });
}

const forkRef = (db) =>
  db.collection("courseGroups").doc("g1").collection("weeks").doc("w03");

// ---------------------------------------------------------------------------
// The forked weeks subcollection
// ---------------------------------------------------------------------------

describe("courseGroups/{id}/weeks — the copy-on-write forks", () => {
  it("GUARD — any signed-in account reads a fork; signed-out does not", async () => {
    // Parity with run weeks (`allow read: if isSignedIn()`): a fork is
    // curriculum, and the group doc's restricted read (it carries the meet
    // link) deliberately does NOT extend down here. Pending users are signed
    // in, so they read forks exactly as they already read run weeks.
    await seedCast();
    await seedGroup();
    await seedFork();
    for (const uid of ["learner", "facil", "pending1", "admin1"]) {
      await assertSucceeds(forkRef(await asUser(uid)).get());
    }
    await assertFails(forkRef(await asAnon()).get());
  });

  it("GUARD — no client write to a fork, admin and facilitator included", async () => {
    // The fork POST and week PATCH routes are the ONLY doors: the trust
    // boundary (guideBlocks) and the delete-warning counts are cross-document
    // checks a rule cannot express, so the client pen does not exist at all.
    await seedCast();
    await seedGroup({ facilitatorUids: ["facil"] });
    await seedFork();
    for (const uid of ["learner", "facil", "approver", "admin1"]) {
      const db = await asUser(uid);
      await assertFails(forkRef(db).update({ title: "Rewritten" }));
      await assertFails(forkRef(db).delete());
      await assertFails(
        db
          .collection("courseGroups")
          .doc("g1")
          .collection("weeks")
          .doc("w04")
          .set(forkedWeekDoc({ weekNumber: 4 })),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The group doc's new server-owned pins
// ---------------------------------------------------------------------------

describe("courseGroups — pace fields are server-owned (routes only)", () => {
  it("GUARD — a facilitator cannot set, change or clear the pace fields", async () => {
    await seedCast();
    await seedGroup({ facilitatorUids: ["facil"] });
    const db = await asUser("facil");
    await assertFails(
      db.collection("courseGroups").doc("g1").update({ paceStartDate: "2026-10-12" }),
    );
    await assertFails(
      db.collection("courseGroups").doc("g1").update({
        paceWeekPlan: [{ kind: "week", weekNumber: 1, weekId: "w01" }],
      }),
    );

    // CLEARING is a change too: a stored pace can only go back to null
    // through the pace route (which runs the strand gate).
    await clearData();
    await seedCast();
    await seedGroup({ facilitatorUids: ["facil"], paceStartDate: "2026-10-12" });
    const again = await asUser("facil");
    await assertFails(
      again.collection("courseGroups").doc("g1").update({ paceStartDate: null }),
    );
    // …while an ordinary session edit on that same re-paced group still
    // lands: the pin compares the merged doc, so untouched pace rides along.
    await assertSucceeds(
      again.collection("courseGroups").doc("g1").update({ name: "Group A (Tue)" }),
    );
  });

  it("GUARD — the approver and track-lead lanes are pinned the same way", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courseRuns").doc("run1").set(runDoc("run1", { trackLeadUids: ["lead"] }));
      await db.collection("courseGroups").doc("g1").set(groupDoc());
    });
    await assertFails(
      (await asUser("approver"))
        .collection("courseGroups")
        .doc("g1")
        .update({ paceWeekPlan: [] }),
    );
    await assertFails(
      (await asUser("lead"))
        .collection("courseGroups")
        .doc("g1")
        .update({ paceStartDate: "2026-10-12" }),
    );
  });

  it("GUARD — the admin client lane bypasses the pin (the memberCount precedent)", async () => {
    // `allow update: if isAdmin() || …` — admins ride their own branch, same
    // as every other server-owned field on this doc. Pinned so a future
    // tightening that would strand console repairs shows up here.
    await seedCast();
    await seedGroup();
    await assertSucceeds(
      (await asUser("admin1"))
        .collection("courseGroups")
        .doc("g1")
        .update({ paceStartDate: "2026-10-12" }),
    );
  });

  it("GUARD — a group cannot be BORN carrying pace overrides or modes", async () => {
    // The courseRuns templateId birth-pin precedent: update-only pins are
    // circumventable at create, so create refuses the fields outright.
    await seedCast();
    const db = await asUser("approver");
    await assertFails(
      db.collection("courseGroups").doc("g2").set(groupDoc({ paceStartDate: "2026-10-05" })),
    );
    await assertFails(
      db.collection("courseGroups").doc("g3").set(groupDoc({ paceWeekPlan: [] })),
    );
    await assertFails(
      db
        .collection("courseGroups")
        .doc("g4")
        .set(groupDoc({ sessionModes: { w03: "virtual" } })),
    );
    // …and the clean create, override included, still lands.
    await assertSucceeds(
      db
        .collection("courseGroups")
        .doc("g5")
        .set(groupDoc({ sessionOverrides: { w03: { location: "B52" } } })),
    );
  });
});

describe("courseGroups — the sessionModes map is server-owned", () => {
  it("GUARD — a facilitator cannot SET, CHANGE or CLEAR a week's mode", async () => {
    await seedCast();
    await seedGroup({ facilitatorUids: ["facil"] });
    const db = await asUser("facil");
    // Set…
    await assertFails(
      db.collection("courseGroups").doc("g1").update({ sessionModes: { w03: "virtual" } }),
    );

    // …change, and clear, on a group whose mode is already stored.
    await clearData();
    await seedCast();
    await seedGroup({ facilitatorUids: ["facil"], sessionModes: { w03: "virtual" } });
    const again = await asUser("facil");
    await assertFails(
      again.collection("courseGroups").doc("g1").update({ sessionModes: { w03: "in-person" } }),
    );
    await assertFails(
      again.collection("courseGroups").doc("g1").update({ sessionModes: {} }),
    );
  });

  it("GUARD — the benign facilitator session edit still lands beside a stored mode", async () => {
    // The over-tightening check: the pin must not turn every re-rooming into
    // a route call. Editing sessionOverrides leaves sessionModes untouched in
    // the merged doc, so the whole-map comparison holds — including dropping
    // an override entry whose week carries a mode (the mode lives in ITS OWN
    // map and survives the drop).
    await seedCast();
    await seedGroup({
      facilitatorUids: ["facil"],
      sessionModes: { w03: "virtual" },
      sessionOverrides: { w03: { location: "Online" } },
    });
    const db = await asUser("facil");
    await assertSucceeds(
      db.collection("courseGroups").doc("g1").update({
        sessionOverrides: { w03: { location: "Teams, not Zoom" }, w05: { location: "B52" } },
      }),
    );
    await assertSucceeds(
      db.collection("courseGroups").doc("g1").update({ sessionOverrides: {} }),
    );
  });

  it("GUARD — admin may flip a mode client-side (memberCount parity)", async () => {
    await seedCast();
    await seedGroup({ sessionModes: { w03: "virtual" } });
    await assertSucceeds(
      (await asUser("admin1"))
        .collection("courseGroups")
        .doc("g1")
        .update({ sessionModes: { w03: "in-person" } }),
    );
  });
});

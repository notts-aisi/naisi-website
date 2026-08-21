/**
 * Rules tests for the courses feature — the owner's directive for this build
 * was STRONG rules provisioning with validated tests, so this suite is a
 * deliverable of the feature, not decoration.
 *
 * The properties that must hold, in rough order of blast radius:
 *  - `courseProgress` is the ONE client-direct member write, and its doc id
 *    binds (run, caller, item) structurally — no cross-uid rows, no writes
 *    without an ACTIVE enrolment, no lying about `hasPublicComment`, no
 *    fabricating or laundering moderation stamps.
 *  - `isEnrolledActive()` must never leak into a READ rule: a list query
 *    evaluates per candidate doc against the ~20-document access budget, so
 *    the 25-doc regression below fails the moment someone "tightens" the
 *    progress read rule with an enrolment get(). Do not fix that test —
 *    fix the rule.
 *  - Server-owned collections (applications, enrolments, attendance, nudges,
 *    exercise responses) refuse every client write, admin included.
 *  - `draftCourse` is authoring power only: no status transitions, no role
 *    arrays, no counters, no channel. `approveCourse` is the two-person half.
 *  - `courseGroups` carry meet links — readable only by the authoring tier.
 *  - `paidMembershipYears` is an admin-set badge; self-service create and
 *    update must both refuse it (same forgery class as tracks/permissions).
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
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
  await getTestEnv("courses");
});
after(cleanup);
afterEach(clearData);

/** A moderation instant used wherever a stamp must round-trip verbatim. */
const MODERATED_AT = new Date("2026-08-01T12:00:00Z");

const ZERO_COUNTS = {
  pending: 0,
  accepted: 0,
  rejected: 0,
  waitlisted: 0,
  withdrawn: 0,
};

/** Seed the cast: one of each hat the rules distinguish. */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("learner", { role: "member" });
  await seedUser("facil", { role: "member" });
  await seedUser("lead", { role: "member" });
  await seedUser("pending1", { role: "pending" });
}

/** A clean course doc as the drafter's client would write it. */
function courseDoc(overrides = {}) {
  return {
    title: "AI Safety Fundamentals",
    tagline: "An introduction to the field.",
    summaryBlocks: [],
    track: "technical",
    level: "No prior experience needed",
    estimatedWeeklyHours: null,
    status: "draft",
    showcaseRunId: null,
    authorUid: "drafter",
    collaboratorUids: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A clean run doc for `courseRuns/{id}` — channel must match the id. */
function runDoc(id, overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "draft",
    startDate: "2026-10-05",
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
    groupCount: 0,
    channel: `cohort:${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedRun(id, overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseRuns").doc(id).set(runDoc(id, overrides));
  });
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

/** Enrol `uid` on `runId` (rules disabled — enrolments are routes-only). */
async function seedEnrolment(runId, uid, overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseEnrolments").doc(`${runId}__${uid}`).set({
      runId,
      courseId: "course1",
      uid,
      groupId: null,
      status: "active",
      role: "learner",
      applicationId: null,
      joinedWeekNumber: 1,
      createdAt: new Date(),
      ...overrides,
    });
  });
}

/** The full progress payload buildProgressWrite() would emit. */
function progressDoc(overrides = {}) {
  return {
    runId: "run1",
    uid: "learner",
    weekNumber: 3,
    itemKind: "material",
    itemId: "m1",
    completed: true,
    completedAt: new Date(),
    rating: 5,
    publicComment: "Great intro paper.",
    hasPublicComment: true,
    privateNote: "Re-read section 4 before the session.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// courseProgress — the one client-direct member write
// ---------------------------------------------------------------------------

describe("courseProgress — enrolled member happy path", () => {
  it("lets an active enrolled member create and update their own row with rating + comments", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    const ref = db.collection("courseProgress").doc("run1__learner__m1");
    await assertSucceeds(ref.set(progressDoc()));
    // Re-save (the un-check path): optionals dropped, mirror consistent.
    await assertSucceeds(
      ref.set({
        runId: "run1",
        uid: "learner",
        weekNumber: 3,
        itemKind: "material",
        itemId: "m1",
        completed: false,
        hasPublicComment: false,
      }),
    );
  });

  it("lets a member check off a checklist item (the second itemKind)", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertSucceeds(
      db.collection("courseProgress").doc("run1__learner__c1").set({
        runId: "run1",
        uid: "learner",
        weekNumber: 1,
        itemKind: "checklist",
        itemId: "c1",
        completed: true,
        completedAt: new Date(),
        hasPublicComment: false,
      }),
    );
  });

  it("lets a member delete their own row", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    const ref = db.collection("courseProgress").doc("run1__learner__m1");
    await assertSucceeds(ref.set(progressDoc()));
    await assertSucceeds(ref.delete());
  });
});

describe("courseProgress — enrolment gate", () => {
  it("refuses a create from a member with NO enrolment on the run", async () => {
    await seedCast();
    const db = await asUser("learner");
    await assertFails(
      db.collection("courseProgress").doc("run1__learner__m1").set(progressDoc()),
    );
  });

  it("refuses a create from a WITHDRAWN enrolment — leaving the run revokes the pen", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner", { status: "withdrawn" });
    const db = await asUser("learner");
    await assertFails(
      db.collection("courseProgress").doc("run1__learner__m1").set(progressDoc()),
    );
  });
});

describe("courseProgress — the doc id binds (run, caller, item)", () => {
  it("refuses a row addressed to another member's id, even with their uid in the data", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    await seedEnrolment("run1", "facil");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__facil__m1")
        .set(progressDoc({ uid: "facil" })),
    );
  });

  it("refuses a row whose uid FIELD names someone else under the caller's own id", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(progressDoc({ uid: "facil" })),
    );
  });

  it("refuses an id that disagrees with the runId/itemId fields", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(progressDoc({ itemId: "m2" })),
    );
  });
});

describe("courseProgress — hasPublicComment cannot lie", () => {
  it("refuses hasPublicComment: true with no comment (would surface a ghost row to the cohort)", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    const doc = progressDoc({ hasPublicComment: true });
    delete doc.publicComment;
    await assertFails(
      db.collection("courseProgress").doc("run1__learner__m1").set(doc),
    );
  });

  it("refuses hasPublicComment: false with a comment present (would hide it from the lane)", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(progressDoc({ hasPublicComment: false })),
    );
  });

  it("refuses an out-of-range rating and an oversized comment", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(progressDoc({ rating: 6 })),
    );
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(progressDoc({ publicComment: "x".repeat(1001) })),
    );
  });
});

describe("courseProgress — moderation stamps are the server's", () => {
  it("refuses a CREATE carrying moderation fields", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(
          progressDoc({ moderatedByUid: "admin1", moderatedAt: MODERATED_AT }),
        ),
    );
  });

  it("refuses an update that CLEARS a moderation stamp (no laundering by re-save)", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    await seed(async (db) => {
      await db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(
          progressDoc({ moderatedByUid: "admin1", moderatedAt: MODERATED_AT }),
        );
    });
    const db = await asUser("learner");
    // Full overwrite without the stamps: the pin must refuse it.
    await assertFails(
      db.collection("courseProgress").doc("run1__learner__m1").set(progressDoc()),
    );
  });

  it("allows an update that carries the stamps through verbatim", async () => {
    await seedCast();
    await seedEnrolment("run1", "learner");
    await seed(async (db) => {
      await db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(
          progressDoc({ moderatedByUid: "admin1", moderatedAt: MODERATED_AT }),
        );
    });
    const db = await asUser("learner");
    await assertSucceeds(
      db
        .collection("courseProgress")
        .doc("run1__learner__m1")
        .set(
          progressDoc({
            completed: false,
            moderatedByUid: "admin1",
            moderatedAt: MODERATED_AT,
          }),
        ),
    );
  });
});

describe("courseProgress — reads and the list budget", () => {
  it("refuses an unconstrained list (queries must constrain uid == self)", async () => {
    await seedCast();
    const db = await asUser("learner");
    await assertFails(db.collection("courseProgress").get());
    await assertFails(
      db.collection("courseProgress").where("runId", "==", "run1").get(),
    );
  });

  it("refuses reading another member's row", async () => {
    await seedCast();
    await seedEnrolment("run1", "facil");
    await seed(async (db) => {
      await db
        .collection("courseProgress")
        .doc("run1__facil__m1")
        .set(progressDoc({ uid: "facil" }));
    });
    const db = await asUser("learner");
    await assertFails(
      db.collection("courseProgress").doc("run1__facil__m1").get(),
    );
  });

  it("REGRESSION: a 25-doc own-progress list succeeds — the read rule must stay get()-free", async () => {
    // If this fails after a rules edit, an enrolment get() has crept into the
    // progress READ rule. Each list candidate would then bill a document
    // access against the ~20-access budget and real members' progress pages
    // would break the week they pass ~20 rows. Enrolment checks belong on
    // the WRITE side only. Fix the rule, not this test.
    await seedCast();
    await seed(async (db) => {
      for (let i = 1; i <= 25; i++) {
        const itemId = `m${String(i).padStart(2, "0")}`;
        await db
          .collection("courseProgress")
          .doc(`run1__learner__${itemId}`)
          .set(progressDoc({ itemId, weekNumber: 1 + (i % 8) }));
      }
    });
    const db = await asUser("learner");
    const snap = await assertSucceeds(
      db.collection("courseProgress").where("uid", "==", "learner").get(),
    );
    assert.equal(snap.size, 25);
  });
});

// ---------------------------------------------------------------------------
// courses — authoring, two-person review, pinned ownership
// ---------------------------------------------------------------------------

describe("courses", () => {
  it("lets a draftCourse holder create a clean draft course", async () => {
    await seedCast();
    const db = await asUser("drafter");
    await assertSucceeds(db.collection("courses").doc("course1").set(courseDoc()));
  });

  it("refuses a create that skips 'draft', seeds collaborators, or lacks the permission", async () => {
    await seedCast();
    const drafter = await asUser("drafter");
    await assertFails(
      drafter.collection("courses").doc("c-pub").set(courseDoc({ status: "published" })),
    );
    await assertFails(
      drafter
        .collection("courses")
        .doc("c-collab")
        .set(courseDoc({ collaboratorUids: ["facil"] })),
    );
    const learner = await asUser("learner");
    await assertFails(learner.collection("courses").doc("c-nope").set(courseDoc()));
  });

  it("refuses a collaborator rewriting authorUid or the collaborator roster", async () => {
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("courses")
        .doc("course1")
        .set(courseDoc({ collaboratorUids: ["facil"] }));
    });
    const db = await asUser("facil");
    await assertFails(
      db.collection("courses").doc("course1").update({ authorUid: "facil" }),
    );
    await assertFails(
      db
        .collection("courses")
        .doc("course1")
        .update({ collaboratorUids: ["facil", "learner"] }),
    );
    // The collaborator's legitimate lane — content edits — must survive.
    await assertSucceeds(
      db.collection("courses").doc("course1").update({ tagline: "Sharper hook." }),
    );
  });

  it("holds the two-person rule: the owner-drafter cannot publish, an approver can", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courses").doc("course1").set(courseDoc());
    });
    const drafter = await asUser("drafter");
    await assertFails(
      drafter.collection("courses").doc("course1").update({ status: "published" }),
    );
    // Content edits by the owner stay open.
    await assertSucceeds(
      drafter.collection("courses").doc("course1").update({ level: "Beginner" }),
    );
    const approver = await asUser("approver");
    await assertSucceeds(
      approver.collection("courses").doc("course1").update({ status: "published" }),
    );
  });

  it("refuses a drafter editing a course they neither own nor collaborate on", async () => {
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("courses")
        .doc("course1")
        .set(courseDoc({ authorUid: "someone-else" }));
    });
    const db = await asUser("drafter");
    await assertFails(
      db.collection("courses").doc("course1").update({ tagline: "Mine now." }),
    );
  });

  it("refuses client deletes, admin included (cascade lives in the delete route)", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courses").doc("course1").set(courseDoc());
    });
    await assertFails((await asUser("drafter")).collection("courses").doc("course1").delete());
    await assertFails((await asUser("admin1")).collection("courses").doc("course1").delete());
  });
});

// ---------------------------------------------------------------------------
// courseRuns — server-owned arrays/counters/channel, approve-gated status
// ---------------------------------------------------------------------------

describe("courseRuns", () => {
  it("lets a drafter create a clean draft run and edit its content", async () => {
    await seedCast();
    const db = await asUser("drafter");
    await assertSucceeds(
      db.collection("courseRuns").doc("run-new").set(runDoc("run-new")),
    );
    await assertSucceeds(
      db.collection("courseRuns").doc("run-new").update({ label: "Autumn 2026 (rev)" }),
    );
  });

  it("is readable by a PENDING user (applications are open to pending accounts)", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("pending1");
    await assertSucceeds(db.collection("courseRuns").doc("run1").get());
  });

  it("refuses a draftCourse holder flipping run status — approve is the second pair of eyes", async () => {
    await seedCast();
    await seedRun("run1");
    const drafter = await asUser("drafter");
    await assertFails(
      drafter.collection("courseRuns").doc("run1").update({ status: "applications-open" }),
    );
    const approver = await asUser("approver");
    await assertSucceeds(
      approver.collection("courseRuns").doc("run1").update({ status: "applications-open" }),
    );
  });

  it("refuses a create that seeds reviewer/facilitator/lead arrays or a foreign channel", async () => {
    await seedCast();
    const db = await asUser("drafter");
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-a")
        .set(runDoc("run-a", { admissionsReviewerUids: ["drafter"] })),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-b")
        .set(runDoc("run-b", { trackLeadUids: ["drafter"] })),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-c")
        .set(runDoc("run-c", { channel: "cohort:someone-elses-run" })),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-d")
        .set(runDoc("run-d", { applicationCounts: { ...ZERO_COUNTS, accepted: 40 } })),
    );
  });

  it("refuses the owner-drafter seeding role arrays or rewriting counters/channel on update", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("drafter");
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ admissionsReviewerUids: ["drafter"] }),
    );
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ trackLeadUids: ["drafter"] }),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run1")
        .update({ applicationCounts: { ...ZERO_COUNTS, accepted: 99 } }),
    );
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ channel: "newsletter" }),
    );
  });

  it("refuses a malformed startDate (the civil date every week number derives from)", async () => {
    await seedCast();
    const db = await asUser("drafter");
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-bad")
        .set(runDoc("run-bad", { startDate: "05/10/2026" })),
    );
  });

  it("refuses a drafter editing someone else's run; a run TRACK LEAD may edit content but not status", async () => {
    await seedCast();
    await seedRun("run1", { authorUid: "someone-else", trackLeadUids: ["lead"] });
    const drafter = await asUser("drafter");
    await assertFails(
      drafter.collection("courseRuns").doc("run1").update({ label: "Hijacked" }),
    );
    const leadDb = await asUser("lead");
    await assertSucceeds(
      leadDb.collection("courseRuns").doc("run1").update({ label: "Autumn 2026 — rescheduled" }),
    );
    await assertFails(
      leadDb.collection("courseRuns").doc("run1").update({ status: "running" }),
    );
  });

  it("lets an ADMIN do all of it — status, counters, role arrays", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({
        status: "running",
        admissionsReviewerUids: ["learner"],
        applicationCounts: { ...ZERO_COUNTS, accepted: 12 },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// courseRuns/{runId}/weeks — curriculum authoring
// ---------------------------------------------------------------------------

describe("courseRuns weeks", () => {
  function weekDoc(overrides = {}) {
    return {
      weekNumber: 3,
      title: "Goal misgeneralisation",
      summary: "Read the two papers and note one disagreement.",
      guideBlocks: [],
      materials: [],
      exercises: [],
      checklist: [],
      estimatedMinutes: null,
      published: false,
      ...overrides,
    };
  }

  it("lets the run's drafter-owner, a track lead, and an approver author weeks; learners read them", async () => {
    await seedCast();
    await seedRun("run1", { trackLeadUids: ["lead"] });
    const drafter = await asUser("drafter");
    const weeks = (db) => db.collection("courseRuns").doc("run1").collection("weeks");
    await assertSucceeds(weeks(drafter).doc("w03").set(weekDoc()));
    await assertSucceeds(weeks(await asUser("lead")).doc("w04").set(weekDoc({ weekNumber: 4 })));
    await assertSucceeds(weeks(await asUser("approver")).doc("w05").set(weekDoc({ weekNumber: 5 })));
    await assertSucceeds(weeks(await asUser("pending1")).doc("w03").get());
  });

  it("refuses a plain member writing weeks, and a malformed weekId or weekNumber", async () => {
    await seedCast();
    await seedRun("run1");
    const weeks = (db) => db.collection("courseRuns").doc("run1").collection("weeks");
    await assertFails(weeks(await asUser("learner")).doc("w03").set(weekDoc()));
    const drafter = await asUser("drafter");
    await assertFails(weeks(drafter).doc("week3").set(weekDoc()));
    await assertFails(weeks(drafter).doc("w00").set(weekDoc({ weekNumber: 0 })));
  });

  it("caps the authored arrays (16 checklist items refused)", async () => {
    await seedCast();
    await seedRun("run1");
    const drafter = await asUser("drafter");
    const items = Array.from({ length: 16 }, (_, i) => ({
      id: `c${i}`,
      title: `Item ${i}`,
      mirrorToMyWork: false,
    }));
    await assertFails(
      drafter
        .collection("courseRuns")
        .doc("run1")
        .collection("weeks")
        .doc("w03")
        .set(weekDoc({ checklist: items })),
    );
  });

  it("gates week DELETION above authoring: drafter refused, approver allowed", async () => {
    await seedCast();
    await seedRun("run1");
    await seed(async (db) => {
      await db
        .collection("courseRuns")
        .doc("run1")
        .collection("weeks")
        .doc("w03")
        .set(weekDoc());
    });
    const ref = (db) =>
      db.collection("courseRuns").doc("run1").collection("weeks").doc("w03");
    await assertFails(ref(await asUser("drafter")).delete());
    await assertSucceeds(ref(await asUser("approver")).delete());
  });
});

// ---------------------------------------------------------------------------
// courseGroups — meet links: restricted reads, facilitator session edits
// ---------------------------------------------------------------------------

describe("courseGroups", () => {
  it("hides groups from pending users AND plain members — but a pending user CAN read the run", async () => {
    await seedCast();
    await seedRun("run1");
    await seed(async (db) => {
      await db.collection("courseGroups").doc("g1").set(groupDoc());
    });
    const pending = await asUser("pending1");
    await assertSucceeds(pending.collection("courseRuns").doc("run1").get());
    await assertFails(pending.collection("courseGroups").doc("g1").get());
    // A plain member is enrolled-adjacent but still gets their session card
    // via the server route — the meet link never goes out through a list.
    await assertFails((await asUser("learner")).collection("courseGroups").doc("g1").get());
    await assertSucceeds((await asUser("drafter")).collection("courseGroups").doc("g1").get());
  });

  it("lets an approver create a clean group; refuses a seeded roster or head-started counter", async () => {
    await seedCast();
    const approver = await asUser("approver");
    await assertSucceeds(approver.collection("courseGroups").doc("g1").set(groupDoc()));
    await assertFails(
      approver
        .collection("courseGroups")
        .doc("g2")
        .set(groupDoc({ facilitatorUids: ["facil"] })),
    );
    await assertFails(
      approver.collection("courseGroups").doc("g3").set(groupDoc({ memberCount: 8 })),
    );
    // draftCourse alone does not staff runs.
    await assertFails(
      (await asUser("drafter")).collection("courseGroups").doc("g4").set(groupDoc()),
    );
  });

  it("lets a NAMED facilitator edit their group's session with the pins intact", async () => {
    await seedCast();
    await seedRun("run1", { trackLeadUids: ["lead"] });
    await seed(async (db) => {
      await db
        .collection("courseGroups")
        .doc("g1")
        .set(groupDoc({ facilitatorUids: ["facil"] }));
    });
    const db = await asUser("facil");
    await assertSucceeds(
      db.collection("courseGroups").doc("g1").update({
        session: {
          weekday: 4,
          startTimeLocal: "17:30",
          durationMinutes: 60,
          location: "Trent Building A44",
          meetingUrl: "https://meet.example.com/group-a",
          notes: "Moved for the careers fair.",
        },
        sessionOverrides: { w05: { location: "Online only" } },
      }),
    );
    // The parent run's track lead shares the lane.
    await assertSucceeds(
      (await asUser("lead")).collection("courseGroups").doc("g1").update({ name: "Group A (Tue)" }),
    );
  });

  it("refuses a facilitator touching the roster, the counter, or the group's identity", async () => {
    await seedCast();
    await seedRun("run1");
    await seed(async (db) => {
      await db
        .collection("courseGroups")
        .doc("g1")
        .set(groupDoc({ facilitatorUids: ["facil"] }));
    });
    const db = await asUser("facil");
    await assertFails(
      db.collection("courseGroups").doc("g1").update({ facilitatorUids: ["facil", "learner"] }),
    );
    await assertFails(db.collection("courseGroups").doc("g1").update({ memberCount: 5 }));
    await assertFails(db.collection("courseGroups").doc("g1").update({ runId: "run2" }));
  });

  it("refuses client deletes even for admins (allocation must re-pool members)", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courseGroups").doc("g1").set(groupDoc());
    });
    await assertFails((await asUser("admin1")).collection("courseGroups").doc("g1").delete());
  });
});

// ---------------------------------------------------------------------------
// Server-owned collections — routes only, no client writes at all
// ---------------------------------------------------------------------------

describe("server-owned course collections", () => {
  it("refuses EVERY client write — member and admin — on all five collections", async () => {
    await seedCast();
    const member = await asUser("learner");
    const admin = await asUser("admin1");
    const attempts = [
      ["courseApplications", "run1__learner", { runId: "run1", uid: "learner", status: "pending" }],
      ["courseEnrolments", "run1__learner", { runId: "run1", uid: "learner", status: "active" }],
      ["courseExerciseResponses", "run1__learner__w01__x1", { runId: "run1", uid: "learner", text: "hi" }],
      ["courseAttendance", "run1__g1__w01", { records: { learner: "present" } }],
      ["courseNudges", "run1__w01", { sentAt: new Date() }],
    ];
    for (const [collection, id, data] of attempts) {
      await assertFails(member.collection(collection).doc(id).set(data));
      await assertFails(admin.collection(collection).doc(id).set(data));
    }
  });

  it("applications + enrolments + exercise responses: own row readable, others' rows not", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courseApplications").doc("run1__learner").set({
        runId: "run1",
        uid: "learner",
        email: "learner@example.com",
        status: "pending",
      });
      await db.collection("courseEnrolments").doc("run1__learner").set({
        runId: "run1",
        uid: "learner",
        status: "active",
      });
      await db.collection("courseExerciseResponses").doc("run1__learner__w01__x1").set({
        runId: "run1",
        uid: "learner",
        text: "My answer.",
      });
    });
    const own = await asUser("learner");
    await assertSucceeds(own.collection("courseApplications").doc("run1__learner").get());
    await assertSucceeds(own.collection("courseEnrolments").doc("run1__learner").get());
    await assertSucceeds(own.collection("courseExerciseResponses").doc("run1__learner__w01__x1").get());
    const other = await asUser("facil");
    await assertFails(other.collection("courseApplications").doc("run1__learner").get());
    await assertFails(other.collection("courseEnrolments").doc("run1__learner").get());
    await assertFails(other.collection("courseExerciseResponses").doc("run1__learner__w01__x1").get());
    const admin = await asUser("admin1");
    await assertSucceeds(admin.collection("courseApplications").doc("run1__learner").get());
  });

  it("attendance registers are unreadable by everyone from the client — each row maps ALL uids", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("courseAttendance").doc("run1__g1__w01").set({
        records: { learner: "present", facil: "present" },
      });
    });
    await assertFails((await asUser("learner")).collection("courseAttendance").doc("run1__g1__w01").get());
    await assertFails((await asUser("admin1")).collection("courseAttendance").doc("run1__g1__w01").get());
  });
});

// ---------------------------------------------------------------------------
// courseEmailTemplates — admin editor client
// ---------------------------------------------------------------------------

describe("courseEmailTemplates", () => {
  it("admin can read and write a valid template; members can do neither", async () => {
    await seedCast();
    const admin = await asUser("admin1");
    await assertSucceeds(
      admin.collection("courseEmailTemplates").doc("course-allocated").set({
        templateId: "course-allocated",
        subject: "You're in — {courseTitle}",
        blocks: [],
      }),
    );
    await assertSucceeds(admin.collection("courseEmailTemplates").doc("course-allocated").get());
    const member = await asUser("learner");
    await assertFails(member.collection("courseEmailTemplates").doc("course-allocated").get());
    await assertFails(
      member.collection("courseEmailTemplates").doc("course-allocated").set({
        templateId: "course-allocated",
        subject: "hijacked",
        blocks: [],
      }),
    );
  });

  it("caps the subject at 200 chars even for admins", async () => {
    await seedCast();
    const admin = await asUser("admin1");
    await assertFails(
      admin.collection("courseEmailTemplates").doc("course-week-nudge").set({
        templateId: "course-week-nudge",
        subject: "x".repeat(201),
        blocks: [],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// users — the paid-membership badge is admin-set only
// ---------------------------------------------------------------------------

describe("users.paidMembershipYears", () => {
  it("refuses self-seeding the badge at CREATE (an otherwise-valid signup passes)", async () => {
    await seedCast();
    const db = await asUser("newbie");
    const base = {
      uid: "newbie",
      email: "newbie@example.com",
      displayName: "New Person",
      role: "pending",
      createdAt: new Date(),
    };
    await assertFails(
      db.collection("users").doc("newbie").set({
        ...base,
        paidMembershipYears: ["2026/27"],
      }),
    );
    await assertSucceeds(db.collection("users").doc("newbie").set(base));
  });

  it("refuses a member self-setting the badge on UPDATE; an ordinary profile edit passes", async () => {
    await seedCast();
    const db = await asUser("learner");
    await assertFails(
      db.collection("users").doc("learner").update({ paidMembershipYears: ["2026/27"] }),
    );
    await assertSucceeds(db.collection("users").doc("learner").update({ title: "Member" }));
  });

  it("lets an ADMIN grant and revoke the badge", async () => {
    await seedCast();
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("users").doc("learner").update({ paidMembershipYears: ["2026/27"] }),
    );
    await assertSucceeds(
      db.collection("users").doc("learner").update({ paidMembershipYears: [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// tasks — the mirrored course-week task hooks
// ---------------------------------------------------------------------------

describe("tasks — fellowship-reminder mirrors", () => {
  function mirrorTask(overrides = {}) {
    return {
      title: "AI Safety Fundamentals — Week 3",
      description: "Read the two papers.",
      source: "fellowship-reminder",
      kind: "fellowship-weekly",
      creatorUid: "learner",
      completerUids: ["learner"],
      reviewerUids: [],
      status: "todo",
      visibility: "assignees-only",
      subtasks: [],
      blocks: [],
      archived: false,
      sourceRef: { cohortId: "run1", weekNumber: 3 },
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("lets the completer ARCHIVE their mirrored task (narrow update band)", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
    });
    const db = await asUser("learner");
    await assertSucceeds(
      db.collection("tasks").doc("course-w03__run1__learner").update({ archived: true }),
    );
  });

  it("refuses the completer rewriting sourceRef — the mirror stays aimed at its week", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
    });
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("tasks")
        .doc("course-w03__run1__learner")
        .update({ sourceRef: { cohortId: "run2", weekNumber: 1 } }),
    );
  });

  it("lets the completer DELETE (dismiss) a fellowship-reminder task — and only that source", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          visibility: "committee",
          creatorUid: "someone-else",
        }),
      );
    });
    const db = await asUser("learner");
    await assertSucceeds(db.collection("tasks").doc("course-w03__run1__learner").delete());
    // Being a completer on a committee task confers no delete.
    await assertFails(db.collection("tasks").doc("committee-task").delete());
  });

  it("refuses a NON-completer deleting someone's mirror", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
    });
    const db = await asUser("facil");
    await assertFails(db.collection("tasks").doc("course-w03__run1__learner").delete());
  });
});

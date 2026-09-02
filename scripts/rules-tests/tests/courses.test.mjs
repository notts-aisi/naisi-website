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

  // The one case `archived` is in the narrow band FOR. Its scope is pinned by
  // the three negative tests at the bottom of this block — if this one ever has
  // to change, they are the ones that say what it is allowed to become.
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

  // A REVIEWER shares the narrow UPDATE band with completers, which is exactly
  // why delete had to be keyed off isCompleter() alone: the two roles are not
  // interchangeable here. Dismissing someone else's course reminder off their
  // own board is not a reviewer's call.
  it("refuses a REVIEWER on the mirror deleting it", async () => {
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("tasks")
        .doc("course-w03__run1__learner")
        .set(mirrorTask({ reviewerUids: ["facil"] }));
    });
    const db = await asUser("facil");
    await assertFails(db.collection("tasks").doc("course-w03__run1__learner").delete());
    // …but the narrow update band still works for them, so the denial above is
    // the delete rule refusing, not the reviewer being locked out of the doc.
    await assertSucceeds(
      db.collection("tasks").doc("course-w03__run1__learner").update({ status: "in-progress" }),
    );
  });

  // Committee delete power is scoped to committee-VISIBILITY tasks they created.
  // A mirror is assignees-only and created for the member, so the SU committee
  // branch must not reach it even though its holder outranks the member.
  it("refuses an SU-recognised committee member deleting someone's mirror", async () => {
    await seedCast();
    await seedUser("sucom", { role: "committee", suRecognised: true });
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
    });
    const db = await asUser("sucom");
    await assertFails(db.collection("tasks").doc("course-w03__run1__learner").delete());
  });

  // The `personal` delete branch is creator-keyed, not completer-keyed. Adding
  // the fellowship-reminder branch must not have widened it: being listed as a
  // completer on someone else's personal to-do confers nothing.
  it("refuses a completer deleting a PERSONAL task they did not create", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("someones-todo").set(
        mirrorTask({
          source: "personal",
          creatorUid: "facil",
          completerUids: ["learner"],
        }),
      );
    });
    const db = await asUser("learner");
    await assertFails(db.collection("tasks").doc("someones-todo").delete());
  });

  // `archived` rides in the narrow allowlist, so it must not become a carrier
  // for the fields that allowlist exists to keep out. completerUids is the
  // sharpest of those: writing it would add strangers to a task (and to the
  // notify-route recipient list) or hand yourself delete on a mirror.
  it("refuses smuggling completerUids alongside the archive flag", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("course-w03__run1__learner").set(mirrorTask());
    });
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("tasks")
        .doc("course-w03__run1__learner")
        .update({ archived: true, completerUids: ["learner", "facil"] }),
    );
    // Same for the visibility flip, which is admin-only everywhere else.
    await assertFails(
      db
        .collection("tasks")
        .doc("course-w03__run1__learner")
        .update({ archived: true, visibility: "committee" }),
    );
    // The lone-field write is what actually ships, and it still passes.
    await assertSucceeds(
      db.collection("tasks").doc("course-w03__run1__learner").update({ archived: true }),
    );
  });

  // The delete branch reads resource.data.source — the STORED value — so the
  // only way to reach it is to already own a real mirror. These two assertions
  // close the forge-your-own-mirror route: a member can neither create a task
  // claiming the source, nor relabel one they already own.
  it("refuses a member CREATING a task that claims source fellowship-reminder", async () => {
    await seedCast();
    const db = await asUser("learner");
    await assertFails(
      db.collection("tasks").doc("forged").set(mirrorTask({ creatorUid: "learner" })),
    );
    // The self-serve quick-add a member IS allowed still works, unchanged.
    await assertSucceeds(
      db
        .collection("tasks")
        .doc("my-todo")
        .set(mirrorTask({ source: "personal", kind: null, sourceRef: null })),
    );
  });

  it("refuses a member relabelling their own personal task as a mirror", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("my-todo").set(
        mirrorTask({
          source: "personal",
          kind: null,
          sourceRef: null,
          creatorUid: "learner",
        }),
      );
    });
    const db = await asUser("learner");
    await assertFails(
      db.collection("tasks").doc("my-todo").update({ source: "fellowship-reminder" }),
    );
    // Still theirs to delete via the personal branch — the denial above is the
    // source pin, not a loss of control over their own to-do.
    await assertSucceeds(db.collection("tasks").doc("my-todo").delete());
  });

  // ── the SCOPE of `archived` in the narrow update band ──────────────────────
  //
  // `archived` was added to the completer/reviewer allowlist for the mirror
  // above, and these pin that it reaches no further. It matters because the
  // band also covers REVIEWERS, who need not be completers, and because the
  // board and My Work queries hide archived tasks by default: an unscoped
  // `archived` lets any ONE person on a committee task make it disappear for
  // everybody, which is a delete in everything but name. The three tests below
  // are the negative direction; "lets the completer ARCHIVE their mirrored
  // task" above is the positive one, and both must keep passing.
  //
  // Each test also writes a plain `status` afterwards, so a failure here reads
  // as "the archive scope refused" rather than "this actor lost the band".

  it("refuses a COMPLETER archiving a committee-visibility task", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          kind: "generic",
          visibility: "committee",
          creatorUid: "someone-else",
          completerUids: ["learner"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("learner");
    await assertFails(
      db.collection("tasks").doc("committee-task").update({ archived: true }),
    );
    // The gate reads the STORED source, so claiming the mirror source in the
    // same write cannot unlock it (`source` is outside the allowlist too).
    await assertFails(
      db
        .collection("tasks")
        .doc("committee-task")
        .update({ archived: true, source: "fellowship-reminder" }),
    );
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ status: "in-progress" }),
    );
  });

  it("refuses a REVIEWER who is not a completer archiving a committee task", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          kind: "generic",
          visibility: "committee",
          creatorUid: "someone-else",
          completerUids: ["learner"],
          reviewerUids: ["facil"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("facil");
    await assertFails(
      db.collection("tasks").doc("committee-task").update({ archived: true }),
    );
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ status: "in-progress" }),
    );
  });

  // Not a visibility test — an assignees-only PERSONAL task is just as
  // protected. Archiving someone's private to-do belongs to its creator (the
  // branch below the band), and being listed as a completer on it confers
  // nothing, exactly as with delete.
  it("refuses a completer archiving a PERSONAL task they did not create", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("someones-todo").set(
        mirrorTask({
          source: "personal",
          kind: "generic",
          creatorUid: "facil",
          completerUids: ["learner"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("learner");
    await assertFails(
      db.collection("tasks").doc("someones-todo").update({ archived: true }),
    );
    await assertSucceeds(
      db.collection("tasks").doc("someones-todo").update({ status: "in-progress" }),
    );
  });

  // ── the `source` pin on the committee update branch ────────────────────────
  //
  // Both gates above read the STORED `source`: the delete branch keys the
  // mirror-dismissal route off it, and the narrow band keys `archived` off it.
  // Reading the stored value is what makes them safe against a relabel *in the
  // same write* — but it is only worth anything if the stored value cannot be
  // rewritten by a LATER write. `source` is set once at create and never
  // rewritten anywhere in the app (every update path in taskMutations.ts is a
  // partial `updateDoc` patch and none of them carry the field; the one
  // `setDoc` is createTask), so pinning it costs no legitimate flow.
  //
  // Unpinned it was a two-step: an SU-recognised committee member relabels a
  // committee task 'fellowship-reminder' via the committee branch, and every
  // completer on that task immediately gains BOTH the unilateral archive the
  // section above closes AND the delete branch — which the route serves with a
  // recursiveDelete, taking the task's whole comment and activity history with
  // it. The relabel is the pivot; this pin removes it.
  //
  // Each test pairs its denial with an ordinary committee edit by the SAME
  // actor on the SAME doc, so a failure reads as "the source pin refused"
  // rather than "this actor lost the branch entirely".

  it("refuses an SU committee member relabelling a committee task's source", async () => {
    await seedCast();
    await seedUser("sucom", { role: "committee", suRecognised: true });
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          kind: "generic",
          visibility: "committee",
          creatorUid: "someone-else",
          completerUids: ["learner"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("sucom");
    await assertFails(
      db.collection("tasks").doc("committee-task").update({ source: "fellowship-reminder" }),
    );
    // Nor smuggled in under an edit that would otherwise pass on its own.
    await assertFails(
      db
        .collection("tasks")
        .doc("committee-task")
        .update({ title: "Term-one comms plan", source: "fellowship-reminder" }),
    );
    // The same actor still holds the committee branch on the same doc.
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ title: "Term-one comms plan" }),
    );
  });

  it("leaves an ordinary committee edit alone — title, description, completers", async () => {
    await seedCast();
    await seedUser("sucom", { role: "committee", suRecognised: true });
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          kind: "generic",
          visibility: "committee",
          creatorUid: "someone-else",
          completerUids: ["learner"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("sucom");
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({
        title: "Draft the term-one comms plan",
        description: "Owner: comms. Wanted before week 1.",
        completerUids: ["learner", "facil"],
        status: "in-progress",
      }),
    );
    // The pin compares VALUES, not affectedKeys, so a client that echoes the
    // field back unchanged is not collateral damage. Nothing in the app does
    // this today, but it is the difference between pinning a field and
    // forbidding a key, and it is the half that would bite if a future editor
    // started saving whole task documents.
    await assertSucceeds(
      db
        .collection("tasks")
        .doc("committee-task")
        .update({ source: "committee", title: "Same source, new title" }),
    );
  });

  // `.get('source', '')` defaults BOTH sides, so a row predating the field
  // compares '' to '' and passes. Worth a test because the obvious spelling of
  // this pin — `request.resource.data.source == taskData().source` — would
  // instead throw on the missing field and lock every legacy committee task out
  // of its own branch, with no failing test to say why.
  it("still lets a committee member edit a task that has NO source field", async () => {
    await seedCast();
    await seedUser("sucom", { role: "committee", suRecognised: true });
    const legacy = mirrorTask({
      kind: "generic",
      visibility: "committee",
      creatorUid: "someone-else",
      completerUids: ["learner"],
      sourceRef: null,
    });
    delete legacy.source;
    await seed(async (db) => {
      await db.collection("tasks").doc("legacy-task").set(legacy);
    });
    const db = await asUser("sucom");
    await assertSucceeds(
      db.collection("tasks").doc("legacy-task").update({ title: "Still editable" }),
    );
    // The default is a comparison floor, not a blank cheque: adding a `source`
    // to a row that never had one is still a relabel ('' vs the new value), and
    // it is refused for the same reason. Backfilling one is an admin job.
    await assertFails(
      db.collection("tasks").doc("legacy-task").update({ source: "fellowship-reminder" }),
    );
  });

  // The admin arm is a separate `||` branch with no field conditions on it at
  // all, so the pin does not reach admins: an admin CAN change `source`, and
  // that is intended. It hands them nothing they lack — admins already hold
  // unconditional update, archive and delete on every task, so relabelling one
  // is a longer road to powers they have directly. The only thing it does that
  // is not already theirs is hand the task's completers a dismissal route, and
  // that is a deliberate admin act (it is also how an admin-triggered mirror
  // backfill would legitimately mark a task as a mirror in the first place).
  it("leaves ADMINS unaffected by the source pin", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(
        mirrorTask({
          source: "committee",
          kind: "generic",
          visibility: "committee",
          creatorUid: "someone-else",
          completerUids: ["learner"],
          sourceRef: null,
        }),
      );
    });
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ title: "Admin edit" }),
    );
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ source: "fellowship-reminder" }),
    );
  });
});

// ---------------------------------------------------------------------------
// V3 W1 PR5: open mode, streams, and the fields that open a write door
// ---------------------------------------------------------------------------

/**
 * The four fields `courseRuns` gained are all SERVER-OWNED, and each is
 * server-owned for a stated reason rather than by analogy:
 *
 *  - `enrolMode` opens a WRITE DOOR. An `open` run admits an enrolment with
 *    no application behind it, which is a capability change, not content.
 *  - `streams` is an ELIGIBILITY list the enrol route validates against,
 *    while `courseEnrolments.streamId` is `allow write: if false`. A
 *    client-direct edit here can strand rows in a collection no client can
 *    repair.
 *  - `enrolledCount` is a counter over rows written transactionally.
 *  - `submissionExerciseRef` is the run's completion bar.
 *
 * Each therefore needs BOTH halves: pinned on update AND birth-pinned on
 * create, because update only pins and a run born dirty stays dirty forever.
 */
describe("courseRuns: V3 open-mode fields are server-owned", () => {
  it("refuses a drafter creating a run already in open mode, or pre-seeded with streams", async () => {
    await seedCast();
    const db = await asUser("drafter");
    await assertFails(
      db.collection("courseRuns").doc("run-a").set(runDoc("run-a", { enrolMode: "open" })),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-b")
        .set(runDoc("run-b", { streams: [{ id: "technical", label: "Technical" }] })),
    );
    await assertFails(
      db.collection("courseRuns").doc("run-c").set(runDoc("run-c", { enrolledCount: 30 })),
    );
    // The clean shapes still pass, both spellings: written explicitly (what
    // `createRun` does) and left absent (a legacy client).
    await assertSucceeds(
      db
        .collection("courseRuns")
        .doc("run-ok")
        .set(runDoc("run-ok", { enrolMode: "admissions", streams: [], enrolledCount: 0 })),
    );
    await assertSucceeds(
      db.collection("courseRuns").doc("run-bare").set(runDoc("run-bare")),
    );
  });

  it("refuses an APPROVER flipping enrol mode, streams or the counter", async () => {
    // The approver is the interesting case throughout this block: they are
    // authorised to move the run's status and are still refused these, so the
    // change always goes through the route that owns it.
    await seedCast();
    await seedRun("run1", { trackLeadUids: ["lead"] });
    for (const uid of ["approver", "drafter", "lead"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ enrolMode: "open" }),
      );
      await assertFails(
        db
          .collection("courseRuns")
          .doc("run1")
          .update({ streams: [{ id: "technical", label: "Technical" }] }),
      );
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ enrolledCount: 99 }),
      );
      await assertFails(
        db
          .collection("courseRuns")
          .doc("run1")
          .update({ submissionExerciseRef: { weekId: "w06", exerciseId: "x1" } }),
      );
    }
  });

  it("lets an ADMIN write them, the route's own lane and the escape hatch", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({
        enrolMode: "open",
        streams: [{ id: "technical", label: "Technical" }],
        enrolledCount: 4,
      }),
    );
  });

  it("REGRESSION: a stored null submissionExerciseRef WEDGES a whole-document save, absent does not", async () => {
    // WHY THIS FIELD IS SPECIFIED AS ABSENT-NEVER-NULL, demonstrated rather
    // than asserted. The pin is `.get('submissionExerciseRef', {})` on BOTH
    // sides, so the two shapes behave differently and the difference is a
    // property of the WRITE SHAPE, not of the field:
    //
    //  - a MERGE update (`updateDoc`, what `updateRun` issues today) carries
    //    the stored value through into `request.resource.data`, so null == null
    //    and the write lands. That is why the bug can sit dormant.
    //  - a WHOLE-DOCUMENT save (`setDoc`, what every rehydrate-then-save path
    //    and every fixture here does) OMITS the key, so the request side falls
    //    back to `{}` while the stored side is null. `{} != null`, and the run
    //    is refused to every non-admin for the rest of its life, on writes
    //    that never mention the field.
    //
    // This is the `templateId` trap recorded a few dozen lines up in
    // firestore.rules, which is why that route writes strings and never null.
    // If this test goes red on the wedged half, do NOT relax the pin: find
    // whatever started writing null and stop it.
    await seedCast();

    // ABSENT (what normalizeCourseRun and createRun produce): a whole-document
    // save keeps working, which is the state every run is in today.
    await seedRun("run-absent", { trackLeadUids: ["lead"] });
    for (const uid of ["approver", "drafter", "lead"]) {
      const db = await asUser(uid);
      await assertSucceeds(
        db
          .collection("courseRuns")
          .doc("run-absent")
          .set(runDoc("run-absent", { trackLeadUids: ["lead"], label: `Saved by ${uid}` })),
      );
    }

    // A REAL POINTER re-sent verbatim: also fine, because both sides read the
    // same map.
    const ref = { weekId: "w06", exerciseId: "x1" };
    await seedRun("run-set", { submissionExerciseRef: ref });
    const set = await asUser("approver");
    await assertSucceeds(
      set
        .collection("courseRuns")
        .doc("run-set")
        .set(runDoc("run-set", { submissionExerciseRef: ref, label: "Still editable" })),
    );
    // ...and CHANGING it is still refused, because it is a pinned field.
    await assertFails(
      set
        .collection("courseRuns")
        .doc("run-set")
        .set(runDoc("run-set", { submissionExerciseRef: { weekId: "w01", exerciseId: "x9" } })),
    );

    // NULL: wedged. The save omits the key, the defaults disagree, and
    // nothing an approver, a drafter-owner or a track lead sends is accepted.
    await seedRun("run-null", {
      submissionExerciseRef: null,
      trackLeadUids: ["lead"],
    });
    for (const uid of ["approver", "drafter", "lead"]) {
      const db = await asUser(uid);
      await assertFails(
        db
          .collection("courseRuns")
          .doc("run-null")
          .set(runDoc("run-null", { trackLeadUids: ["lead"], label: "Wedged" })),
      );
    }
    // Only an admin can still touch it, which is what makes the state
    // recoverable rather than terminal.
    const admin = await asUser("admin1");
    await assertSucceeds(
      admin.collection("courseRuns").doc("run-null").update({ submissionExerciseRef: ref }),
    );
    const repaired = await asUser("approver");
    await assertSucceeds(
      repaired
        .collection("courseRuns")
        .doc("run-null")
        .set(runDoc("run-null", { submissionExerciseRef: ref, trackLeadUids: ["lead"] })),
    );
  });
});

// ---------------------------------------------------------------------------
// V3 W1 PR5: courseGroups stream tag, appointments, and the register ceiling
// ---------------------------------------------------------------------------

describe("courseGroups: V3 server-owned fields and the capacity ceiling", () => {
  it("refuses a group BORN tagged to a stream or carrying appointments", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("approver");
    await assertFails(
      db
        .collection("courseGroups")
        .doc("grp-a")
        .set(groupDoc({ streamId: "technical" })),
    );
    await assertFails(
      db
        .collection("courseGroups")
        .doc("grp-b")
        .set(
          groupDoc({
            facilitatorAppointments: {
              facil: { at: new Date(), byUid: "approver", byName: "A", agreedAt: null },
            },
          }),
        ),
    );
    await assertSucceeds(db.collection("courseGroups").doc("grp-ok").set(groupDoc()));
  });

  it("refuses a facilitator retagging their own group's stream or its appointments", async () => {
    await seedCast();
    await seedRun("run1");
    await seed(async (db) => {
      await db
        .collection("courseGroups")
        .doc("grp1")
        .set(groupDoc({ facilitatorUids: ["facil"] }));
    });
    const db = await asUser("facil");
    // They CAN still edit their session, which is the lane the pin must not
    // close.
    await assertSucceeds(
      db
        .collection("courseGroups")
        .doc("grp1")
        .update({ session: { ...groupDoc().session, location: "Portland Building" } }),
    );
    await assertFails(
      db.collection("courseGroups").doc("grp1").update({ streamId: "technical" }),
    );
    await assertFails(
      db
        .collection("courseGroups")
        .doc("grp1")
        .update({
          facilitatorAppointments: {
            facil: { at: new Date(), byUid: "facil", byName: "Self", agreedAt: null },
          },
        }),
    );
  });

  it("refuses a capacity past the register ceiling, on any run", async () => {
    // 40 is ATTENDANCE_LIMITS.maxRecords, and it is not a taste decision: the
    // marking route throws RegisterFullError on the MERGED map for the WHOLE
    // post past that, so a 41-person group makes bulk marking fail for
    // everybody in it rather than merely leaving one person unmarked.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("approver");
    await assertFails(
      db.collection("courseGroups").doc("grp-big").set(groupDoc({ capacity: 41 })),
    );
    await assertSucceeds(
      db.collection("courseGroups").doc("grp-max").set(groupDoc({ capacity: 40 })),
    );
    await assertFails(
      db.collection("courseGroups").doc("grp-max").update({ capacity: 41 }),
    );
    await assertFails(
      db.collection("courseGroups").doc("grp-zero").set(groupDoc({ capacity: 0 })),
    );
  });

  it("requires a capacity on an OPEN-mode run, and leaves admissions runs alone", async () => {
    await seedCast();
    await seedRun("run-open", { enrolMode: "open" });
    await seedRun("run-adm", { enrolMode: "admissions" });
    const db = await asUser("approver");

    // Open mode: uncapped is refused, capped is fine.
    await assertFails(
      db
        .collection("courseGroups")
        .doc("open-uncapped")
        .set(groupDoc({ runId: "run-open", capacity: null })),
    );
    await assertSucceeds(
      db
        .collection("courseGroups")
        .doc("open-capped")
        .set(groupDoc({ runId: "run-open", capacity: 12 })),
    );
    // ...and it cannot be un-capped later either.
    await assertFails(
      db.collection("courseGroups").doc("open-capped").update({ capacity: null }),
    );

    // Admissions: an uncapped group is still legal, because allocation is a
    // deliberate act by a human who can see the size of the group.
    await assertSucceeds(
      db
        .collection("courseGroups")
        .doc("adm-uncapped")
        .set(groupDoc({ runId: "run-adm", capacity: null })),
    );
  });
});

// ---------------------------------------------------------------------------
// V3 W1 PR5: a member cannot write their own attendance
// ---------------------------------------------------------------------------

describe("courseEnrolments: the attendance rollup is not the member's to write", () => {
  it("refuses a member writing attendance or submissionDone onto their OWN row", async () => {
    // The rollup lives on a row the member can READ, which is what lets a
    // learner see their own attendance with no new read rule. That makes the
    // write side worth an explicit test rather than an inherited one: the
    // collection is `allow write: if false`, and the completion bar for the
    // whole pre-course is computed from these two fields.
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("learner");
    const ref = db.collection("courseEnrolments").doc("run1__learner");

    // Reading their own row: yes, and that is the point.
    await assertSucceeds(ref.get());

    await assertFails(
      ref.update({
        attendance: {
          sessionsHeld: 6,
          attendedInFull: 6,
          late: 0,
          leftEarly: 0,
          absent: 0,
          excused: 0,
          lastPushedSessionKey: "w06",
          lastComputedAt: new Date(),
        },
      }),
    );
    await assertFails(ref.update({ submissionDone: true }));
    await assertFails(ref.update({ status: "completed" }));
    await assertFails(ref.update({ streamId: "technical" }));
    await assertFails(ref.update({ droppedOutAt: null }));
    // Nor by minting a fresh row at their own deterministic id.
    await assertFails(
      db.collection("courseEnrolments").doc("run2__learner").set({
        runId: "run2",
        courseId: "course1",
        uid: "learner",
        groupId: null,
        status: "active",
        role: "learner",
        submissionDone: true,
      }),
    );
  });

  it("refuses an ADMIN client-writing the rollup too; the push transaction owns it", async () => {
    // The rollup is a FULL RECOMPUTE inside the attendance push, never a
    // delta. A hand write is exactly the unreconcilable drift that
    // applicationCounts already demonstrates.
    await seedCast();
    await seedEnrolment("run1", "learner");
    const db = await asUser("admin1");
    await assertFails(
      db.collection("courseEnrolments").doc("run1__learner").update({ submissionDone: true }),
    );
  });
});

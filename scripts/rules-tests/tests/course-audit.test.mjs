/**
 * Rules tests for V3 W1 PR5's two new rules blocks: `courseAudit` and the
 * explicit `config/{doc}` deny.
 *
 * `courseAudit` is ONE append-only log for every course operational action
 * that has to stay answerable after the fact: a register pushed or edited
 * after the lock, a facilitator appointed or removed, a member dropping out,
 * a run settled, an enrolment mode changed, a week unlocked early, an
 * applicant's access-requirements answer read. It takes the `courseDeletions`
 * posture verbatim, and the two properties below are the whole of it:
 *
 *  - READ is admin-only. Not "admin or draftCourse or the run's track leads",
 *    which is the read tier every other staff-facing course collection has.
 *    A row names an ACTOR and, for some kinds, a SUBJECT: "who read this
 *    applicant's access requirements" is exactly the sort of question a
 *    facilitator should not be able to browse the answers to.
 *  - WRITE is shut to every client, ADMINS INCLUDED. An append-only log its
 *    own actor can amend is not an audit trail, and the actors here are
 *    admins. Every writer is an Admin SDK route.
 *
 * `config` has never had a match block: the collection was closed by
 * deny-by-default, which works right up until somebody adds a wildcard above
 * it. The block is documentation with teeth, and the tests here are what stop
 * it being deleted as redundant.
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
  await getTestEnv("course-audit");
});
after(cleanup);
afterEach(clearData);

/** The cast, one of each hat the courses rules distinguish. */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("committee1", { role: "committee", suRecognised: true });
  await seedUser("learner", { role: "member" });
}

function auditDoc(overrides = {}) {
  return {
    kind: "attendance-push",
    runId: "run1",
    groupId: "grp1",
    subjectUid: null,
    actorUid: "approver",
    actorName: "A Facilitator",
    targetLabel: "Week 3 register",
    detail: "Register pushed and locked.",
    at: new Date("2026-10-27T20:00:00Z"),
    ...overrides,
  };
}

/** Write a row the way an Admin SDK route would (rules bypassed). */
async function seedAudit(id, overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseAudit").doc(id).set(auditDoc(overrides));
  });
}

describe("courseAudit: read is admin-only", () => {
  it("lets an admin read a row and list the log", async () => {
    await seedCast();
    await seedAudit("a1");
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("courseAudit").doc("a1").get());
    await assertSucceeds(db.collection("courseAudit").where("runId", "==", "run1").get());
  });

  it("refuses every other hat, including the course staff tier", async () => {
    await seedCast();
    await seedAudit("a1");
    // draftCourse / approveCourse read courseTemplates and courseMaterialNotes
    // freely. They do NOT read this: a row can name who looked at an
    // applicant's access requirements, and staff browsing that is the thing
    // the log exists to make visible to admins, not to staff.
    for (const uid of ["drafter", "approver", "committee1", "learner"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseAudit").doc("a1").get());
      await assertFails(db.collection("courseAudit").where("runId", "==", "run1").get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("courseAudit").doc("a1").get());
  });

  it("refuses a row whose subject is the reader themselves", async () => {
    // The obvious "surely I can see my own" carve-out, deliberately absent.
    // The row is about an ACTION TAKEN ON somebody, written by staff, and the
    // `detail` sentence is staff prose about them. Own-row read here would
    // hand a dropped-out member the sentence a facilitator wrote about their
    // leaving.
    await seedCast();
    await seedAudit("a1", {
      kind: "enrolment-dropout",
      subjectUid: "learner",
      actorUid: "learner",
    });
    const db = await asUser("learner");
    await assertFails(db.collection("courseAudit").doc("a1").get());
  });
});

describe("courseAudit: write is shut to everyone", () => {
  it("refuses create, update and delete from every hat, admins included", async () => {
    await seedCast();
    await seedAudit("a1");
    for (const uid of ["admin1", "approver", "drafter", "committee1", "learner"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseAudit").doc("new").set(auditDoc()));
      await assertFails(
        db.collection("courseAudit").doc("a1").update({ detail: "Nothing happened." }),
      );
      await assertFails(db.collection("courseAudit").doc("a1").delete());
    }
  });

  it("refuses an admin rewriting the actor on a row that names them", async () => {
    // The specific attack the posture exists for: the only surviving record
    // of an admin action is a row that same admin could otherwise repoint at
    // somebody else.
    await seedCast();
    await seedAudit("a1", { kind: "access-requirements-read", actorUid: "admin1" });
    const db = await asUser("admin1");
    await assertFails(
      db.collection("courseAudit").doc("a1").update({ actorUid: "approver" }),
    );
  });
});

describe("config: the server-only collection is explicitly shut", () => {
  it("refuses reads and writes of every config doc, admins included", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("config").doc("courses").set({
        unmarkedRegisterGraceHours: 36,
        dropOutFeedbackUrl: "https://example.org/feedback",
        nextSessionMaxDays: 14,
        unmarkedScanBudgetMs: 20000,
        maxFollowUpTasksPerTick: 25,
      });
      await db.collection("config").doc("taskEmails").set({ enabled: true });
    });

    for (const uid of ["admin1", "approver", "committee1", "learner"]) {
      const db = await asUser(uid);
      for (const doc of ["courses", "taskEmails"]) {
        await assertFails(db.collection("config").doc(doc).get());
        await assertFails(db.collection("config").doc(doc).update({ enabled: false }));
      }
      await assertFails(db.collection("config").doc("newone").set({ a: 1 }));
      await assertFails(db.collection("config").get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("config").doc("courses").get());
  });
});

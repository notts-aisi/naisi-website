/**
 * Rules tests for the V2-1 DELETION PROTOCOL — the surfaces it adds to
 * `firestore.rules`:
 *
 *  1. **`courseDeletions`** — the destroy audit log. Admin READ, and no client
 *     write at all. This log is the only surviving evidence of a destroy (the
 *     rows it describes are gone by definition), so the property that matters
 *     is not "members can't read it" — it is that *nobody*, admins included,
 *     can amend or erase it from a client. An append-only log its own actor can
 *     rewrite is not an audit trail, and the destroy flow's resumability means
 *     the row is read back by the same admin who started the cascade.
 *
 *  2. **`courseRuns.archived`** — the everyday soft path. Archive is the
 *     reversible half of the protocol (destroy is the irreversible half), and
 *     it is a WITHDRAWAL: an archived run drops out of the admin default list,
 *     the public catalogue, the /me live sections and the application windows.
 *     So it belongs in `runPinnedFieldsUnchanged` beside `channel` and
 *     `applicationCounts`, not in run content — which is the whole point,
 *     because a drafter-owner and a run's track leads legitimately hold the
 *     content lane all term and would otherwise be able to unpublish a live
 *     cohort with one field, silently, without touching the route.
 *
 * ## The one asymmetry to read carefully
 *
 * `approveCourse` holders ARE authorised to call
 * `PATCH /api/courses/runs/[runId]/archive`, and are NOT carved out of the pin.
 * That is deliberate and is the sharpest test in this file: the actor who may
 * archive must still go through the route (Admin SDK) to do it, so the archive
 * has a server-side gate in front of it rather than being a field an autosave
 * could carry. Admins keep the same unconditional-update carve-out they have
 * for every other pin in that function — it hands them nothing, since an admin
 * can already write `status: "cancelled"`, which withdraws a run harder.
 *
 * ## The destroy MARKER is pinned here too
 *
 * `beginDestroy()` (courseDeletion.ts) stamps `destroying` + `destroyAuditId`
 * on the run in the SAME transaction that opens the audit row. They are the
 * resume cursor, and they were not in the original brief because the engine
 * landed after it — but they are `archived`'s siblings in every respect, so
 * they ride the same clause. Leaving them unpinned would let a track lead
 * clear `destroying` (making the next invocation look fresh, so it opens a
 * SECOND audit row and strands the first at `completedAt: null`) or repoint
 * `destroyAuditId` at somebody else's row, which falsifies the only surviving
 * record of a destroy. See the courseRuns comment for the full reasoning.
 *
 * ## The COURSE-level marker, and the task pointer the cascade sweeps on
 *
 * Two more pins landed with the review that followed the build, and both are
 * about aiming somebody else's cascade:
 *
 *  - `courses` carries the same `destroying` / `destroyAuditId` marker as a
 *    run, and its update branch admits COLLABORATORS — who may be plain
 *    members holding no course permission at all. Unpinned, one of them could
 *    stamp the marker on a course and point it at an EXISTING courseDeletions
 *    row: the next real cascade reads a marker as a resume, so it skips its
 *    blockers and accumulates its counts (and its `completedAt`) onto an
 *    unrelated audit record. That is the runs-level pin's whole argument, one
 *    level up.
 *  - `tasks.sourceRef` is the pointer a RUN destroy sweeps on
 *    (`sourceRef.cohortId == runId` → `recursiveDelete`, taking comments,
 *    activity, attachments and Storage with it). `source` was pinned;
 *    `sourceRef` was not, on either the committee update branch or at create.
 *    So a committee member could stamp a doomed run's id onto any committee
 *    task and have the next admin's destroy erase it — recorded in the audit
 *    row as one of that run's own mirrors. The engine now also filters the
 *    sweep on `source == 'fellowship-reminder'` (that is the half that covers
 *    rows written before this pin); these tests are the half that stops the
 *    field being aimed at all.
 *
 * ## Mutation check (each restored bit-exact afterwards)
 *
 *  1. `archived` stripped from `runPinnedFieldsUnchanged` → 6 pin tests red.
 *  2. the create-side `archived == false` clause stripped → the born-archived
 *     test red, everything else green.
 *  3. both run marker clauses stripped → the marker test red, rest green.
 *  4. the two marker clauses stripped from `coursePinnedFieldsUnchanged` →
 *     3 red (collaborator, owner+approver, repointing), rest green.
 *  5. the course create-side clean-start clauses stripped → 1 red (the
 *     born-mid-destroy course), rest green.
 *  6. the `sourceRef` clause stripped from the tasks committee UPDATE branch →
 *     2 red (the committee stamp, the mirror repoint), rest green.
 *  7. the create-side `sourceRef == null` clause stripped → 1 red (the create
 *     test, both lanes), rest green.
 *  8. the `sourceRef` clause stripped from the personal-task branch → 1 red
 *     (the personal creator), rest green.
 *
 * If you edit any of those clauses, redo it — a pin nobody has watched fail is
 * a comment.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
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
  // Unique per file — a shared project id lets one file's clearFirestore()
  // wipe another's fixtures mid-test (see harness.mjs).
  await getTestEnv("course-deletion");
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

/** Every hat the two rules under test distinguish. */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("lead", { role: "member" });
  await seedUser("learner", { role: "member" });
  await seedUser("sucom", { role: "committee", suRecognised: true });
  await seedUser("pending1", { role: "pending" });
}

function runDoc(id, overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "running",
    startDate: "2026-10-05",
    weekPlan: [],
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    authorUid: "drafter",
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: ["lead"],
    applicationCounts: { ...ZERO_COUNTS },
    groupCount: 0,
    channel: `cohort:${id}`,
    archived: false,
    destroying: false,
    destroyAuditId: "",
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

/**
 * A course doc as the editor holds it, with a collaborator on the roster —
 * the actor the course-level marker pin exists for. `learner` is a plain
 * member: no draftCourse, no approveCourse, nothing but the collaborator
 * entry, which is exactly the point.
 */
function courseDoc(overrides = {}) {
  return {
    title: "AI Safety Fundamentals",
    tagline: "Eight weeks, no prior experience needed",
    summaryBlocks: [],
    track: "general",
    level: "",
    estimatedWeeklyHours: null,
    status: "draft",
    showcaseRunId: null,
    authorUid: "drafter",
    collaboratorUids: ["learner"],
    destroying: false,
    destroyAuditId: "",
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedCourse(id = "course1", overrides = {}) {
  await seed(async (db) => {
    await db.collection("courses").doc(id).set(courseDoc(overrides));
  });
}

/**
 * A committee task — the thing a forged `sourceRef` would feed to the
 * cascade. Deliberately NOT a mirror: mirrors are the rows a run destroy is
 * supposed to take, and the whole finding is that anything else can be made
 * to look like one.
 */
function committeeTask(overrides = {}) {
  return {
    title: "Book the lecture theatre",
    description: "For the launch event.",
    source: "committee",
    kind: "generic",
    projectId: null,
    creatorUid: "sucom",
    completerUids: ["sucom"],
    reviewerUids: [],
    status: "todo",
    priority: "normal",
    visibility: "committee",
    subtasks: [],
    blocks: [],
    blockConsents: {},
    archived: false,
    sourceRef: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** An audit row exactly as the destroy route opens it, before the first page. */
function auditDoc(overrides = {}) {
  return {
    kind: "run",
    targetId: "run1",
    targetLabel: "Autumn 2026",
    startedAt: new Date("2026-08-22T10:00:00Z"),
    startedByUid: "admin1",
    startedByName: "Admin One",
    manifestCounts: {
      weeks: 8,
      groups: 3,
      applications: 61,
      enrolments: 38,
      progress: 912,
      exerciseResponses: 140,
      attendanceRegisters: 24,
      mirroredTasks: 190,
      subscriptionRows: 38,
      emailSendRows: 400,
    },
    deleted: {},
    completedAt: null,
    resumeCount: 0,
    ...overrides,
  };
}

async function seedAudit(id = "del1", overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseDeletions").doc(id).set(auditDoc(overrides));
  });
}

// ---------------------------------------------------------------------------
// courseDeletions — admin read, no client write at all
// ---------------------------------------------------------------------------

describe("courseDeletions — reads", () => {
  it("lets an ADMIN read a single audit row and list the log", async () => {
    await seedCast();
    await seedAudit("del1");
    await seedAudit("del2", {
      kind: "course",
      targetId: "course1",
      targetLabel: "AI Safety Fundamentals",
      resumeCount: 2,
    });
    const db = await asUser("admin1");
    const one = await assertSucceeds(db.collection("courseDeletions").doc("del1").get());
    assert.equal(one.data().targetLabel, "Autumn 2026");
    // The Danger-zone history view lists the collection; `allow read` covers
    // `list`, and admin is the only tier that gets either.
    const all = await assertSucceeds(db.collection("courseDeletions").get());
    assert.equal(all.size, 2);
  });

  it("refuses the log to every non-admin tier, including the actors who trigger destroys", async () => {
    await seedCast();
    await seedAudit("del1");
    // approveCourse is the permission the destroy route itself is NOT gated on
    // (destroy is admin-only), but it is the strongest course permission there
    // is — if the log leaked to anyone below admin it would leak to them first.
    for (const uid of ["approver", "drafter", "sucom", "learner", "pending1"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseDeletions").doc("del1").get());
      await assertFails(db.collection("courseDeletions").get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("courseDeletions").doc("del1").get());
    await assertFails(anon.collection("courseDeletions").get());
  });
});

describe("courseDeletions — writes are server-side, admins included", () => {
  it("refuses a CREATE from everyone — the row is opened by the route before the first delete", async () => {
    await seedCast();
    for (const uid of ["admin1", "approver", "drafter", "learner"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseDeletions").doc(`forged-${uid}`).set(auditDoc()));
    }
    const anon = await asAnon();
    await assertFails(anon.collection("courseDeletions").doc("forged-anon").set(auditDoc()));
  });

  it("refuses an ADMIN amending a row they started — an actor-writable audit log is not one", async () => {
    await seedCast();
    await seedAudit("del1");
    const db = await asUser("admin1");
    // Understating what died.
    await assertFails(
      db.collection("courseDeletions").doc("del1").update({
        manifestCounts: { ...auditDoc().manifestCounts, enrolments: 0 },
      }),
    );
    // Closing a cascade that never drained, so the UI stops asking to resume.
    await assertFails(
      db.collection("courseDeletions").doc("del1").update({ completedAt: new Date() }),
    );
    // Re-attributing it.
    await assertFails(
      db.collection("courseDeletions").doc("del1").update({ startedByUid: "drafter" }),
    );
    // A full overwrite is the same write with different spelling.
    await assertFails(db.collection("courseDeletions").doc("del1").set(auditDoc()));
  });

  it("refuses a DELETE of the audit row — the log outlives the data it describes", async () => {
    await seedCast();
    await seedAudit("del1");
    for (const uid of ["admin1", "approver", "learner"]) {
      await assertFails((await asUser(uid)).collection("courseDeletions").doc("del1").delete());
    }
    // Still there.
    const check = await (await asUser("admin1")).collection("courseDeletions").doc("del1").get();
    assert.equal(check.exists, true);
  });
});

// ---------------------------------------------------------------------------
// courseRuns.archived — pinned against the content lane
// ---------------------------------------------------------------------------

describe("courseRuns.archived — the content lane cannot reach it", () => {
  it("refuses a TRACK LEAD flipping archived, alone or smuggled under a content edit", async () => {
    await seedCast();
    await seedRun("run1");
    const db = await asUser("lead");
    await assertFails(db.collection("courseRuns").doc("run1").update({ archived: true }));
    // The interesting shape: the lead's legitimate write (a mid-term reschedule)
    // carrying the flag. `runContentOk()` passes, the actor branch passes, and
    // only the pin refuses it.
    await assertFails(
      db.collection("courseRuns").doc("run1").update({
        label: "Autumn 2026 — rescheduled",
        archived: true,
      }),
    );
    // The same edit without the flag passes, so the two denials above are the
    // pin refusing and not the track lead losing their lane.
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ label: "Autumn 2026 — rescheduled" }),
    );
  });

  it("refuses the drafter-OWNER flipping archived on their own run", async () => {
    await seedCast();
    await seedRun("run1", { status: "draft" });
    const db = await asUser("drafter");
    await assertFails(db.collection("courseRuns").doc("run1").update({ archived: true }));
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ weekPlan: [] }),
    );
  });

  it("refuses an approveCourse holder — the actor the ROUTE authorises still has to use it", async () => {
    // This is the pin's whole purpose. `approveCourse` is what
    // PATCH /api/courses/runs/[runId]/archive checks, so of everyone below
    // admin this holder is the one with a legitimate reason to set the field —
    // and the rules still say no, which is what forces the archive through the
    // Admin SDK route instead of leaving it as a field an autosave could carry.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("approver");
    await assertFails(db.collection("courseRuns").doc("run1").update({ archived: true }));
    // They keep the status lane they are actually the approver for.
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ status: "completed" }),
    );
  });

  it("locks UNARCHIVING too — restoring a run is the same route, not a client edit", async () => {
    await seedCast();
    await seedRun("run1", { archived: true });
    for (const uid of ["lead", "drafter", "approver"]) {
      await assertFails(
        (await asUser(uid)).collection("courseRuns").doc("run1").update({ archived: false }),
      );
    }
  });

  it("pins the VALUE, not the key: echoing archived back unchanged is not collateral damage", async () => {
    // The distinction matters because the run editor autosaves and a future
    // version could start writing whole documents rather than patches. A pin
    // that compared affectedKeys() would break that client for no security
    // gain; this one compares values, so an unchanged echo passes.
    await seedCast();
    await seedRun("run1");
    const lead = await asUser("lead");
    await assertSucceeds(
      lead.collection("courseRuns").doc("run1").update({
        archived: false,
        label: "Autumn 2026 (rev)",
      }),
    );
    await seedRun("run2", { archived: true, channel: "cohort:run2" });
    await assertFails(
      lead.collection("courseRuns").doc("run2").update({ archived: false }),
    );
  });

  it("defaults BOTH sides, so a run predating the field is still editable", async () => {
    // `.get('archived', false)` on both sides is deliberate: the obvious
    // spelling — `request.resource.data.archived == resource.data.archived` —
    // would throw on every run written before V2-1 and lock its drafter and
    // track leads out of their own curriculum, with nothing to say why.
    await seedCast();
    const legacy = runDoc("legacy");
    delete legacy.archived;
    await seed(async (db) => {
      await db.collection("courseRuns").doc("legacy").set(legacy);
    });
    const db = await asUser("lead");
    await assertSucceeds(
      db.collection("courseRuns").doc("legacy").update({ label: "Still editable" }),
    );
    // The default is a comparison floor, not a blank cheque: adding the field to
    // a run that never had one is still a flip ('' side false vs true).
    await assertFails(
      db.collection("courseRuns").doc("legacy").update({ archived: true }),
    );
    // And writing it as the value it already implies is a no-op, so it passes.
    await assertSucceeds(
      db.collection("courseRuns").doc("legacy").update({ archived: false }),
    );
  });

  it("refuses a run BORN archived, and lets the clean create through", async () => {
    // Update only PINS the field, so without a create-side clean start
    // `archived` would be the one pinned field a client could seed dirty —
    // minting a run that is withdrawn from birth and that only the archive
    // route could ever bring back.
    await seedCast();
    const db = await asUser("drafter");
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-born-archived")
        .set(runDoc("run-born-archived", { status: "draft", trackLeadUids: [], archived: true })),
    );
    await assertSucceeds(
      db
        .collection("courseRuns")
        .doc("run-clean")
        .set(runDoc("run-clean", { status: "draft", trackLeadUids: [], archived: false })),
    );
    // Omitting the field entirely is the same clean create.
    const noField = runDoc("run-omitted", { status: "draft", trackLeadUids: [] });
    delete noField.archived;
    await assertSucceeds(db.collection("courseRuns").doc("run-omitted").set(noField));
  });

  it("leaves ADMINS on the unconditional branch — the documented carve-out", async () => {
    // Every pin in runPinnedFieldsUnchanged sits on the non-admin branch only,
    // and `archived` is no different. It hands an admin nothing new: they can
    // already write `status: "cancelled"` from the client, which withdraws a
    // run harder than archiving it. Recorded as a test so the carve-out is a
    // decision on the record rather than an oversight — if the owner wants
    // archive to be route-only for admins as well, this is the test that has to
    // be inverted, and the admin branch (not this function) is where it lands.
    await seedCast();
    await seedRun("run1");
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("courseRuns").doc("run1").update({ archived: true }));
    await assertSucceeds(db.collection("courseRuns").doc("run1").update({ archived: false }));
  });

  it("refuses a run BORN mid-destroy, and pins the marker against every content actor", async () => {
    // `beginDestroy()` stamps `destroying` + `destroyAuditId` on the run in the
    // SAME transaction that opens the courseDeletions audit row. Together they
    // are the resume cursor, so they are pinned harder than `archived`:
    //  - clearing `destroying` makes the next invocation look FRESH, opening a
    //    second audit row and stranding the first at completedAt: null —
    //    indistinguishable from a genuine interruption;
    //  - repointing `destroyAuditId` aims the accumulating counts and the
    //    resumeCount increment at somebody ELSE'S audit row, which falsifies
    //    the only surviving record of a destroy;
    //  - seeding either on a live run wedges the archive route, which refuses
    //    to touch a run that says it is being destroyed.
    await seedCast();
    const drafter = await asUser("drafter");
    await assertFails(
      drafter
        .collection("courseRuns")
        .doc("run-born-destroying")
        .set(
          runDoc("run-born-destroying", {
            status: "draft",
            trackLeadUids: [],
            destroying: true,
            destroyAuditId: "someone-elses-audit",
          }),
        ),
    );

    await seedRun("run1", { destroying: true, destroyAuditId: "audit-1" });
    for (const uid of ["lead", "drafter", "approver"]) {
      const db = await asUser(uid);
      // Cancel the destroy out from under the cascade.
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ destroying: false }),
      );
      // Redirect where the counts accumulate.
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ destroyAuditId: "audit-2" }),
      );
      // Or smuggle either under an edit that would otherwise pass.
      await assertFails(
        db.collection("courseRuns").doc("run1").update({
          label: "Autumn 2026 (rev)",
          destroying: false,
        }),
      );
    }
    // Mid-destroy the whole content lane is frozen too (2026-08-22): every
    // destroy pass re-confirms by the CURRENT label, so a rename here would
    // wedge a half-finished cascade — the same insider class the marker pins
    // close. This is the freeze clause, not the pin.
    await assertFails(
      (await asUser("lead")).collection("courseRuns").doc("run1").update({ label: "Still mine" }),
    );
    // On a run that is NOT being destroyed, the content lane is untouched.
    await seedRun("run-live");
    await assertSucceeds(
      (await asUser("lead")).collection("courseRuns").doc("run-live").update({ label: "Still mine" }),
    );
  });

  it("keeps the run itself undeletable from the client — destroy is the route's cascade", async () => {
    // The soft path is a field; the hard path is not a client delete. Both
    // destroy routes run a paginated, audited cascade, and a one-shot client
    // delete would strand every week, group, enrolment, response and register
    // that names the run.
    await seedCast();
    await seedRun("run1");
    for (const uid of ["admin1", "approver", "drafter", "lead"]) {
      await assertFails((await asUser(uid)).collection("courseRuns").doc("run1").delete());
    }
  });
});

// ---------------------------------------------------------------------------
// courses.destroying / destroyAuditId — the marker, one level up
// ---------------------------------------------------------------------------

describe("courses — the destroy marker cannot be forged", () => {
  it("refuses a COLLABORATOR seeding the marker, alone or under a content edit", async () => {
    // The sharpest actor for this pin: a plain member with no course
    // permission whatsoever, holding the course only because they were added
    // to `collaboratorUids`. The course update branch admits them by design
    // (they are there to edit the course), and before the pin that included
    // the two fields that decide which audit row a cascade writes into.
    await seedCast();
    await seedCourse("course1");
    const db = await asUser("learner");

    await assertFails(
      db.collection("courses").doc("course1").update({ destroying: true }),
    );
    await assertFails(
      db.collection("courses").doc("course1").update({ destroyAuditId: "del1" }),
    );
    // The interesting shape: a legitimate edit carrying the marker with it.
    await assertFails(
      db.collection("courses").doc("course1").update({
        tagline: "Eight weeks, and a reading group",
        destroying: true,
        destroyAuditId: "del1",
      }),
    );
    // The same edit without the marker passes, so the denials above are the
    // pin refusing and not the collaborator losing their lane.
    await assertSucceeds(
      db
        .collection("courses")
        .doc("course1")
        .update({ tagline: "Eight weeks, and a reading group" }),
    );
  });

  it("refuses the drafter-OWNER and an approveCourse holder too", async () => {
    // Nothing below admin writes this field: it is the Admin SDK's, stamped
    // inside the transaction that opens the audit row.
    await seedCast();
    await seedCourse("course1");
    for (const uid of ["drafter", "approver"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courses").doc("course1").update({ destroying: true }),
      );
      await assertFails(
        db.collection("courses").doc("course1").update({ destroyAuditId: "del1" }),
      );
    }
    // The approver keeps the status lane they are the approver for — which is
    // also the honest way to withdraw a course.
    await assertSucceeds(
      (await asUser("approver")).collection("courses").doc("course1").update({
        status: "archived",
      }),
    );
  });

  it("refuses REPOINTING the marker mid-destroy, and refuses clearing it", async () => {
    // Repointing is the forgery that matters: the counts, the resumeCount
    // increment and the completedAt would all land on somebody else's audit
    // row. Clearing it makes the next invocation look fresh, so it opens a
    // SECOND row and strands the first at completedAt: null.
    await seedCast();
    await seedCourse("course1", { destroying: true, destroyAuditId: "audit-1" });
    for (const uid of ["learner", "drafter", "approver"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courses").doc("course1").update({ destroyAuditId: "audit-2" }),
      );
      await assertFails(
        db.collection("courses").doc("course1").update({ destroying: false }),
      );
    }
  });

  it("refuses a course BORN mid-destroy, and lets the clean create through", async () => {
    // Update only PINS the marker, so without a create-side clean start a
    // course could be minted already claiming to be mid-destroy — pointing at
    // an audit row it does not own, and skipping the blocker check (which is
    // what protects its runs) on its first real destroy.
    await seedCast();
    const db = await asUser("drafter");
    const fresh = (overrides) =>
      courseDoc({ authorUid: "drafter", collaboratorUids: [], ...overrides });

    await assertFails(
      db
        .collection("courses")
        .doc("course-born-destroying")
        .set(fresh({ destroying: true, destroyAuditId: "someone-elses-audit" })),
    );
    await assertSucceeds(db.collection("courses").doc("course-clean").set(fresh({})));
    // Omitting the fields entirely is the same clean create — a course written
    // before the protocol existed has neither.
    const noMarker = fresh({});
    delete noMarker.destroying;
    delete noMarker.destroyAuditId;
    delete noMarker.archived;
    await assertSucceeds(db.collection("courses").doc("course-omitted").set(noMarker));
  });

  it("leaves ADMINS on the unconditional branch — the same carve-out runs have", async () => {
    // Recorded so the carve-out is a decision rather than an oversight. It
    // hands an admin nothing: they are the only role the destroy routes serve
    // anyway, and the marker they could write by hand is one the cascade
    // would immediately treat as its own resume.
    await seedCast();
    await seedCourse("course1");
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("courses").doc("course1").update({ destroying: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// tasks.sourceRef — the cascade's aim
// ---------------------------------------------------------------------------

describe("tasks.sourceRef — a run's cascade cannot be aimed by hand", () => {
  it("refuses an SU-committee member stamping a run id onto a committee task", async () => {
    // The attack in one write: `sourceRef.cohortId = <a run about to be
    // destroyed>` on an ordinary committee task. The next admin destroy sweeps
    // that field and recursiveDeletes what it finds — the task, its comments,
    // its activity log, its attachments and their Storage blobs — and records
    // it in the audit row as one of the run's own mirrored tasks.
    await seedCast();
    await seed(async (db) => {
      await db.collection("tasks").doc("committee-task").set(committeeTask());
    });
    const db = await asUser("sucom");

    await assertFails(
      db
        .collection("tasks")
        .doc("committee-task")
        .update({ sourceRef: { cohortId: "run1", weekNumber: 1 } }),
    );
    // Smuggled under an edit that would otherwise pass.
    await assertFails(
      db.collection("tasks").doc("committee-task").update({
        title: "Book the lecture theatre (main campus)",
        sourceRef: { cohortId: "run1", weekNumber: 1 },
      }),
    );
    // The same edit without the pointer passes: the committee lane is intact
    // and the denials above are the pin.
    await assertSucceeds(
      db
        .collection("tasks")
        .doc("committee-task")
        .update({ title: "Book the lecture theatre (main campus)" }),
    );
    // Echoing the value back unchanged is not collateral damage — the pin is
    // on the VALUE, so a client that writes whole documents still works.
    await assertSucceeds(
      db.collection("tasks").doc("committee-task").update({ sourceRef: null }),
    );
  });

  it("refuses REPOINTING a real mirror at another cohort", async () => {
    // The mirror's own pointer is equally pinned: re-aiming it would move
    // somebody's task into a different run's cascade (and confuse the
    // idempotent re-sync into duplicating it).
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("tasks")
        .doc("course-w03__run1__sucom")
        .set(
          committeeTask({
            source: "fellowship-reminder",
            kind: "fellowship-weekly",
            sourceRef: { cohortId: "run1", weekNumber: 3 },
          }),
        );
    });
    await assertFails(
      (await asUser("sucom"))
        .collection("tasks")
        .doc("course-w03__run1__sucom")
        .update({ sourceRef: { cohortId: "run2", weekNumber: 3 } }),
    );
  });

  it("refuses a CREATE carrying a pointer — on both lanes", async () => {
    // Nothing client-side creates a mirror: courseTasks.ts writes them on the
    // Admin SDK, and the one client create path writes `sourceRef: null`. So
    // a create carrying a pointer is either a mistake or an attempt to plant
    // a row inside a cohort's blast radius, and both lanes refuse it.
    await seedCast();

    const sucom = await asUser("sucom");
    await assertFails(
      sucom
        .collection("tasks")
        .doc("forged-committee")
        .set(committeeTask({ sourceRef: { cohortId: "run1", weekNumber: 1 } })),
    );
    await assertSucceeds(
      sucom.collection("tasks").doc("clean-committee").set(committeeTask()),
    );

    // The member lane: a personal quick-add, which is pinned to
    // source 'personal' already and now to a null pointer as well.
    const personal = (overrides) =>
      committeeTask({
        source: "personal",
        visibility: "assignees-only",
        creatorUid: "learner",
        completerUids: ["learner"],
        reviewerUids: [],
        ...overrides,
      });
    const learner = await asUser("learner");
    await assertFails(
      learner
        .collection("tasks")
        .doc("forged-personal")
        .set(personal({ sourceRef: { cohortId: "run1", weekNumber: 1 } })),
    );
    await assertSucceeds(
      learner.collection("tasks").doc("clean-personal").set(personal({})),
    );
    // Omitting the field is the same clean create.
    const omitted = personal({});
    delete omitted.sourceRef;
    await assertSucceeds(learner.collection("tasks").doc("omitted-personal").set(omitted));
  });

  it("refuses the creator of a PERSONAL task adding a pointer later", async () => {
    // "A creator can edit their personal task freely" stops short of the
    // destroy pointer: setting it would volunteer their own task — with its
    // comments and attachments — into somebody else's cascade.
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("tasks")
        .doc("personal-1")
        .set(
          committeeTask({
            source: "personal",
            visibility: "assignees-only",
            creatorUid: "learner",
            completerUids: ["learner"],
          }),
        );
    });
    const db = await asUser("learner");
    await assertFails(
      db
        .collection("tasks")
        .doc("personal-1")
        .update({ sourceRef: { cohortId: "run1", weekNumber: 1 } }),
    );
    await assertSucceeds(
      db.collection("tasks").doc("personal-1").update({ title: "Read chapter 4" }),
    );
  });
});

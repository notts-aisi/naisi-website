/**
 * Rules tests for V2-2 — CURRICULUM SNAPSHOTS, FACILITATOR NOTES, and the
 * TEMPLATE PROVENANCE pin on `courseRuns`. Three surfaces `firestore.rules`
 * gained, each with a different reason to exist:
 *
 *  1. **`courseTemplates` + its `weeks` subcollection.** Frozen snapshots of a
 *     cohort's curriculum. Every client write is denied — admins included, on
 *     BOTH levels — and that is the collection's whole value, not a
 *     tightening that could be relaxed later. Three arguments, all tested:
 *       * a snapshot is the record of what a cohort was ACTUALLY taught, and
 *         the seed of next year's run. One you can edit afterwards is just a
 *         second, worse copy of the run;
 *       * the week docs carry the material / exercise / checklist IDS that
 *         member progress is keyed on (`courseProgress/{runId}__{uid}__
 *         {itemId}`). A client able to rewrite an id inside a template would
 *         be aiming the NEXT cohort's progress keys, silently, a year early;
 *       * the collection is APPEND-ONLY — saving mints a new id — so there is
 *         no legitimate client write to admit in the first place.
 *     READ is the staff tier (admin / draftCourse / approveCourse / the
 *     SOURCE RUN's track leads), because drafters and leads have to browse
 *     versions to pick one, and a snapshot carries no PII.
 *
 *  2. **`courseMaterialNotes`.** The named half of the retrospective loop.
 *     Route-only writes (authority is a query over `courseGroups`, which a
 *     rule cannot run; `weekNumber` and `byName` are server-derived), and the
 *     retrospective's own read tier. Members are excluded outright, including
 *     from notes about materials they were taught: these are staff
 *     assessments of the curriculum, written on the understanding that the
 *     cohort is not the audience.
 *
 *  3. **`courseRuns.templateId` / `.templateLabel`.** Provenance, pinned into
 *     `runPinnedFieldsUnchanged` beside `archived` and the destroy marker.
 *
 * ## The two asymmetries to read carefully
 *
 * **The approveCourse holder is NOT carved out of the provenance pin.** They
 * ARE authorised to call `POST /api/courses/runs/[runId]/apply-template` —
 * and are still refused the field. That is the `archived` argument exactly:
 * the actor who may stamp provenance must go through the route (Admin SDK) to
 * do it, so the stamp always arrives with the copy that earned it rather than
 * as a field an autosave could carry. Admins keep their unconditional-update
 * carve-out, which hands them nothing they did not already have.
 *
 * **The track-lead read branch costs a `get()` per candidate row.** A
 * template carries no role fields of its own, so the branch resolves against
 * the SOURCE RUN. `allow read` covers `list`, and a list evaluates its rule
 * per candidate doc — the hazard `courseProgress` documents at length. Three
 * things make it safe rather than lucky: it is the LAST branch of a
 * short-circuiting `||` (so it never runs for an admin, drafter or approver),
 * the admin UI reads versions through the route, and a course holds a handful
 * of snapshots. The dangling-source-run test below pins the consequence: a
 * template whose run is gone DENIES the lead branch, and the privileged
 * branches short-circuit before it, so a destroyed source run never locks
 * staff out of their own history.
 *
 * ## Mutation check — RUN 2026-08-22, each restored bit-exact afterwards
 *
 * Every mutation was applied to `firestore.rules`, the WHOLE suite was run,
 * and the file restored (sha256 verified identical). Results are what
 * actually happened, not what was expected:
 *
 *  1. `allow write: if false` on `courseTemplates/{templateId}` relaxed to
 *     `isAdmin()` → 3 red: the create pin, the relabel pin, the delete pin.
 *     Rest green.
 *  2. the same on the `weeks` subcollection → 1 red: "refuses an ADMIN
 *     editing an item id inside a frozen week". Rest green.
 *  3. `|| isSourceRunTrackLead()` dropped from the template doc read → 1 red:
 *     the lead's single-doc read. The lead's SUBCOLLECTION read stays green,
 *     which is the tell that the two levels carry independent branches.
 *  4. the `courseMaterialNotes` read tier relaxed to `isSignedIn()` → 1 red:
 *     "refuses notes to members".
 *  5. `allow write: if false` on `courseMaterialNotes` relaxed to
 *     `isSignedIn()` → 1 red: the write refusals.
 *  6. `templateId`/`templateLabel` stripped from `runPinnedFieldsUnchanged`
 *     → 2 red: the track lead, and the drafter-owner/approver pair. Rest
 *     green — including the positive control, which is the half that proves
 *     the pin is not simply blocking every run edit.
 *  7. the create-side `templateId == '' && templateLabel == ''` clauses
 *     stripped → 1 red: the born-with-provenance run. Rest green.
 *
 * If you edit any of those clauses, redo it — a pin nobody has watched fail
 * is a comment.
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
  await getTestEnv("course-templates");
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

/** Every hat the three surfaces under test distinguish. */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  // A track lead of run1, holding NO course permission — the whole point of
  // the read branch, and the sharpest actor for the provenance pin.
  await seedUser("lead", { role: "member" });
  // A facilitator of a group in run1. They WRITE material notes (through the
  // route) and hold no course permission at all.
  await seedUser("facil", { role: "member" });
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
    templateId: "tpl-autumn-2026",
    templateLabel: "Autumn 2026 final",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedRun(id = "run1", overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseRuns").doc(id).set(runDoc(id, overrides));
  });
}

/** A snapshot exactly as POST /api/courses/[courseId]/templates writes it. */
function templateDoc(overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026 final",
    sourceRunId: "run1",
    sourceGroupId: null,
    savedAt: new Date("2026-08-22T10:00:00Z"),
    savedByUid: "admin1",
    savedByName: "Admin One",
    weekCount: 8,
    retrospective: { runLabel: "Autumn 2026", memberCount: 38, ratedMaterialCount: 22 },
    ...overrides,
  };
}

/** A frozen week — ids preserved from the source run, which is the point. */
function templateWeek(overrides = {}) {
  return {
    weekNumber: 3,
    title: "Goal misgeneralisation",
    summary: "Read the paper, then answer the prompt.",
    guideBlocks: [],
    materials: [
      { id: "m_read_1", type: "reading", title: "Ngo et al.", url: "https://example.com/p" },
    ],
    exercises: [],
    checklist: [],
    estimatedMinutes: 90,
    published: true,
    ...overrides,
  };
}

async function seedTemplate(id = "tpl1", overrides = {}, weekIds = ["w03"]) {
  await seed(async (db) => {
    const ref = db.collection("courseTemplates").doc(id);
    await ref.set(templateDoc(overrides));
    for (const weekId of weekIds) {
      await ref.collection("weeks").doc(weekId).set(templateWeek());
    }
  });
}

function noteDoc(overrides = {}) {
  return {
    runId: "run1",
    itemId: "m_read_1",
    weekNumber: 3,
    uid: "facil",
    byName: "Facilitator One",
    note: "Everyone bounced off section 2 — swap for the summary next time.",
    at: new Date("2026-08-20T18:00:00Z"),
    ...overrides,
  };
}

async function seedNote(id = "run1__m_read_1__facil", overrides = {}) {
  await seed(async (db) => {
    await db.collection("courseMaterialNotes").doc(id).set(noteDoc(overrides));
  });
}

// ---------------------------------------------------------------------------
// courseTemplates — reads
// ---------------------------------------------------------------------------

describe("courseTemplates — the staff read tier", () => {
  it("lets admins and both course-permission holders read a snapshot and list versions", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    await seedTemplate("tpl2", { label: "Spring 2027 draft" });

    for (const uid of ["admin1", "drafter", "approver"]) {
      const db = await asUser(uid);
      const one = await assertSucceeds(db.collection("courseTemplates").doc("tpl1").get());
      assert.equal(one.data().label, "Autumn 2026 final");
      // The nested picker lists versions; `allow read` covers `list`, and
      // these three tiers short-circuit before the expensive branch.
      const all = await assertSucceeds(db.collection("courseTemplates").get());
      assert.equal(all.size, 2);
    }
  });

  it("lets the SOURCE RUN's track lead read a snapshot — they browse versions when they take a run over", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    const db = await asUser("lead");
    const snap = await assertSucceeds(db.collection("courseTemplates").doc("tpl1").get());
    assert.equal(snap.data().sourceRunId, "run1");
  });

  it("refuses a track lead of a DIFFERENT run — the branch resolves against the source run, not the hat", async () => {
    await seedCast();
    // run1 is led by `lead`; the snapshot below came from run2, which is not.
    await seedRun("run1");
    await seedRun("run2", { trackLeadUids: ["someone-else"], channel: "cohort:run2" });
    await seedTemplate("tpl2", { sourceRunId: "run2" });
    const db = await asUser("lead");
    await assertFails(db.collection("courseTemplates").doc("tpl2").get());
  });

  it("refuses a snapshot whose source run is GONE to the lead branch, while staff keep reading it", async () => {
    await seedCast();
    // No `courseRuns/run-destroyed` doc: the get() in the lead branch errors,
    // which is a deny. Correct — nobody leads a run that isn't there — and the
    // privileged branches short-circuit before it, so a destroyed source run
    // never locks staff out of their own frozen history.
    await seedTemplate("tplGhost", { sourceRunId: "run-destroyed" });
    const lead = await asUser("lead");
    await assertFails(lead.collection("courseTemplates").doc("tplGhost").get());
    for (const uid of ["admin1", "drafter", "approver"]) {
      const db = await asUser(uid);
      await assertSucceeds(db.collection("courseTemplates").doc("tplGhost").get());
    }
  });

  it("refuses every tier below staff, including SU committee and the run's facilitators", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    // `sucom` is the most-trusted non-course role on the platform (member PII,
    // the whole task board) and still gets nothing here: curriculum authority
    // is the course permissions, not the governance ladder.
    for (const uid of ["sucom", "facil", "learner", "pending1"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseTemplates").doc("tpl1").get());
      await assertFails(db.collection("courseTemplates").get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("courseTemplates").doc("tpl1").get());
    await assertFails(anon.collection("courseTemplates").get());
  });
});

// ---------------------------------------------------------------------------
// courseTemplates — writes are server-side, admins included
// ---------------------------------------------------------------------------

describe("courseTemplates — append-only, no client writes at all", () => {
  it("refuses a CREATE from everyone — snapshots are minted by the save route", async () => {
    await seedCast();
    await seedRun();
    for (const uid of ["admin1", "approver", "drafter", "lead", "learner"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseTemplates").doc(`forged-${uid}`).set(templateDoc()),
      );
    }
    const anon = await asAnon();
    await assertFails(
      anon.collection("courseTemplates").doc("forged-anon").set(templateDoc()),
    );
  });

  it("refuses an ADMIN relabelling a snapshot from the client — the label edit is a route", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    const db = await asUser("admin1");
    await assertFails(
      db.collection("courseTemplates").doc("tpl1").update({ label: "Renamed" }),
    );
    // And the fields that would falsify what a snapshot claims to be.
    await assertFails(
      db.collection("courseTemplates").doc("tpl1").update({ sourceRunId: "run2" }),
    );
    await assertFails(
      db
        .collection("courseTemplates")
        .doc("tpl1")
        .update({ retrospective: { runLabel: "x", memberCount: 999, ratedMaterialCount: 999 } }),
    );
  });

  it("refuses a DELETE from everyone, admins included", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    for (const uid of ["admin1", "approver", "drafter"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("courseTemplates").doc("tpl1").delete());
    }
  });
});

describe("courseTemplates/weeks — the frozen curriculum is IMMUTABLE", () => {
  it("lets the staff tier and the source run's track lead read a frozen week", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    for (const uid of ["admin1", "drafter", "approver", "lead"]) {
      const db = await asUser(uid);
      const snap = await assertSucceeds(
        db.collection("courseTemplates").doc("tpl1").collection("weeks").doc("w03").get(),
      );
      assert.equal(snap.data().materials[0].id, "m_read_1");
    }
  });

  it("refuses frozen weeks to members, facilitators and anonymous readers", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    for (const uid of ["sucom", "facil", "learner", "pending1"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseTemplates").doc("tpl1").collection("weeks").doc("w03").get(),
      );
    }
    const anon = await asAnon();
    await assertFails(
      anon.collection("courseTemplates").doc("tpl1").collection("weeks").doc("w03").get(),
    );
  });

  it("refuses an ADMIN editing an item id inside a frozen week — that would aim next year's progress keys", async () => {
    await seedCast();
    await seedRun();
    await seedTemplate("tpl1");
    const db = await asUser("admin1");
    const ref = db
      .collection("courseTemplates")
      .doc("tpl1")
      .collection("weeks")
      .doc("w03");
    // The sharp one: `courseProgress` docs are keyed `{runId}__{uid}__{itemId}`,
    // so rewriting `m_read_1` here silently detaches every future check-off on
    // the material this snapshot will seed.
    await assertFails(
      ref.update({
        materials: [
          { id: "m_rewritten", type: "reading", title: "Ngo et al.", url: "https://e.com/p" },
        ],
      }),
    );
    // And the ordinary content edit, which is the tempting one.
    await assertFails(ref.update({ title: "Goal misgeneralisation (v2)" }));
    await assertFails(ref.delete());
    // A NEW week added to a finished snapshot is the same falsification in
    // the other direction: it makes the record claim a cohort was taught
    // something it never saw.
    await assertFails(
      db
        .collection("courseTemplates")
        .doc("tpl1")
        .collection("weeks")
        .doc("w09")
        .set(templateWeek({ weekNumber: 9 })),
    );
  });
});

// ---------------------------------------------------------------------------
// courseMaterialNotes
// ---------------------------------------------------------------------------

describe("courseMaterialNotes — the retrospective's read tier, route-only writes", () => {
  it("lets the staff tier and the run's track lead read notes", async () => {
    await seedCast();
    await seedRun();
    await seedNote();
    for (const uid of ["admin1", "drafter", "approver", "lead"]) {
      const db = await asUser(uid);
      const snap = await assertSucceeds(
        db.collection("courseMaterialNotes").doc("run1__m_read_1__facil").get(),
      );
      assert.equal(snap.data().byName, "Facilitator One");
    }
  });

  it("refuses notes to members — a staff assessment of the curriculum is not cohort-facing", async () => {
    await seedCast();
    await seedRun();
    await seedNote();
    for (const uid of ["learner", "sucom", "pending1"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseMaterialNotes").doc("run1__m_read_1__facil").get(),
      );
      await assertFails(db.collection("courseMaterialNotes").get());
    }
    const anon = await asAnon();
    await assertFails(
      anon.collection("courseMaterialNotes").doc("run1__m_read_1__facil").get(),
    );
  });

  it("refuses a client WRITE from the facilitator who authored the note, and from an admin", async () => {
    await seedCast();
    await seedRun();
    await seedNote();
    // The author writes through POST /api/courses/runs/[runId]/material-notes:
    // authority is a query over courseGroups, `weekNumber` is resolved from
    // the week doc that actually contains the material, and `byName` comes off
    // the user doc. None of that is expressible here, so nothing is admitted.
    const facil = await asUser("facil");
    await assertFails(
      facil
        .collection("courseMaterialNotes")
        .doc("run1__m_read_1__facil")
        .update({ note: "edited straight from the client" }),
    );
    await assertFails(
      facil
        .collection("courseMaterialNotes")
        .doc("run1__m_other__facil")
        .set(noteDoc({ itemId: "m_other" })),
    );
    // Forging someone else's note, and forging a week the material is not in.
    await assertFails(
      facil
        .collection("courseMaterialNotes")
        .doc("run1__m_read_1__lead")
        .set(noteDoc({ uid: "lead", byName: "Track Lead" })),
    );
    for (const uid of ["admin1", "approver", "lead", "learner"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseMaterialNotes").doc(`run1__m_read_1__${uid}`).set(noteDoc({ uid })),
      );
      await assertFails(
        db.collection("courseMaterialNotes").doc("run1__m_read_1__facil").delete(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// courseRuns.templateId / .templateLabel — the provenance pin
// ---------------------------------------------------------------------------

describe("courseRuns — template provenance is pinned to the apply-template route", () => {
  it("refuses a TRACK LEAD rewriting the provenance of the run they lead", async () => {
    await seedCast();
    await seedRun();
    const db = await asUser("lead");
    // The insider case: a lead legitimately edits weekPlan and label all term.
    // Unpinned, they could hand-author every week and then stamp the run with
    // a snapshot it never came from.
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ templateId: "tpl-something-else" }),
    );
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ templateLabel: "Spring 2027 final" }),
    );
    // Stripping the stamp is the same falsification in reverse.
    await assertFails(
      db.collection("courseRuns").doc("run1").update({ templateId: "", templateLabel: "" }),
    );
  });

  it("refuses the DRAFTER-OWNER and the APPROVER — the approver may CALL the route, not write the field", async () => {
    await seedCast();
    await seedRun();
    for (const uid of ["drafter", "approver"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("courseRuns").doc("run1").update({ templateId: "tpl-forged" }),
      );
    }
  });

  it("still lets a track lead edit run CONTENT while carrying provenance through verbatim", async () => {
    await seedCast();
    await seedRun();
    const db = await asUser("lead");
    // The positive control. A pin that blocked the everyday edit would be
    // found in production, not here.
    //
    // The week plan is deliberately NOT part of this edit: the seeded run is
    // live, and `weekPlanLockRespected()` pins the plan once a run leaves
    // draft (see courses-schedule.test.mjs, which owns both sides of that
    // boundary). Provenance pinning is orthogonal to it, so the control uses
    // the run fields a lead really does edit all term.
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({
        label: "Autumn 2026 (moved)",
        academicYear: "2026/27",
      }),
    );
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({
        templateId: "tpl-autumn-2026",
        templateLabel: "Autumn 2026 final",
        startDate: "2026-10-12",
      }),
    );
  });

  it("lets an ADMIN write provenance directly — the documented carve-out", async () => {
    await seedCast();
    await seedRun();
    const db = await asUser("admin1");
    // Same shape as every other pin in runPinnedFieldsUnchanged: the clauses
    // sit on the non-admin branch only. It hands admins nothing — they can
    // already write `status: cancelled`, which is a far bigger hammer.
    await assertSucceeds(
      db.collection("courseRuns").doc("run1").update({ templateId: "tpl-admin-set" }),
    );
  });

  it("refuses a run BORN with provenance it never earned", async () => {
    await seedCast();
    const db = await asUser("drafter");
    // Update only PINS these, so without the create-side clean start a
    // drafter could mint a run already claiming a snapshot — a lie the pin
    // itself then protects from ever being corrected.
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-born-dirty")
        .set(
          runDoc("run-born-dirty", {
            authorUid: "drafter",
            status: "draft",
            trackLeadUids: [],
            templateId: "tpl-autumn-2026",
            templateLabel: "Autumn 2026 final",
          }),
        ),
    );
    await assertFails(
      db
        .collection("courseRuns")
        .doc("run-born-labelled")
        .set(
          runDoc("run-born-labelled", {
            authorUid: "drafter",
            status: "draft",
            trackLeadUids: [],
            templateId: "",
            templateLabel: "Autumn 2026 final",
          }),
        ),
    );
    // The positive control: a clean run still creates.
    await assertSucceeds(
      db
        .collection("courseRuns")
        .doc("run-clean")
        .set(
          runDoc("run-clean", {
            authorUid: "drafter",
            status: "draft",
            trackLeadUids: [],
            templateId: "",
            templateLabel: "",
          }),
        ),
    );
  });
});

/**
 * Rules tests for the SIX ADMISSIONS COLLECTIONS (V3 W1).
 *
 *   admissionRounds
 *   admissionRounds/{roundId}/stages/{stageId}
 *   admissionApplications
 *   admissionApplicationPrivate
 *   admissionReviews
 *   memberConductFlags
 *
 * Every one of them is `allow read, write: if false`. A file that only
 * asserted "deny denies" would be worth nothing, so what is actually pinned
 * here is narrower and sharper:
 *
 *  1. **The reads that would have looked reasonable are refused.** Four of
 *     the six had a plausible own-row or signed-in read in the original
 *     design, and each was dropped for a specific reason. An applicant
 *     reading their OWN application row is the one that matters most: it
 *     carries `evidence.facilitatorNotes` and an `outcome.reason` the decider
 *     deliberately did not tick to share. Those cases are tested as the
 *     actor who would have held the read, not as a stranger.
 *  2. **Admins are refused too, on every collection and every verb.** These
 *     are route-owned collections whose invariants (counters moving with a
 *     status, a self-review guard, a server-recomputed total) live in Admin
 *     SDK code. An admin who can write them from a browser is an admin who
 *     can break them from a browser.
 *  3. **Creates are attempted at WELL-FORMED deterministic ids.** A create at
 *     `garbage-id` proves almost nothing: the ids here are constructible by
 *     anyone who knows a round id and their own uid, so the test uses the
 *     real `${roundId}__${uid}` shapes. A rule that leaked would leak to
 *     exactly this request.
 *  4. **No question text sits on a client-readable document.** This is the
 *     timed-release guarantee, and it is not a rule you can assert by
 *     reading rules: it is a property of where fields are put. The scanner
 *     below walks the seeded fixtures, works out which are readable by
 *     probing an actual member client, and fails if a readable one carries a
 *     `questions` key. It is self-verified: one test plants a leak and
 *     asserts the scanner catches it.
 *  5. **A 25-document list on a readable sibling still works.** The
 *     regression against a `get()` creeping into a read rule; see the
 *     comment on that test for exactly what it does and does not prove.
 *
 * ## Mutation check (each restored bit-exact afterwards)
 *
 *  1. `admissionApplications` changed to
 *     `allow read: if isSignedIn() && resource.data.uid == request.auth.uid`
 *     → the own-row refusal test goes red, everything else green.
 *  2. `admissionRounds` changed to `allow read: if isSignedIn()` → the round
 *     read tests go red.
 *  3. The `.../stages/{stageId}` match block deleted entirely → the stage
 *     tests stay GREEN, because subcollections fall to deny-by-default. That
 *     is the tell that the block is there for the day somebody adds a
 *     wildcard above it, and it is why the scanner in (4) exists as well.
 *  4. `memberConductFlags` changed to `allow read: if isAdmin()` → the
 *     admin-refusal test goes red.
 *  5. A `questions` field added to the ROUND fixture → everything stays
 *     GREEN, and that is correct rather than a hole: the round is
 *     unreadable, so the questions are not on the wire. Add (1)'s sibling
 *     mutation on top of it — `admissionRounds` relaxed to
 *     `allow read: if isSignedIn()` WITH the fixture change — and the
 *     scanner goes red alongside the read tests. That pair is the real
 *     property: the guarantee is not "no questions on a round", it is "no
 *     questions anywhere a client can reach", and the scanner tracks the
 *     rules rather than a list of collections someone has to remember to
 *     update.
 *
 * If you edit any of those clauses, redo it: a pin nobody has watched fail is
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
  await getTestEnv("admissions");
});
after(cleanup);
afterEach(clearData);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUND_ID = "autumn-2026-intake__k3f9a2b1";
const APPLICANT = "member1";
const REVIEWER = "sucom";

/** The deterministic ids the routes construct. Nothing here parses one back. */
const APPLICATION_ID = `${ROUND_ID}__${APPLICANT}`;
const REVIEW_ID = `${ROUND_ID}__${APPLICANT}__${REVIEWER}`;

/**
 * Every hat these rules could plausibly distinguish, plus the two that exist
 * to prove they are not distinguished: `approver` holds the strongest course
 * permission on the site and `admin1` is an admin, and neither gets anything.
 */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("sucom", { role: "committee", suRecognised: true });
  await seedUser("committee1", { role: "committee" });
  await seedUser("approver", { role: "member", permissions: { approveCourse: true } });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  await seedUser("member1", { role: "member" });
  await seedUser("pending1", { role: "pending" });
}

/** Signed-in hats, in the order the failure message reads best. */
const HATS = ["admin1", "sucom", "approver", "drafter", "member1", "committee1", "pending1"];

const ZERO_ADMISSION_COUNTS = {
  draft: 0,
  submitted: 0,
  accepted: 0,
  "fellowship-offered": 0,
  waitlisted: 0,
  rejected: 0,
  withdrawn: 0,
};

/**
 * A round as the authoring route writes it. Note what is NOT here: there is
 * no `questions` field, and there never may be — see the scanner below.
 */
function roundDoc(overrides = {}) {
  return {
    kind: "enrolment",
    label: "Autumn 2026 intake",
    slug: "autumn-2026",
    blurb: "Applications for the research incubator and the fellowships.",
    academicYear: "2026/27",
    status: "open",
    opensAt: new Date("2026-09-21T08:00:00Z"),
    closesAt: new Date("2026-10-18T22:59:00Z"),
    decisionsByDate: "2026-10-23",
    stageIds: ["s1"],
    programmePreference: {
      enabled: true,
      streams: [{ id: "technical", label: "Technical" }],
      fellowships: [{ id: "governance", label: "Governance" }],
      maxRankedFellowships: 2,
      offerFellowshipFallback: true,
    },
    availabilityGrid: { version: 1, startMinute: 540, endMinute: 1080, slotMinutes: 15 },
    accessRequirementsPrompt: "Anything we should know about access requirements?",
    criteria: [{ id: "c1", label: "Motivation", guidance: "Why this, why now." }],
    scoreScale: { min: 1, max: 5 },
    reviewersPerApplication: 2,
    reviewerUids: [REVIEWER],
    finalDeciderUid: "admin1",
    blind: { hideNames: true, hideMembership: true },
    evidenceRunIds: [],
    reminderOffsets: [{ id: "t7", daysBefore: 7, atLocalTime: "10:00" }],
    outcomeRunIds: ["run1"],
    applicationCounts: { ...ZERO_ADMISSION_COUNTS, submitted: 3 },
    archived: false,
    clonedFromRoundId: null,
    authorUid: "admin1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** The ONE document in the model that may carry question text. */
function stageDoc(overrides = {}) {
  return {
    roundId: ROUND_ID,
    label: "Week one",
    intro: "Answer in your own words.",
    questions: [
      { id: "q1", type: "longText", label: "Why do you want to do this?", required: true },
    ],
    releaseAt: "2026-09-28",
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: true,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function applicationDoc(overrides = {}) {
  return {
    roundId: ROUND_ID,
    uid: APPLICANT,
    email: "member1@example.com",
    displayName: "Member One",
    stageAnswers: { s1: { q1: "Because I care about this." } },
    stageSubmittedAt: { s1: new Date() },
    availability: {
      version: 1,
      startMinute: 540,
      endMinute: 1080,
      slotMinutes: 15,
      days: ["000000000", "fff000000", "000000000", "000000000", "000000000", "000000000", "000000000"],
    },
    availabilityConfigVersion: 1,
    programmePreference: {
      streamId: "technical",
      rankedFellowshipIds: ["governance"],
      openToFellowship: true,
    },
    // The two fields that make an own-row read unacceptable.
    evidence: {
      runs: [{ runId: "precourse1", sessionsHeld: 6, attendedInFull: 5, submissionDone: true }],
      facilitatorNotes: "Quiet in the group, strong written work.",
      computedAt: new Date(),
    },
    membershipAtApply: false,
    reapplyCount: 0,
    status: "submitted",
    submittedAt: new Date(),
    withdrawnAt: null,
    outcome: {
      decision: "reject",
      targetRunId: null,
      streamId: null,
      decidedByUid: "admin1",
      decidedAt: new Date(),
      reason: "Not enough technical background this year.",
      reasonShared: false,
    },
    seatApplicationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function reviewDoc(overrides = {}) {
  return {
    roundId: ROUND_ID,
    applicantUid: APPLICANT,
    reviewerUid: REVIEWER,
    scores: { c1: 4 },
    total: 4,
    recommendation: "advance",
    notes: "Clear motivation, thin on the technical side.",
    knowsApplicant: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function conductFlagDoc(overrides = {}) {
  return {
    flagged: true,
    reason: "The allegation, which no reviewer and no member ever sees.",
    byUid: "admin1",
    byName: "Admin One",
    at: new Date(),
    ...overrides,
  };
}

/** A course run, as the readable SIBLING the scanner and the list test use. */
function runDoc(id, overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: `Autumn 2026 ${id}`,
    academicYear: "2026/27",
    status: "running",
    startDate: "2026-10-26",
    weekPlan: [],
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    authorUid: "drafter",
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: {
      pending: 0,
      accepted: 0,
      rejected: 0,
      waitlisted: 0,
      withdrawn: 0,
    },
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

async function seedAdmissions() {
  await seed(async (db) => {
    const round = db.collection("admissionRounds").doc(ROUND_ID);
    await round.set(roundDoc());
    await round.collection("stages").doc("s1").set(stageDoc());
    await db.collection("admissionApplications").doc(APPLICATION_ID).set(applicationDoc());
    await db
      .collection("admissionApplicationPrivate")
      .doc(APPLICATION_ID)
      .set({ accessRequirements: "I use a wheelchair and need a step-free room." });
    await db.collection("admissionReviews").doc(REVIEW_ID).set(reviewDoc());
    await db.collection("memberConductFlags").doc(APPLICANT).set(conductFlagDoc());
  });
}

/**
 * The six collections, each with the document to read, the id a create would
 * legitimately target, and a payload shaped like the real thing.
 *
 * `ref` takes a Firestore instance so the same table drives both the
 * rules-disabled seeding path and the client-hat path.
 */
const COLLECTIONS = [
  {
    label: "admissionRounds",
    ref: (db) => db.collection("admissionRounds"),
    docId: ROUND_ID,
    createId: "spring-2027-intake__z91kx0jq",
    payload: () => roundDoc({ status: "draft" }),
    update: { status: "cancelled" },
  },
  {
    label: "admissionRounds/{roundId}/stages",
    ref: (db) => db.collection("admissionRounds").doc(ROUND_ID).collection("stages"),
    docId: "s1",
    createId: "s2",
    payload: () => stageDoc(),
    update: { manualReleasedAt: new Date() },
  },
  {
    label: "admissionApplications",
    ref: (db) => db.collection("admissionApplications"),
    docId: APPLICATION_ID,
    createId: `${ROUND_ID}__drafter`,
    payload: () => applicationDoc({ uid: "drafter", status: "draft" }),
    update: { status: "accepted" },
  },
  {
    label: "admissionApplicationPrivate",
    ref: (db) => db.collection("admissionApplicationPrivate"),
    docId: APPLICATION_ID,
    createId: `${ROUND_ID}__drafter`,
    payload: () => ({ accessRequirements: "Planted." }),
    update: { accessRequirements: "Rewritten." },
  },
  {
    label: "admissionReviews",
    ref: (db) => db.collection("admissionReviews"),
    docId: REVIEW_ID,
    createId: `${ROUND_ID}__${APPLICANT}__drafter`,
    payload: () => reviewDoc({ reviewerUid: "drafter" }),
    update: { total: 999 },
  },
  {
    label: "memberConductFlags",
    ref: (db) => db.collection("memberConductFlags"),
    docId: APPLICANT,
    createId: "drafter",
    payload: () => conductFlagDoc(),
    update: { flagged: false },
  },
];

// ===========================================================================
// The blanket denial, verb by verb and hat by hat
// ===========================================================================

describe("admissions — no client reads anything, admins included", () => {
  for (const entry of COLLECTIONS) {
    it(`refuses every GET and every LIST on ${entry.label}`, async () => {
      await seedCast();
      await seedAdmissions();
      for (const uid of HATS) {
        const db = await asUser(uid);
        await assertFails(entry.ref(db).doc(entry.docId).get());
        await assertFails(entry.ref(db).get());
      }
      const anon = await asAnon();
      await assertFails(entry.ref(anon).doc(entry.docId).get());
      await assertFails(entry.ref(anon).get());
    });
  }
});

describe("admissions — no client writes anything, admins included", () => {
  for (const entry of COLLECTIONS) {
    it(`refuses CREATE, UPDATE and DELETE on ${entry.label}`, async () => {
      await seedCast();
      await seedAdmissions();
      for (const uid of HATS) {
        const db = await asUser(uid);
        // The create targets a WELL-FORMED deterministic id, not a random
        // one: these ids are constructible by anyone holding a round id and
        // a uid, so this is the request a leak would actually serve.
        await assertFails(entry.ref(db).doc(entry.createId).set(entry.payload()));
        await assertFails(entry.ref(db).doc(entry.docId).update(entry.update));
        await assertFails(entry.ref(db).doc(entry.docId).delete());
      }
      const anon = await asAnon();
      await assertFails(entry.ref(anon).doc(entry.createId).set(entry.payload()));
      await assertFails(entry.ref(anon).doc(entry.docId).delete());
    });
  }
});

// ===========================================================================
// The reads that would have looked reasonable
// ===========================================================================

describe("admissions — the plausible reads, refused for their own reasons", () => {
  it("refuses an APPLICANT their own application row", async () => {
    // The sharpest one. The row carries `evidence.facilitatorNotes` (a
    // facilitator's private written assessment of this person) and
    // `outcome.reason` alongside `outcome.reasonShared: false` — the tick the
    // decider deliberately did NOT set. An own-row read hands the applicant
    // both from the browser console.
    await seedCast();
    await seedAdmissions();
    const db = await asUser(APPLICANT);
    await assertFails(db.collection("admissionApplications").doc(APPLICATION_ID).get());
    await assertFails(
      db.collection("admissionApplications").where("uid", "==", APPLICANT).get(),
    );
    // And their own access-requirements answer, which is health data.
    await assertFails(
      db.collection("admissionApplicationPrivate").doc(APPLICATION_ID).get(),
    );
  });

  it("refuses a ROUND REVIEWER the round document and the review rows", async () => {
    // `sucom` is in `round.reviewerUids`, so this is the actor with the
    // strongest claim to a signed-in read. The round carries live
    // `applicationCounts` and `finalDeciderUid`; the review rows would let
    // them enumerate who scored whom, which is the correlation a name-blind
    // process exists to prevent. Both come through routes instead.
    await seedCast();
    await seedAdmissions();
    const db = await asUser(REVIEWER);
    await assertFails(db.collection("admissionRounds").doc(ROUND_ID).get());
    await assertFails(
      db.collection("admissionReviews").where("roundId", "==", ROUND_ID).get(),
    );
    // Not even their OWN review row.
    await assertFails(db.collection("admissionReviews").doc(REVIEW_ID).get());
  });

  it("refuses a FLAGGED MEMBER their own conduct flag, and an admin theirs too", async () => {
    // The whole reason this is not a field on users/{uid}: that document is
    // own-row readable AND AuthProvider holds a live onSnapshot on it, so the
    // reason would stream into the flagged member's browser on every authed
    // page and could expose the reporter.
    await seedCast();
    await seedAdmissions();
    const flagged = await asUser(APPLICANT);
    await assertFails(flagged.collection("memberConductFlags").doc(APPLICANT).get());
    // Admins read it through the Members route, not from a client, so the
    // rule stays a single unconditional deny with nothing to get() wrong.
    const admin = await asUser("admin1");
    await assertFails(admin.collection("memberConductFlags").doc(APPLICANT).get());
  });

  it("refuses a FRESHER watching the intake counters move", async () => {
    // `applicationCounts` is live. A signed-in read would let any account
    // watch a competitive intake's submitted / accepted / rejected numbers
    // through the week their own application is being decided.
    await seedCast();
    await seedAdmissions();
    for (const uid of ["pending1", "member1"]) {
      const db = await asUser(uid);
      await assertFails(db.collection("admissionRounds").doc(ROUND_ID).get());
      await assertFails(db.collection("admissionRounds").where("status", "==", "open").get());
    }
  });

  it("refuses a SIGNED-IN account the stage questions before release, and after it", async () => {
    // The release boundary is enforced by a route calling isStageReleased.
    // The rule's job is only to make sure there is no second path to the
    // questions, and there is not — the subcollection is unreadable whatever
    // the release dates say.
    await seedCast();
    await seedAdmissions();
    const stages = (db) =>
      db.collection("admissionRounds").doc(ROUND_ID).collection("stages");
    for (const uid of HATS) {
      const db = await asUser(uid);
      await assertFails(stages(db).doc("s1").get());
      await assertFails(stages(db).get());
    }
    // Including a collection-group query, which is how somebody would try to
    // reach a subcollection without knowing the parent id.
    const db = await asUser("member1");
    await assertFails(db.collectionGroup("stages").get());
  });
});

// ===========================================================================
// The `questions` scanner
// ===========================================================================

/**
 * Paths the scanner walks. Deliberately includes the client-readable course
 * collections as well as the admissions ones: the failure this guards
 * against is question text being COPIED somewhere convenient, and the
 * convenient places are the documents an editor already loads.
 */
const SCANNED = [
  { label: "courseRuns", ref: (db) => db.collection("courseRuns") },
  { label: "courses", ref: (db) => db.collection("courses") },
  { label: "admissionRounds", ref: (db) => db.collection("admissionRounds") },
  { label: "admissionApplications", ref: (db) => db.collection("admissionApplications") },
  {
    label: "admissionRounds/{roundId}/stages",
    ref: (db) => db.collection("admissionRounds").doc(ROUND_ID).collection("stages"),
  },
];

/**
 * Every seeded document that BOTH carries a `questions` key AND can be read
 * by a plain member client. Readability is PROBED against the live rules
 * rather than declared in a list here, so the scanner cannot go stale when a
 * rule changes.
 */
async function readableDocsCarryingQuestions(uid = "member1") {
  const found = [];
  const client = await asUser(uid);
  for (const entry of SCANNED) {
    let docs = [];
    await seed(async (db) => {
      const snap = await entry.ref(db).get();
      docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    });
    for (const d of docs) {
      if (!("questions" in d.data)) continue;
      try {
        await entry.ref(client).doc(d.id).get();
        found.push(`${entry.label}/${d.id}`);
      } catch {
        // Unreadable, which is the whole point for a stage.
      }
    }
  }
  return found;
}

describe("admissions — question text never sits on a readable document", () => {
  it("finds no readable document carrying questions across the real fixtures", async () => {
    await seedCast();
    await seedAdmissions();
    await seed(async (db) => {
      await db.collection("courseRuns").doc("run1").set(runDoc("run1"));
      await db.collection("courses").doc("course1").set({
        title: "AI Safety Fundamentals",
        tagline: "Eight weeks, no prior experience needed",
        summaryBlocks: [],
        track: "general",
        level: "",
        estimatedWeeklyHours: null,
        status: "published",
        showcaseRunId: null,
        authorUid: "drafter",
        collaboratorUids: [],
        destroying: false,
        destroyAuditId: "",
        archived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // The stage DOES carry questions, and it is the one document that may.
    let stageData = null;
    await seed(async (db) => {
      const snap = await db
        .collection("admissionRounds")
        .doc(ROUND_ID)
        .collection("stages")
        .doc("s1")
        .get();
      stageData = snap.data();
    });
    assert.equal(Array.isArray(stageData.questions), true);
    assert.equal(stageData.questions.length, 1);

    assert.deepEqual(await readableDocsCarryingQuestions(), []);
  });

  it("SELF-CHECK — the scanner catches a leak planted on a readable document", async () => {
    // Without this, the test above would pass just as happily if the scanner
    // were broken, if `courseRuns` had stopped being readable, or if the
    // probe swallowed every error. Plant the exact mistake the rule exists to
    // prevent and watch it get found.
    await seedCast();
    await seed(async (db) => {
      await db
        .collection("courseRuns")
        .doc("leak")
        .set(
          runDoc("leak", {
            questions: [
              { id: "q1", type: "longText", label: "Why do you want to do this?", required: true },
            ],
          }),
        );
    });
    assert.deepEqual(await readableDocsCarryingQuestions(), ["courseRuns/leak"]);
  });
});

// ===========================================================================
// The list regression
// ===========================================================================

describe("admissions — a 25-document list on a readable sibling still serves", () => {
  it("lets a member list 25 course runs, and refuses 25 admission rounds", async () => {
    // WHAT THIS PROVES. Firestore evaluates a read rule PER DOCUMENT and caps
    // the document lookups one request may make, so a read rule that reaches
    // for a second document keyed off the row it is evaluating fails a long
    // list while passing every single-document test in this file. That is the
    // failure mode the courses rules already carry a warning about
    // ("NEVER use this in a READ rule"), and the shape a helper added to this
    // region in a hurry would take.
    //
    // WHAT IT DOES NOT PROVE. A rule reaching for the SAME document every
    // time (`isAdmin()`, which reads the caller's own user doc) is cached
    // within the request and lists fine at any size. This test cannot see
    // that, and it is not meant to: the reason there is no `get()` anywhere
    // in the admissions region is that there is no read rule at all to put
    // one in, which the second half asserts.
    await seedCast();
    await seed(async (db) => {
      for (let i = 0; i < 25; i += 1) {
        const id = `run${String(i).padStart(2, "0")}`;
        await db.collection("courseRuns").doc(id).set(runDoc(id));
      }
      for (let i = 0; i < 25; i += 1) {
        const id = `round-${String(i).padStart(2, "0")}__aaaaaaaa`;
        await db.collection("admissionRounds").doc(id).set(roundDoc());
      }
    });

    const db = await asUser("member1");
    const runs = await assertSucceeds(db.collection("courseRuns").get());
    assert.equal(runs.size, 25);

    // The admissions side of the same page size: refused on permissions, not
    // on a document-access budget, and refused identically at one document
    // and at twenty-five.
    await assertFails(db.collection("admissionRounds").get());
    await assertFails(db.collection("admissionRounds").limit(1).get());
    await assertFails(db.collection("admissionRounds").limit(25).get());
  });
});

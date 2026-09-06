/**
 * Rules tests for the three blocks the deletion work adds or changes:
 * `memberRecords` (with its `applications` subcollection), `destroyAudits`,
 * and the `worksheets` delete that is now closed to every client.
 *
 * ## memberRecords
 *
 * The collection exists because of one rule the owner set above every other
 * decision in the deletion work: A DESTROY NEVER DELETES WHAT THE COMMITTEE
 * WANTS TO REMEMBER ABOUT A PERSON. Two properties are the whole of it, and
 * both are asserted here for every hat rather than for the ones that seem
 * likely:
 *
 *  - READ is admin and SU-RECOGNISED COMMITTEE. Deliberately the same trust
 *    boundary as the `users` collection and deliberately not a new one: an
 *    entry names a person, what they asked the society for and what the
 *    society decided, which is roster-tier knowledge. Non-SU committee are
 *    scoped to what they are explicitly added to and get nothing here, which
 *    is the split `suRecognised` exists to draw.
 *  - WRITE is shut to every client, ADMINS INCLUDED. An entry copies reviewer
 *    notes and scores out of `admissionReviews`, which is `read, write: if
 *    false` precisely so no client can enumerate who scored whom; a
 *    client-writable entry would be a way to put words in a named reviewer's
 *    mouth about a named applicant, and once the round is destroyed the entry
 *    is the only surviving evidence of either.
 *
 * The subcollection gets its own block and its own tests because subcollections
 * do NOT inherit their parent's rules. Without that block the entries fall to
 * deny-by-default and the read granted on the parent reaches only a document
 * carrying a uid and a timestamp, which is the sort of failure that reads as
 * "the feature is empty" rather than as an error.
 *
 * ## destroyAudits
 *
 * The `courseDeletions` and `courseAudit` posture verbatim: admin read, no
 * client write at all. This log is the only surviving evidence of a destroy,
 * because the rows it describes are gone, so a client able to touch it could
 * rewrite the record of its own cascade.
 *
 * ## worksheets delete
 *
 * One assertion flips in `worksheets.test.mjs` (the author used to be allowed)
 * and the refusals for every hat live here. A document delete is not the whole
 * deletion: the question images sit in Storage under
 * `worksheet-images/{worksheetId}` and rules cannot cascade, and "is there an
 * open circulation of this worksheet" is a cross-collection question rules
 * cannot ask. Both are the route's job, and the `events` collection is the
 * precedent.
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
  await getTestEnv("member-records");
});
after(cleanup);
afterEach(clearData);

/**
 * One of every hat the rules distinguish, plus `subject`, whose record the
 * tests read: a plain member with an entry of their own, so the own-row
 * carve-out can be refused explicitly rather than by omission. `flagged` is the
 * near miss: `suRecognised` set on somebody who is not committee.
 */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("su1", { role: "committee", suRecognised: true });
  await seedUser("nonsu1", { role: "committee" });
  await seedUser("member1", { role: "member" });
  await seedUser("subject", { role: "member" });
  await seedUser("pending1", { role: "pending" });
  await seedUser("rejected1", { role: "rejected" });
  // The permission holders, because a permission is not a role and must not
  // quietly buy a read of member history.
  await seedUser("circulator", {
    role: "member",
    permissions: { circulateWorksheet: true },
  });
  await seedUser("drafter", { role: "member", permissions: { draftCourse: true } });
  // `suRecognised` WITHOUT the committee role. `isSuCommittee()` is
  // `hasRole(['committee']) && suRecognised`, so the flag alone grants nothing,
  // and that is worth an assertion rather than a reading of the helper: the flag
  // is the trust boundary this whole block hangs on, and the day somebody
  // rewrites `isSuCommittee()` to test the flag first, a member left carrying a
  // stale flag (an admin demoted them and the clear did not land) would
  // silently gain every member's application history.
  await seedUser("flagged", { role: "member", suRecognised: true });
}

/** Every hat that must be refused a member record, in one list. */
const REFUSED_HATS = [
  "nonsu1",
  "member1",
  "subject",
  "pending1",
  "rejected1",
  "circulator",
  "drafter",
  "flagged",
];

function recordEntry(overrides = {}) {
  return {
    roundId: "autumn-2026",
    roundTitle: "Autumn 2026 intake",
    roundKind: "enrolment",
    appliedFor: ["Technical incubator"],
    appliedAt: new Date("2026-09-01T09:00:00Z"),
    submittedAt: new Date("2026-09-08T18:30:00Z"),
    outcome: { decision: "accept", status: "accepted", targetRunId: "run-tech" },
    scoreSummary: { reviewerCount: 2, total: 14, mean: 7, byCriterion: { fit: 3.5 } },
    reviewerNotes: [
      {
        reviewerUid: "su1",
        reviewerName: "A Reviewer",
        recommendation: "advance",
        total: 9,
        notes: "Clear motivation, some gaps on the technical side.",
      },
    ],
    writtenAt: new Date("2026-09-21T10:00:00Z"),
    writtenBy: "settle",
    writtenByUid: "admin1",
    ...overrides,
  };
}

/** Write a record the way an Admin SDK route would (rules bypassed). */
async function seedRecord(uid = "subject", roundId = "autumn-2026") {
  await seed(async (db) => {
    const parent = db.collection("memberRecords").doc(uid);
    await parent.set({ uid, updatedAt: new Date() });
    await parent.collection("applications").doc(roundId).set(recordEntry({ roundId }));
  });
}

function auditRow(overrides = {}) {
  return {
    kind: "admission-round",
    targetId: "autumn-2026",
    label: "Autumn 2026 intake",
    startedAt: new Date("2026-09-22T11:00:00Z"),
    startedByUid: "admin1",
    startedByName: "An Admin",
    deleted: { applications: 12, reviews: 30 },
    completedAt: null,
    resumeCount: 0,
    passInFlightUntil: null,
    ...overrides,
  };
}

async function seedAudit(id = "d1", overrides = {}) {
  await seed(async (db) => {
    await db.collection("destroyAudits").doc(id).set(auditRow(overrides));
  });
}

async function seedWorksheet(id = "w1", overrides = {}) {
  await seed(async (db) => {
    await db
      .collection("worksheets")
      .doc(id)
      .set({
        title: "Committee onboarding",
        description: "",
        folderId: null,
        authorUid: "su1",
        private: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      });
  });
}

// ---------------------------------------------------------------------------
// memberRecords: read
// ---------------------------------------------------------------------------

describe("memberRecords: read is admin and SU-recognised committee", () => {
  it("lets an admin read the parent document, the entry and a list", async () => {
    await seedCast();
    await seedRecord();
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("memberRecords").doc("subject").get());
    await assertSucceeds(
      db
        .collection("memberRecords")
        .doc("subject")
        .collection("applications")
        .doc("autumn-2026")
        .get(),
    );
    await assertSucceeds(
      db.collection("memberRecords").doc("subject").collection("applications").get(),
    );
  });

  it("lets an SU-recognised committee member read the same three", async () => {
    // The point of writing the record is that a later application can be
    // graded with this history in view, and the people grading are committee.
    // A read tier of admin-only would leave the record unreadable by the
    // people it exists for.
    await seedCast();
    await seedRecord();
    const db = await asUser("su1");
    await assertSucceeds(db.collection("memberRecords").doc("subject").get());
    await assertSucceeds(
      db
        .collection("memberRecords")
        .doc("subject")
        .collection("applications")
        .doc("autumn-2026")
        .get(),
    );
    await assertSucceeds(
      db.collection("memberRecords").doc("subject").collection("applications").get(),
    );
  });

  it("refuses every other hat, non-SU committee included", async () => {
    // Non-SU committee is the interesting one: they hold the committee role
    // and are refused member PII in the users collection on exactly this
    // boundary. A record of what somebody applied for and how they scored is
    // the same tier of knowledge, so it moves with it.
    await seedCast();
    await seedRecord();
    for (const uid of REFUSED_HATS) {
      const db = await asUser(uid);
      await assertFails(db.collection("memberRecords").doc("subject").get());
      await assertFails(
        db
          .collection("memberRecords")
          .doc("subject")
          .collection("applications")
          .doc("autumn-2026")
          .get(),
      );
      await assertFails(
        db.collection("memberRecords").doc("subject").collection("applications").get(),
      );
    }
    const anon = await asAnon();
    await assertFails(anon.collection("memberRecords").doc("subject").get());
  });

  it("refuses a member reading their OWN record", async () => {
    // The carve-out that looks obviously fair and is not. The entry holds the
    // reviewers' notes verbatim, including honest reservations, and the
    // round's own rule is that those are disclosed on request rather than
    // streamed to their subject from a browser console. Disclosure is a
    // decision somebody makes; a read rule is not.
    await seedCast();
    await seedRecord("member1");
    const db = await asUser("member1");
    await assertFails(db.collection("memberRecords").doc("member1").get());
    await assertFails(
      db
        .collection("memberRecords")
        .doc("member1")
        .collection("applications")
        .doc("autumn-2026")
        .get(),
    );
  });

  it("refuses a collection-group read of every entry, admins included", async () => {
    // The block is written for the ADDRESSED path
    // `memberRecords/{uid}/applications/{roundId}`, so a collection-group query
    // matches no rule and is denied. That is the design rather than a gap: the
    // record hangs off the person and is read one person at a time, and a
    // sweep of every entry the society holds is a different thing that would
    // need its own rule and its own argument.
    await seedCast();
    await seedRecord();
    for (const uid of ["admin1", "su1", "member1"]) {
      const db = await asUser(uid);
      await assertFails(db.collectionGroup("applications").get());
    }
  });
});

// ---------------------------------------------------------------------------
// memberRecords: write
// ---------------------------------------------------------------------------

describe("memberRecords: write is shut to every client", () => {
  it("refuses create, update and delete on the parent from every hat", async () => {
    await seedCast();
    await seedRecord();
    for (const uid of ["admin1", "su1", ...REFUSED_HATS]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("memberRecords").doc("brand-new").set({ uid: "brand-new" }),
      );
      await assertFails(
        db.collection("memberRecords").doc("subject").update({ updatedAt: new Date() }),
      );
      await assertFails(db.collection("memberRecords").doc("subject").delete());
    }
  });

  it("refuses create, update and delete on an entry from every hat", async () => {
    await seedCast();
    await seedRecord();
    for (const uid of ["admin1", "su1", ...REFUSED_HATS]) {
      const db = await asUser(uid);
      const applications = db
        .collection("memberRecords")
        .doc("subject")
        .collection("applications");
      await assertFails(applications.doc("spring-2027").set(recordEntry()));
      await assertFails(applications.doc("autumn-2026").update({ roundTitle: "Other" }));
      await assertFails(applications.doc("autumn-2026").delete());
    }
  });

  it("refuses an admin rewriting the outcome on somebody's record", async () => {
    // The specific attack the posture exists for. Once the round is destroyed
    // this entry is the only account of what the committee decided, and an
    // admin who could edit it could change that account with nothing left to
    // check it against.
    await seedCast();
    await seedRecord();
    const db = await asUser("admin1");
    await assertFails(
      db
        .collection("memberRecords")
        .doc("subject")
        .collection("applications")
        .doc("autumn-2026")
        .update({ outcome: { decision: "reject", status: "rejected", targetRunId: null } }),
    );
  });

  it("refuses an SU committee member rewriting a reviewer's notes", async () => {
    // The other half of the same attack, and the reason the write rule is not
    // merely defence in depth: the notes are somebody else's writing about a
    // named person, and the reviewer whose name is on them cannot see this
    // collection at all unless they happen to be SU-recognised.
    await seedCast();
    await seedRecord();
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("memberRecords")
        .doc("subject")
        .collection("applications")
        .doc("autumn-2026")
        .update({
          reviewerNotes: [
            {
              reviewerUid: "su1",
              reviewerName: "A Reviewer",
              recommendation: "decline",
              total: 2,
              notes: "I never wrote this.",
            },
          ],
        }),
    );
  });

  it("refuses a member seeding a record for themselves before anyone writes one", async () => {
    // Nothing exists at the path yet, which is the create case the rule has to
    // cover as well as the update one: a member who could mint their own entry
    // would be writing the committee's opinion of them.
    await seedCast();
    const db = await asUser("member1");
    await assertFails(db.collection("memberRecords").doc("member1").set({ uid: "member1" }));
    await assertFails(
      db
        .collection("memberRecords")
        .doc("member1")
        .collection("applications")
        .doc("autumn-2026")
        .set(recordEntry()),
    );
  });
});

// ---------------------------------------------------------------------------
// destroyAudits
// ---------------------------------------------------------------------------

describe("destroyAudits: read is admin-only", () => {
  it("lets an admin read a row and list the log", async () => {
    await seedCast();
    await seedAudit();
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("destroyAudits").doc("d1").get());
    await assertSucceeds(
      db.collection("destroyAudits").where("targetId", "==", "autumn-2026").get(),
    );
  });

  it("refuses every other hat, SU-recognised committee included", async () => {
    // Wider than memberRecords is on read, and narrower here on purpose. A
    // member record is knowledge about a person that committee are meant to
    // use; this is a record of an admin-only act, and only admins destroy.
    await seedCast();
    await seedAudit();
    for (const uid of ["su1", ...REFUSED_HATS]) {
      const db = await asUser(uid);
      await assertFails(db.collection("destroyAudits").doc("d1").get());
      await assertFails(
        db.collection("destroyAudits").where("targetId", "==", "autumn-2026").get(),
      );
    }
    const anon = await asAnon();
    await assertFails(anon.collection("destroyAudits").doc("d1").get());
  });
});

describe("destroyAudits: write is shut to everyone", () => {
  it("refuses create, update and delete from every hat, admins included", async () => {
    await seedCast();
    await seedAudit();
    for (const uid of ["admin1", "su1", ...REFUSED_HATS]) {
      const db = await asUser(uid);
      await assertFails(db.collection("destroyAudits").doc("d2").set(auditRow()));
      await assertFails(
        db.collection("destroyAudits").doc("d1").update({ label: "Something else" }),
      );
      await assertFails(db.collection("destroyAudits").doc("d1").delete());
    }
  });

  it("refuses an admin closing an interrupted row by hand", async () => {
    // A row with a null `completedAt` is the durable evidence that a cascade
    // died half way. An admin who could stamp it complete could make an
    // interrupted destroy look finished, which is the one lie this log has to
    // be unable to tell.
    await seedCast();
    await seedAudit();
    const db = await asUser("admin1");
    await assertFails(
      db.collection("destroyAudits").doc("d1").update({ completedAt: new Date() }),
    );
  });

  it("refuses an admin editing the counts on a finished row", async () => {
    await seedCast();
    await seedAudit("d1", { completedAt: new Date("2026-09-22T11:04:00Z") });
    const db = await asUser("admin1");
    await assertFails(
      db.collection("destroyAudits").doc("d1").update({ deleted: { applications: 0 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// worksheets: the delete that moved to a route
// ---------------------------------------------------------------------------

describe("worksheets: no client delete, for anybody", () => {
  it("refuses the AUTHOR deleting their own worksheet", async () => {
    // This used to be allowed, and the argument for it was sound as far as it
    // went: a circulation carries its own copy of the items, so deleting the
    // library document takes nothing away from anybody it was sent to. What it
    // missed is that the document is not the whole thing. Its question and
    // option images live in Storage under `worksheet-images/{worksheetId}`,
    // rules cannot cascade, and a client delete leaves every one of them
    // behind under a path whose document is gone, where nothing can name them
    // to clear them.
    await seedCast();
    await seedWorksheet();
    const db = await asUser("su1");
    await assertFails(db.collection("worksheets").doc("w1").delete());
  });

  it("refuses an ADMIN deleting one", async () => {
    // The second half of the reason, and the one an admin would hit first: a
    // worksheet with an open circulation is refused, and "is there an open
    // circulation of this worksheet" is a cross-collection question rules
    // cannot ask. Left as a client delete, that refusal would be a sentence in
    // the dialog with nothing behind it.
    await seedCast();
    await seedWorksheet();
    const db = await asUser("admin1");
    await assertFails(db.collection("worksheets").doc("w1").delete());
  });

  it("refuses every other hat too, and still lets the author EDIT it", async () => {
    // The delete moving to a route must not have taken the ordinary authoring
    // powers with it, so the update is asserted in the same test: a change that
    // closed both would pass a test that only checked the delete.
    await seedCast();
    await seedWorksheet();
    for (const uid of REFUSED_HATS) {
      const db = await asUser(uid);
      await assertFails(db.collection("worksheets").doc("w1").delete());
    }
    const author = await asUser("su1");
    await assertSucceeds(
      author.collection("worksheets").doc("w1").update({
        title: "Committee onboarding v2",
        description: "",
        authorUid: "su1",
        private: false,
        items: [],
      }),
    );
  });
});

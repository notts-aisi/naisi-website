/**
 * Rules tests for membership (V3 W3 PR27).
 *
 * Two collections, `membershipPeriods` and `memberships`, plus the CURRENT
 * pointer at `config/membership`. All three are shut to every client in both
 * directions, and this file is the proof that "every role" really does mean
 * every role, admins included.
 *
 * ## Why read:false and not an own-row read on `memberships`
 *
 * The own-row read is the one that looks obviously safe, and it is the one
 * that has to be refused. A `get` of a MISSING document evaluates
 * `resource.data.uid` against null and denies, so "this member has no
 * membership row" and "this member may not look" arrive in the browser as the
 * SAME permission-denied error. The profile badge could not tell a member with
 * no membership from a broken rule, which is the trap already recorded at
 * useMyApplication.ts:26-33. The member path is GET /api/membership/me, which
 * answers `null` and means it.
 *
 * ## Why no client writes
 *
 * A grant moves three things together: the membership row, the
 * `users.paidMembershipYears` cache the badges read, and the period's cached
 * per-tier totals. Rules cannot express "these three move as one" and cannot
 * express the ten-year cap pre-check. One Admin SDK route owns all three.
 *
 * ## The cache-forgery guard
 *
 * The other half of the design lives in the `users` block: `paidMembershipYears`
 * is pinned absent-at-create and unchanged-on-self-update. Those refusals are
 * re-asserted at the foot of this file, because they are what stops a member
 * writing themselves a membership badge with no row behind it now that the
 * badge means something recorded.
 *
 * ## membershipImports, and its rows subcollection (PR28)
 *
 * The uploaded SU list and one row per line of it. Both shut in both
 * directions at every role. Two reasons worth stating:
 *
 *  - a row carries a NAME and an EMAIL for somebody on the Students' Union's
 *    list, and for most rows that is a person with no account here at all.
 *    That is not roster data an SU-recognised committee member may browse;
 *  - the commit route reads its rows from Firestore precisely so a browser
 *    cannot assert a match and its own confirmation together. A client that
 *    could WRITE a row could grant itself a membership through the commit
 *    route without ever touching `memberships`.
 *
 * Rules do not inherit downwards, so the subcollection has its own match block
 * and its own tests. A block covering only the parent would leave every row
 * readable, which is the failure this file exists to catch.
 *
 * ## Mutation check (each restored bit-exact afterwards)
 *
 *  1. Change `match /memberships/{membershipId}` to
 *     `allow read: if isSignedIn() && resource.data.uid == request.auth.uid`
 *     -> the own-row read tests go red (and, tellingly, the missing-row one
 *     still denies, which is the whole argument).
 *  2. Change `match /membershipPeriods/{periodId}` to
 *     `allow read: if isSignedIn()` -> the period read tests go red.
 *  3. Delete either `paidMembershipYears` pin in the users block -> the
 *     cache-forgery tests at the foot go red.
 *  4. Delete the nested `match /rows/{rowId}` block, keeping the parent ->
 *     every rows test goes red and the parent tests stay green, which is the
 *     whole reason the subcollection is tested separately.
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
  // Unique per file: a shared project id lets one file's clearFirestore()
  // wipe another's fixtures mid-test (see harness.mjs).
  await getTestEnv("membership");
});
after(cleanup);
afterEach(clearData);

const PERIOD_ID = "2026-27";
const MEMBERSHIP_ID = `member1__${PERIOD_ID}`;
const BATCH_ID = "import-2026-27-2026-10-09t14-31__k3f9a2b1";

/**
 * Everyone whose access is worth a separate answer: a plain member (who owns
 * the row), a non-SU committee member, an SU-recognised committee member (the
 * PII tier membership is deliberately NOT part of), a member holding
 * `manageMembership` (whose permission works through routes only), and an
 * admin.
 */
async function seedCast() {
  await seedUser("member1", { role: "member" });
  await seedUser("member2", { role: "member" });
  await seedUser("committee1", { role: "committee" });
  await seedUser("su1", { role: "committee", suRecognised: true });
  await seedUser("manager1", { role: "member", permissions: { manageMembership: true } });
  await seedUser("admin1", { role: "admin" });

  await seed(async (db) => {
    await db.collection("membershipPeriods").doc(PERIOD_ID).set({
      year: "2026/27",
      label: "Membership 2026/27",
      startsOn: "2026-09-01",
      endsOn: "2027-07-31",
      note: "Internal: chased the SU twice for this list",
      totals: { paid: 1, comped: 0, alumni: 0, staff: 0 },
      createdAt: new Date(),
      createdByUid: "admin1",
    });
    await db.collection("memberships").doc(MEMBERSHIP_ID).set({
      uid: "member1",
      periodId: PERIOD_ID,
      tier: "paid",
      source: "manual",
      matchedOn: "manual",
      provenance: { at: new Date(), byUid: "admin1" },
    });
    await db.collection("config").doc("membership").set({
      currentPeriodId: PERIOD_ID,
      updatedAt: new Date(),
      updatedByUid: "admin1",
    });
    await db.collection("membershipImports").doc(BATCH_ID).set({
      periodId: PERIOD_ID,
      filename: "su-list.csv",
      status: "dry-run",
      totalRows: 2,
      counts: { uniEmail: 1, personalEmail: 0, needsConfirm: 1, duplicate: 0, unmatched: 0 },
      committedRows: 0,
      skippedRows: 0,
      awaitingConfirm: 0,
      nextRowSeq: 1,
      uploadedAt: new Date(),
      uploadedByUid: "admin1",
      uploadedByName: "Sam Admin",
    });
    await db
      .collection("membershipImports")
      .doc(BATCH_ID)
      .collection("rows")
      .doc("0001")
      .set({
        seq: 1,
        line: 2,
        name: "Ada Lovelace",
        email: "ada@example.com",
        uniEmail: "ada@nottingham.ac.uk",
        tier: "paid",
        matchKind: "uni-email",
        matchedUid: "member1",
        matchNote: "",
        state: "pending",
        skipReason: "",
      });
  });
}

/** Every identity, including the ones that hold the most trust elsewhere. */
const EVERY_ROLE = ["member1", "member2", "committee1", "su1", "manager1", "admin1"];

describe("membershipPeriods is shut to every client", () => {
  it("refuses a read at every role, and to a signed-out visitor", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(db.collection("membershipPeriods").doc(PERIOD_ID).get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("membershipPeriods").doc(PERIOD_ID).get());
  });

  it("refuses a list at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(db.collection("membershipPeriods").get());
    }
  });

  it("refuses create, update and delete at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("membershipPeriods").doc("2027-28").set({ year: "2027/28" }),
      );
      await assertFails(
        db.collection("membershipPeriods").doc(PERIOD_ID).update({ label: "Mine now" }),
      );
      await assertFails(db.collection("membershipPeriods").doc(PERIOD_ID).delete());
    }
  });
});

describe("memberships is shut to every client", () => {
  it("refuses the OWN-ROW read, which is the one that looks safe", async () => {
    await seedCast();
    const db = await asUser("member1");
    await assertFails(db.collection("memberships").doc(MEMBERSHIP_ID).get());
  });

  it("refuses a read of a MISSING row too, which is why the own-row read is no use", async () => {
    // The whole argument for the route, in one case: with an own-row rule this
    // denial would be indistinguishable from the one above, so the browser
    // could never tell "no membership" from "not allowed".
    await seedCast();
    const db = await asUser("member2");
    await assertFails(db.collection("memberships").doc(`member2__${PERIOD_ID}`).get());
  });

  it("refuses somebody else's row at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(db.collection("memberships").doc(MEMBERSHIP_ID).get());
    }
  });

  it("refuses a query by uid, including the caller's own", async () => {
    await seedCast();
    const db = await asUser("member1");
    await assertFails(
      db.collection("memberships").where("uid", "==", "member1").get(),
    );
    const su = await asUser("su1");
    await assertFails(su.collection("memberships").where("uid", "==", "member1").get());
  });

  it("refuses create, update and delete at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("memberships").doc(`${uid}__${PERIOD_ID}`).set({
          uid,
          periodId: PERIOD_ID,
          tier: "paid",
          source: "manual",
          matchedOn: "manual",
        }),
      );
      await assertFails(
        db.collection("memberships").doc(MEMBERSHIP_ID).update({ tier: "staff" }),
      );
      await assertFails(db.collection("memberships").doc(MEMBERSHIP_ID).delete());
    }
  });

  it("refuses a signed-out visitor both ways", async () => {
    await seedCast();
    const anon = await asAnon();
    await assertFails(anon.collection("memberships").doc(MEMBERSHIP_ID).get());
    await assertFails(
      anon.collection("memberships").doc("anon__2026-27").set({ uid: "anon" }),
    );
  });
});

describe("config/membership, the CURRENT pointer", () => {
  it("is unreadable and unwritable at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(db.collection("config").doc("membership").get());
      await assertFails(
        db.collection("config").doc("membership").set({ currentPeriodId: "2025-26" }),
      );
    }
  });
});

describe("membershipImports is shut to every client", () => {
  it("refuses a read of the batch at every role, and to a signed-out visitor", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(db.collection("membershipImports").doc(BATCH_ID).get());
      await assertFails(db.collection("membershipImports").get());
    }
    const anon = await asAnon();
    await assertFails(anon.collection("membershipImports").doc(BATCH_ID).get());
  });

  it("refuses create, update and delete of a batch at every role", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("membershipImports").doc("mine").set({ periodId: PERIOD_ID }),
      );
      await assertFails(
        db.collection("membershipImports").doc(BATCH_ID).update({ status: "committed" }),
      );
      await assertFails(db.collection("membershipImports").doc(BATCH_ID).delete());
    }
  });
});

describe("the rows subcollection has its own block, and is shut too", () => {
  // Rules do not inherit downwards: a block covering only the parent would
  // leave every row of the SU list readable by any signed-in account.
  function rows(db) {
    return db.collection("membershipImports").doc(BATCH_ID).collection("rows");
  }

  it("refuses a read of a row at every role, and to a signed-out visitor", async () => {
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(rows(db).doc("0001").get());
      await assertFails(rows(db).get());
    }
    const anon = await asAnon();
    await assertFails(rows(anon).doc("0001").get());
  });

  it("refuses a query for the caller's own matched rows", async () => {
    // The row that names YOU is still a row of somebody else's file, and it
    // carries the address the SU holds for you rather than the one you gave us.
    await seedCast();
    const db = await asUser("member1");
    await assertFails(rows(db).where("matchedUid", "==", "member1").get());
  });

  it("refuses a collection-group read of every import row on the site", async () => {
    await seedCast();
    for (const uid of ["member1", "su1", "manager1", "admin1"]) {
      const db = await asUser(uid);
      await assertFails(db.collectionGroup("rows").get());
    }
  });

  it("refuses create, update and delete of a row at every role", async () => {
    // The commit route reads rows from Firestore, so a writable row is a
    // membership anybody can grant themselves without touching `memberships`.
    await seedCast();
    for (const uid of EVERY_ROLE) {
      const db = await asUser(uid);
      await assertFails(
        rows(db).doc("0002").set({
          seq: 2,
          matchKind: "uni-email",
          matchedUid: uid,
          tier: "paid",
          state: "pending",
        }),
      );
      await assertFails(rows(db).doc("0001").update({ matchedUid: uid }));
      await assertFails(rows(db).doc("0001").delete());
    }
  });
});

describe("users.paidMembershipYears stays the cache-forgery guard", () => {
  // Re-asserted here rather than left to courses.test.mjs, because the field
  // now means "there is a membership row behind this badge". A member who
  // could write it would wear a membership nobody granted, and the row it
  // claims would not exist.
  it("cannot be seeded on a self-created user document", async () => {
    const db = await asUser("newbie");
    const base = {
      uid: "newbie",
      email: "newbie@example.com",
      displayName: "New Person",
      role: "pending",
      createdAt: new Date(),
    };
    await assertFails(
      db.collection("users").doc("newbie").set({ ...base, paidMembershipYears: ["2026/27"] }),
    );
    await assertSucceeds(db.collection("users").doc("newbie").set(base));
  });

  it("cannot be set, extended or cleared by the member it describes", async () => {
    await seedCast();
    await seed(async (db) => {
      await db.collection("users").doc("member1").update({ paidMembershipYears: ["2026/27"] });
    });
    const db = await asUser("member1");
    await assertFails(
      db.collection("users").doc("member1").update({ paidMembershipYears: ["2026/27", "2027/28"] }),
    );
    await assertFails(
      db.collection("users").doc("member1").update({ paidMembershipYears: [] }),
    );
    // The control: an ordinary profile edit still goes through, so the pin is
    // a pin rather than a lock on the whole document.
    await assertSucceeds(db.collection("users").doc("member1").update({ title: "Member" }));
  });

  it("cannot be written onto another member by a manageMembership holder", async () => {
    // The permission works through the routes, which run on the Admin SDK.
    // It grants nothing client-direct, and it is deliberately not part of the
    // SU-recognised PII tier either.
    await seedCast();
    const manager = await asUser("manager1");
    await assertFails(
      manager.collection("users").doc("member1").update({ paidMembershipYears: ["2026/27"] }),
    );
    const su = await asUser("su1");
    await assertFails(
      su.collection("users").doc("member1").update({ paidMembershipYears: ["2026/27"] }),
    );
  });
});

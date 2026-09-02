/**
 * `dataExports`: the log of every CSV the site generates.
 *
 * The block is `allow read, write: if false` and this file proves it holds at
 * EVERY role, admins included. Both halves are deliberate:
 *
 *  - NOBODY WRITES. The actor of a logged export is almost always an admin,
 *    so an admin-writable log is a log its own subject can edit: delete the
 *    row, move its timestamp, shrink its rowCount. That is exactly the
 *    `courseAudit` and `courseDeletions` posture, for the reason stated
 *    there: an audit its own actor can amend is not an audit. Forgery is the
 *    other half, since a fabricated row attributes an export to somebody who
 *    never ran one.
 *
 *  - NOBODY READS. Admins reach the Exports tab through
 *    GET /api/admin/deliverability/exports on the Admin SDK, the same shape
 *    the deliverability send log already uses, so a client read rule would
 *    buy the product nothing while leaving the collection one `isAdmin()`
 *    typo away from readable. The rows also name which round and which cohort
 *    were taken, and when, which is not something to hand to a browser with
 *    no feature that needs it.
 *
 * The last two cases are the attacks written out: an admin tidying away the
 * record of their own export, and a committee member fabricating one.
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  asAnon,
  asUser,
  assertFails,
  cleanup,
  clearData,
  getTestEnv,
  seed,
  seedUser,
} from "../lib/harness.mjs";

before(async () => {
  await getTestEnv("exports");
});
after(cleanup);
afterEach(clearData);

/** One context per role, so "every role" is not a euphemism for "a member". */
async function everyRole() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("su1", { role: "committee", suRecognised: true });
  await seedUser("committee1", { role: "committee" });
  await seedUser("member1", { role: "member" });
  await seedUser("pending1", { role: "pending" });
  return [
    ["anonymous", await asAnon()],
    ["pending", await asUser("pending1")],
    ["member", await asUser("member1")],
    ["non-SU committee", await asUser("committee1")],
    ["SU committee", await asUser("su1")],
    ["admin", await asUser("admin1")],
  ];
}

const ROW_ID = "seeded-export-row";

/** A row shaped the way `logExport()` writes one. */
const ROW = {
  kind: "roster",
  actorUid: "admin1",
  actorName: "A Nother Admin",
  scope: { runId: "precourse-autumn-2026__aa11bb22" },
  rowCount: 42,
  filename: "roster-precourse-autumn-2026.csv",
  at: new Date("2026-09-16T10:00:00Z"),
  viaImpersonation: false,
};

async function seedRow() {
  await seed(async (db) => {
    await db.collection("dataExports").doc(ROW_ID).set(ROW);
  });
}

describe("dataExports", () => {
  it("cannot be read by anyone, at any role", async () => {
    await seedRow();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("dataExports").doc(ROW_ID).get(),
        `${label} must not read an export row`,
      );
      await assertFails(
        db.collection("dataExports").get(),
        `${label} must not list export rows`,
      );
    }
  });

  it("cannot be queried by anyone, even along the indexed axis", async () => {
    // (kind ASC, at DESC) is a real composite index, added for the Admin SDK
    // query behind the Exports tab. An index is not an access grant, and a
    // query is the shape somebody would try first.
    await seedRow();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db
          .collection("dataExports")
          .where("kind", "==", "roster")
          .orderBy("at", "desc")
          .limit(20)
          .get(),
        `${label} must not query export rows`,
      );
    }
  });

  it("cannot be created by anyone, at any role", async () => {
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db
          .collection("dataExports")
          .doc(`created-by-${label.replace(/\W+/g, "-")}`)
          .set(ROW),
        `${label} must not create an export row`,
      );
      await assertFails(
        db.collection("dataExports").add(ROW),
        `${label} must not append an export row`,
      );
    }
  });

  it("cannot be updated or deleted by anyone, at any role", async () => {
    await seedRow();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("dataExports").doc(ROW_ID).set({ rowCount: 1 }, { merge: true }),
        `${label} must not update an export row`,
      );
      await assertFails(
        db.collection("dataExports").doc(ROW_ID).delete(),
        `${label} must not delete an export row`,
      );
    }
  });

  it("AUDIT INTEGRITY: an admin cannot tidy away the record of their own export", async () => {
    // The whole point of the write rule. The admin named on the row is the
    // one person with a motive to remove it, and they are the role most
    // likely to be able to. Both edits below are refused.
    await seedRow();
    await seedUser("admin1", { role: "admin" });
    const db = await asUser("admin1");
    await assertFails(db.collection("dataExports").doc(ROW_ID).delete());
    await assertFails(
      db.collection("dataExports").doc(ROW_ID).set({ rowCount: 0 }, { merge: true }),
    );
  });

  it("FORGERY: a committee member cannot write a row naming somebody else", async () => {
    await seedUser("su1", { role: "committee", suRecognised: true });
    const db = await asUser("su1");
    await assertFails(
      db.collection("dataExports").add({
        ...ROW,
        actorUid: "admin1",
        actorName: "A Nother Admin",
      }),
    );
  });
});

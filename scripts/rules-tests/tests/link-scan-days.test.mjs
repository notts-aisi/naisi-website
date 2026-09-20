/**
 * `linkScanDays`: how many times each printed QR code was scanned, per day.
 *
 * The block is `allow read, write: if false` and this file proves it holds at
 * EVERY role, admins included.
 *
 *  - NOBODY WRITES. The count is only worth reading if the one thing that can
 *    move it is a scan. The increment comes from the Admin SDK inside
 *    POST /api/q/[slug]/scan, behind a throttle and a check that the code
 *    exists. A client-writable counter is a number anybody holding a session
 *    can set to whatever makes their poster look best, or zero out.
 *
 *  - NOBODY READS, yet. Nothing in a browser reads this collection today, so a
 *    read rule would buy the product nothing. When a dashboard needs one it
 *    arrives with the query that uses it and an entry for that query in
 *    `client-queries.registry.mjs`, not before.
 *
 * The last case is the attack written out: somebody inflating their own code.
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
  await getTestEnv("link-scan-days");
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

const DAY_ID = "poster__2026-09-21";

/** A day shaped the way `recordScan()` writes one. */
const DAY = {
  slug: "poster",
  date: "2026-09-21",
  count: 42,
  hours: { "10": 12, "11": 30 },
};

async function seedDay() {
  await seed(async (db) => {
    await db.collection("linkScanDays").doc(DAY_ID).set(DAY);
  });
}

describe("linkScanDays", () => {
  it("cannot be read by anyone, at any role", async () => {
    await seedDay();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("linkScanDays").doc(DAY_ID).get(),
        `${label} must not read a scan day`,
      );
      await assertFails(
        db.collection("linkScanDays").get(),
        `${label} must not list scan days`,
      );
    }
  });

  it("cannot be queried by anyone, along the axis a dashboard would use", async () => {
    // A date range is the shape somebody would try first, and a single-field
    // range needs no declared index, so nothing but the rule stands in its way.
    await seedDay();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("linkScanDays").where("date", ">=", "2026-09-01").get(),
        `${label} must not query scan days`,
      );
    }
  });

  it("cannot be created by anyone, at any role", async () => {
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db
          .collection("linkScanDays")
          .doc(`poster__created-by-${label.replace(/\W+/g, "-")}`)
          .set(DAY),
        `${label} must not create a scan day`,
      );
      await assertFails(
        db.collection("linkScanDays").add(DAY),
        `${label} must not append a scan day`,
      );
    }
  });

  it("cannot be updated or deleted by anyone, at any role", async () => {
    await seedDay();
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("linkScanDays").doc(DAY_ID).set({ count: 1 }, { merge: true }),
        `${label} must not update a scan day`,
      );
      await assertFails(
        db.collection("linkScanDays").doc(DAY_ID).delete(),
        `${label} must not delete a scan day`,
      );
    }
  });

  it("INFLATION: a committee member cannot raise the count on their own poster", async () => {
    // The whole point of the write rule. The person who designed a poster is
    // the one with a reason to want its number higher, and a committee member
    // is the role most likely to be signed in while looking at it.
    await seedDay();
    await seedUser("su1", { role: "committee", suRecognised: true });
    const db = await asUser("su1");
    await assertFails(
      db.collection("linkScanDays").doc(DAY_ID).set({ count: 9000 }, { merge: true }),
    );
    await assertFails(
      db.collection("linkScanDays").doc("poster__2026-09-22").set({ ...DAY, date: "2026-09-22" }),
    );
  });
});

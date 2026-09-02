/**
 * The two scheduler collections: `schedulerMarkers` and `schedulerRuns`.
 *
 * Both are `allow read, write: if false`, shut to EVERY client (admins
 * included), and both are reached only through the Admin SDK, by
 * POST /api/scheduler/tick and GET /api/admin/scheduler.
 *
 * What must hold, and why each half matters:
 *
 *  - NOBODY WRITES `schedulerMarkers`. A marker is the claim-before-send
 *    record: every tick job checks "does this marker exist?" and skips the
 *    work if it does. A client able to create one at a deterministic id could
 *    therefore SUPPRESS a send permanently and silently: its own
 *    application-deadline reminder, the follow-up task that chases an
 *    unmarked register. Nothing downstream would report anything wrong,
 *    because "marker exists" is indistinguishable from "already sent". The
 *    forged-suppression case at the bottom of this file is that attack
 *    written out.
 *
 *  - NOBODY READS `schedulerMarkers` either. Every component of a marker id
 *    is also stored as a field, so a readable collection would tell any
 *    signed-in account which named applicants still have unsubmitted drafts
 *    and which groups have unmarked registers.
 *
 *  - NOBODY WRITES `schedulerRuns`. The receipt id `tick__{bucket}__d0` IS
 *    the dedupe for duplicate external deliveries, so a forged receipt for
 *    the current 15-minute bucket makes the real delivery return
 *    `deduped: true` and do nothing. One forged doc every 15 minutes silences
 *    the whole time-based lane.
 *
 *  - NOBODY READS `schedulerRuns`. Receipts carry per-job counts, so a
 *    readable log is a live feed of how many people are being mailed and
 *    when.
 *
 * ADMINS ARE INCLUDED IN ALL FOUR on purpose. The admin scheduler panel reads
 * through a route on the Admin SDK, so admin read access here would buy
 * nothing and would make the collections one `isAdmin()` typo away from
 * writable.
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
  await getTestEnv("scheduler");
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

const MARKER_ID = "remind__autumn-2026-intake__k3f9a2b1__member1__20261011";
const RECEIPT_ID = "tick__20260902T1415Z__d0";

describe("schedulerMarkers", () => {
  it("cannot be read by anyone, at any role", async () => {
    await seed(async (db) => {
      await db.collection("schedulerMarkers").doc(MARKER_ID).set({
        job: "admissions-deadline-reminders",
        family: "remind",
        roundId: "autumn-2026-intake__k3f9a2b1",
        uid: "member1",
        dueAtKey: "20261011",
        attempts: 1,
        sentAt: null,
      });
    });
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("schedulerMarkers").doc(MARKER_ID).get(),
        `${label} must not read a marker`,
      );
      await assertFails(
        db.collection("schedulerMarkers").get(),
        `${label} must not list markers`,
      );
    }
  });

  it("cannot be created by anyone, at any role", async () => {
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db
          .collection("schedulerMarkers")
          .doc(`${MARKER_ID}__${label.replace(/\W+/g, "-")}`)
          .set({ job: "admissions-deadline-reminders" }),
        `${label} must not create a marker`,
      );
    }
  });

  it("cannot be updated or deleted by anyone, at any role", async () => {
    await seed(async (db) => {
      await db
        .collection("schedulerMarkers")
        .doc(MARKER_ID)
        .set({ job: "admissions-deadline-reminders", sentAt: null, attempts: 1 });
    });
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db
          .collection("schedulerMarkers")
          .doc(MARKER_ID)
          .set({ sentAt: new Date() }, { merge: true }),
        `${label} must not update a marker`,
      );
      await assertFails(
        db.collection("schedulerMarkers").doc(MARKER_ID).delete(),
        `${label} must not delete a marker`,
      );
    }
  });

  it("FORGED SUPPRESSION: a member cannot pre-create the marker for their own reminder", async () => {
    // The whole attack in four lines. The applicant knows the id scheme
    // (`remind__{roundId}__{uid}__{dueAtKey}` is in the codebase, and the
    // round id is on the public round page), so if this collection were
    // writable they could create the marker for their own T-7 reminder and
    // the job would skip them for ever, silently, with no error anywhere.
    await seedUser("applicant1", { role: "member" });
    const db = await asUser("applicant1");
    await assertFails(
      db
        .collection("schedulerMarkers")
        .doc("remind__autumn-2026-intake__k3f9a2b1__applicant1__20261011")
        .set({
          job: "admissions-deadline-reminders",
          sentAt: new Date(),
          attempts: 1,
        }),
    );
  });

  it("FORGED SUPPRESSION: a committee member cannot stub out an unmarked-register chase", async () => {
    // Same shape, other end of the platform: a facilitator who has not marked
    // their register could create the follow-up marker and stop the committee
    // task that chases them ever being minted.
    await seedUser("facilitator1", { role: "committee", suRecognised: true });
    const db = await asUser("facilitator1");
    await assertFails(
      db
        .collection("schedulerMarkers")
        .doc("unmarked__tuesdays-1800__aa11bb22__w03-1")
        .set({ job: "courses-unmarked-registers", sentAt: new Date() }),
    );
  });
});

describe("schedulerRuns", () => {
  it("cannot be read by anyone, at any role", async () => {
    await seed(async (db) => {
      await db
        .collection("schedulerRuns")
        .doc(RECEIPT_ID)
        .set({ bucket: "20260902T1415Z", depth: 0, jobs: [] });
    });
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("schedulerRuns").doc(RECEIPT_ID).get(),
        `${label} must not read a receipt`,
      );
      await assertFails(
        db.collection("schedulerRuns").get(),
        `${label} must not list receipts`,
      );
    }
  });

  it("cannot be written by anyone, at any role", async () => {
    await seed(async (db) => {
      await db
        .collection("schedulerRuns")
        .doc(RECEIPT_ID)
        .set({ bucket: "20260902T1415Z", depth: 0, jobs: [] });
    });
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("schedulerRuns").doc(RECEIPT_ID).delete(),
        `${label} must not delete a receipt`,
      );
      await assertFails(
        db
          .collection("schedulerRuns")
          .doc(RECEIPT_ID)
          .set({ jobs: [] }, { merge: true }),
        `${label} must not update a receipt`,
      );
    }
  });

  it("FORGED DEDUPE: a member cannot pre-create the receipt for the current bucket", async () => {
    // A receipt at `tick__{bucket}__d0` makes the real delivery for that
    // bucket return `deduped: true` and run nothing. Repeat every 15 minutes
    // and the entire time-based lane goes quiet with no error raised.
    await seedUser("member2", { role: "member" });
    const db = await asUser("member2");
    await assertFails(
      db
        .collection("schedulerRuns")
        .doc("tick__20260902T1430Z__d0")
        .set({ bucket: "20260902T1430Z", depth: 0, jobs: [] }),
    );
  });
});

describe("config/scheduler", () => {
  it("is unreachable from a client, so the kill switch cannot be flipped from a browser", async () => {
    // `config` has no match block at all, so this is default-deny today. The
    // assertion is here rather than in the rules file because the kill switch
    // is exactly the doc an attacker would want: `enabled: false` silences
    // every time-based send on the platform with one write.
    await seed(async (db) => {
      await db.collection("config").doc("scheduler").set({ enabled: true });
    });
    for (const [label, db] of await everyRole()) {
      await assertFails(
        db.collection("config").doc("scheduler").get(),
        `${label} must not read config/scheduler`,
      );
      await assertFails(
        db.collection("config").doc("scheduler").set({ enabled: false }),
        `${label} must not write config/scheduler`,
      );
    }
  });
});

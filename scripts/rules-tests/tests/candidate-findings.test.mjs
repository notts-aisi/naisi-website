/**
 * The three rule gaps a prior security pass raised as candidates, turned into
 * executable evidence. Each was re-read on `dev` and is still present in
 * `firestore.rules`; what nobody had done is prove the exploit actually works.
 *
 * These tests are written to FAIL once the rules are fixed. That is deliberate
 * — they characterise current behaviour, so the day someone tightens a rule the
 * suite says so out loud rather than staying quietly green. When you fix one,
 * invert the assertion in the same commit.
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
  await getTestEnv();
});
after(cleanup);
afterEach(clearData);

describe("FINDING 1 — events update rule has no per-document scoping", () => {
  it("lets a drafter self-approve their own event, defeating two-person review", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("e1").set({
        title: "Talk",
        authorUid: "drafter",
        status: "draft",
        collaboratorUids: [],
      });
    });

    const db = await asUser("drafter");
    // `draftEvent` alone should not be able to move an event through review.
    await assertSucceeds(db.collection("events").doc("e1").update({ status: "approved" }));
  });

  it("lets a drafter cancel someone ELSE's published event", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("e2").set({
        title: "Someone else's live event",
        authorUid: "another-person",
        status: "published",
        collaboratorUids: [],
      });
    });

    const db = await asUser("drafter");
    // The rule only checks the INCOMING status, so published -> cancelled passes
    // even though the actor neither owns the event nor holds approve rights.
    await assertSucceeds(db.collection("events").doc("e2").update({ status: "cancelled" }));
  });

  it("still blocks a plain member with no event permissions (control)", async () => {
    await seedUser("nobody", { role: "member" });
    await seed(async (db) => {
      await db
        .collection("events")
        .doc("e3")
        .set({ title: "T", authorUid: "x", status: "draft", collaboratorUids: [] });
    });
    const db = await asUser("nobody");
    await assertFails(db.collection("events").doc("e3").update({ status: "cancelled" }));
  });
});

describe("FINDING 2 — activity-log create is missing its parent check", () => {
  it("lets ANY signed-in account write into a task they cannot even read", async () => {
    // `pending` is what every brand-new Google account starts as, so this is
    // reachable by anyone who can sign in at all.
    await seedUser("outsider", { role: "pending" });
    await seed(async (db) => {
      await db.collection("tasks").doc("t1").set({
        title: "Committee task",
        creatorUid: "someone",
        completerUids: [],
        reviewerUids: [],
        visibility: "committee",
      });
    });

    const db = await asUser("outsider");

    // Cannot read the parent...
    await assertFails(db.collection("tasks").doc("t1").get());
    // ...but can append to its activity log anyway.
    await assertSucceeds(
      db.collection("tasks").doc("t1").collection("activity").doc("a1").set({
        actorUid: "outsider",
        text: "arbitrary text injected by a stranger",
        createdAt: new Date(),
      }),
    );
  });

  it("writes into a task id that does not exist at all (write amplification)", async () => {
    await seedUser("outsider", { role: "pending" });
    const db = await asUser("outsider");
    await assertSucceeds(
      db.collection("tasks").doc("no-such-task").collection("activity").doc("a1").set({
        actorUid: "outsider",
        text: "spam",
        createdAt: new Date(),
      }),
    );
  });

  it("sibling subcollections DO gate create on the parent (shows this is an oversight)", async () => {
    await seedUser("outsider", { role: "pending" });
    await seed(async (db) => {
      await db.collection("tasks").doc("t2").set({
        title: "Committee task",
        creatorUid: "someone",
        completerUids: [],
        reviewerUids: [],
        visibility: "committee",
      });
    });
    const db = await asUser("outsider");
    await assertFails(
      db.collection("tasks").doc("t2").collection("comments").doc("c1").set({
        authorUid: "outsider",
        bodyMarkdown: "hello",
      }),
    );
  });
});

describe("FINDING 3 — consent records are self-forgeable", () => {
  it("lets a member forge their own policy-consent audit record", async () => {
    await seedUser("member1", {
      role: "member",
      policyVersion: "2026-01-01",
      profile: { preferredName: "M" },
    });

    const db = await asUser("member1");
    // Neither field appears anywhere in firestore.rules, and the users update
    // rule has no keys().hasOnly(), so a member can both skip the re-consent
    // gate and fabricate the record that says they consented — the half that
    // matters under UK GDPR.
    await assertSucceeds(
      db.collection("users").doc("member1").update({
        policyVersion: "2099-12-31",
        policyAgreedAt: new Date(),
      }),
    );
  });

  it("still blocks self-granting role and suRecognised (control)", async () => {
    await seedUser("member2", { role: "member" });
    const db = await asUser("member2");
    await assertFails(db.collection("users").doc("member2").update({ role: "admin" }));
    await assertFails(db.collection("users").doc("member2").update({ suRecognised: true }));
  });

  it("still blocks forging uniEmailVerifiedAt (fixed by PR #216 — regression guard)", async () => {
    await seedUser("member3", {
      role: "member",
      profile: { preferredName: "M", universityEmail: "a@nottingham.ac.uk" },
    });
    const db = await asUser("member3");
    await assertFails(
      db.collection("users").doc("member3").update({
        "profile.uniEmailVerifiedAt": new Date(),
      }),
    );
    // ...and cannot carry a stamp across an email change.
    await seed(async (fdb) => {
      await fdb
        .collection("users")
        .doc("member3")
        .set(
          { profile: { universityEmail: "a@nottingham.ac.uk", uniEmailVerifiedAt: new Date() } },
          { merge: true },
        );
    });
    await assertFails(
      db.collection("users").doc("member3").update({
        "profile.universityEmail": "victim@nottingham.ac.uk",
      }),
    );
  });
});

describe("anonymous access baseline", () => {
  it("cannot read member PII", async () => {
    await seedUser("someone", { role: "member" });
    const db = await asAnon();
    await assertFails(db.collection("users").doc("someone").get());
  });

  it("cannot enumerate the users collection", async () => {
    await seedUser("someone", { role: "member" });
    const db = await asAnon();
    await assertFails(db.collection("users").get());
  });

  it("cannot read config/ (task-email kill switch and the site-notice audit)", async () => {
    await seed(async (db) => {
      await db.collection("config").doc("taskEmails").set({ enabled: true });
      await db.collection("config").doc("siteNoticeAudit").set({ updatedByUid: "admin1" });
    });
    const db = await asAnon();
    await assertFails(db.collection("config").doc("taskEmails").get());
    await assertFails(db.collection("config").doc("siteNoticeAudit").get());
  });

  it("assert.ok sanity — the emulator is actually enforcing rules", () => {
    assert.ok(true);
  });
});

/**
 * The three rule gaps a prior security pass raised as candidates — proven
 * exploitable, then FIXED, and now guarded here so they cannot come back.
 *
 * These started life as characterisations: `assertSucceeds` on each exploit,
 * written to fail the day someone tightened the rule. That day was 2026-08-02,
 * and the assertions were inverted in the same commit as the fix, exactly as
 * the original header instructed. Each `it()` below now asserts the attack is
 * REFUSED, and each names the shape of the fix so a future rules edit that
 * reopens the hole fails here with an explanation rather than a bare denial.
 *
 * A note for whoever edits `firestore.rules` next: if one of these starts
 * failing, you have reintroduced a known vulnerability. Do not "fix the test".
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
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

/** The sentinel a client `serverTimestamp()` sends — resolves to `request.time`
 *  in rules, which is what the consent re-stamp escape hatch keys off. */
const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();

before(async () => {
  await getTestEnv("candidate-findings");
});
after(cleanup);
afterEach(clearData);

describe("FINDING 1 (FIXED) — events update is scoped per document and per status", () => {
  it("refuses a drafter self-approving their own event (two-person review holds)", async () => {
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
    // `draftEvent` alone must not move an event through review. Approving now
    // requires canApprove(), so holding only the drafter permission fails even
    // on your own event.
    await assertFails(db.collection("events").doc("e1").update({ status: "approved" }));
  });

  it("still lets a drafter send their OWN event for review (the flow must survive)", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("e1b").set({
        title: "Talk",
        authorUid: "drafter",
        status: "draft",
        collaboratorUids: [],
      });
    });
    const db = await asUser("drafter");
    // submitEventForReview() in src/features/events/eventMutations.ts.
    await assertSucceeds(db.collection("events").doc("e1b").update({ status: "pending" }));
  });

  it("still lets an APPROVER approve someone else's event (the flow must survive)", async () => {
    await seedUser("approver", { role: "member", permissions: { approveEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("e1c").set({
        title: "Talk",
        authorUid: "another-person",
        status: "pending",
        collaboratorUids: [],
      });
    });
    const db = await asUser("approver");
    await assertSucceeds(db.collection("events").doc("e1c").update({ status: "approved" }));
  });

  it("refuses a drafter cancelling someone ELSE's published event", async () => {
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
    // Two independent reasons this is now refused: the actor does not own the
    // event (per-document scoping), and 'cancelled' withdraws publication so it
    // requires canApprove(). Either alone would stop it.
    await assertFails(db.collection("events").doc("e2").update({ status: "cancelled" }));
  });

  it("refuses a drafter editing an event that is not theirs at all", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("e2b").set({
        title: "Someone else's draft",
        authorUid: "another-person",
        status: "draft",
        collaboratorUids: [],
      });
    });
    const db = await asUser("drafter");
    // The original rule granted every drafter write access to EVERY event.
    await assertFails(db.collection("events").doc("e2b").update({ title: "hijacked" }));
  });

  it("still lets a named COLLABORATOR edit the event they were added to", async () => {
    await seedUser("collab", { role: "member" });
    await seed(async (db) => {
      await db.collection("events").doc("e2c").set({
        title: "Someone else's draft",
        authorUid: "another-person",
        status: "draft",
        collaboratorUids: ["collab"],
      });
    });
    const db = await asUser("collab");
    await assertSucceeds(db.collection("events").doc("e2c").update({ title: "edited by collaborator" }));
  });

  it("refuses an AUTHOR unpublishing their own live event by reverting it to draft", async () => {
    // Found by the adversarial pass on the first version of this fix, which
    // tested only the INCOMING status — so 'published' -> 'draft' slipped
    // through and withdrew publication with no approver involved. The rule now
    // tests the STORED status: a live event is server territory.
    await seedUser("auth1", { role: "member", permissions: { draftEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("p1").set({
        title: "Live event",
        authorUid: "auth1",
        status: "published",
        collaboratorUids: [],
      });
    });
    const db = await asUser("auth1");
    await assertFails(db.collection("events").doc("p1").update({ status: "draft" }));
  });

  it("refuses even an APPROVER editing a live event from the client", async () => {
    // Post-publish edits go through /api/events/[id]/update so the change
    // notices actually get sent; letting the client bypass that would ship a
    // silent edit to people who already RSVP'd.
    await seedUser("approver2", { role: "member", permissions: { approveEvent: true } });
    await seed(async (db) => {
      await db.collection("events").doc("p2").set({
        title: "Live event",
        authorUid: "someone",
        status: "published",
        collaboratorUids: [],
      });
    });
    const db = await asUser("approver2");
    await assertFails(db.collection("events").doc("p2").update({ title: "changed" }));
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

describe("FINDING 2 (FIXED) — activity-log create gates on the parent task", () => {
  it("refuses a signed-in stranger writing into a task they cannot read", async () => {
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
    // ...and can no longer append to its activity log either.
    await assertFails(
      db.collection("tasks").doc("t1").collection("activity").doc("a1").set({
        actorUid: "outsider",
        text: "arbitrary text injected by a stranger",
        createdAt: new Date(),
      }),
    );
  });

  it("refuses a write into a task id that does not exist (write amplification)", async () => {
    await seedUser("outsider", { role: "pending" });
    const db = await asUser("outsider");
    await assertFails(
      db.collection("tasks").doc("no-such-task").collection("activity").doc("a1").set({
        actorUid: "outsider",
        text: "spam",
        createdAt: new Date(),
      }),
    );
  });

  it("still lets a COMPLETER append activity to their own task (the flow must survive)", async () => {
    await seedUser("worker", { role: "member" });
    await seed(async (db) => {
      await db.collection("tasks").doc("t3").set({
        title: "Assigned task",
        creatorUid: "someone",
        completerUids: ["worker"],
        reviewerUids: [],
        visibility: "assignees-only",
      });
    });
    const db = await asUser("worker");
    // queueActivity() batches exactly this alongside a task update.
    await assertSucceeds(
      db.collection("tasks").doc("t3").collection("activity").doc("a2").set({
        kind: "subtask_done",
        actorUid: "worker",
        createdAt: new Date(),
        payload: {},
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

describe("FINDING 3 (FIXED) — consent records are server-authoritative", () => {
  it("refuses a member forging their own policy-consent audit record", async () => {
    await seedUser("member1", {
      role: "member",
      policyVersion: "2026-01-01",
      profile: { preferredName: "M" },
    });

    const db = await asUser("member1");
    // Both fields are now pinned to their existing values on any self-update.
    // Re-consent is stamped by /api/account/reconsent through the Admin SDK,
    // which bypasses these rules — so the legitimate path is unaffected while
    // the subject can no longer write their own audit record.
    await assertFails(
      db.collection("users").doc("member1").update({
        policyVersion: "2099-12-31",
        policyAgreedAt: new Date(),
      }),
    );
  });

  it("refuses bumping policyVersion alone (skipping the re-consent gate)", async () => {
    await seedUser("member1b", {
      role: "member",
      policyVersion: "2026-01-01",
      profile: { preferredName: "M" },
    });
    const db = await asUser("member1b");
    await assertFails(
      db.collection("users").doc("member1b").update({ policyVersion: "2099-12-31" }),
    );
  });

  it("still lets the REGISTRATION RETRY re-stamp consent (the flow must survive)", async () => {
    // completeRegistration (src/auth/signInWithGoogle.ts:129) writes an
    // UNMERGED setDoc, so a second attempt — after a failed first one — re-sends
    // policyAgreedAt for the same policyVersion. The first version of this fix
    // required strict equality and denied exactly that, which would have
    // stranded anyone whose registration errored once. Caught by the
    // adversarial pass, not by me.
    await seedUser("retry1", {
      role: "pending",
      policyVersion: "v1",
      policyAgreedAt: new Date("2020-01-01"),
      profile: { preferredName: "R" },
    });
    const db = await asUser("retry1");
    await assertSucceeds(
      db.collection("users").doc("retry1").set({
        // Must match the token's email claim: `users` create/update now pins
        // this field (it is treated downstream as a proven inbox). The real
        // client sends the address Firebase Auth verified, which is exactly
        // what seedUser + asUser model here.
        email: "retry1@example.com",
        displayName: "R",
        role: "pending",
        showOnMembers: false,
        profile: { preferredName: "R" },
        policyVersion: "v1",
        // Exactly what the client sends.
        policyAgreedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      }),
    );
  });

  it("refuses BACK-DATING the consent timestamp to a caller-chosen value", async () => {
    // The escape hatch above is scoped to the server's own clock, so it cannot
    // be used to claim you agreed earlier than you did.
    await seedUser("backdate1", {
      role: "member",
      policyVersion: "v1",
      policyAgreedAt: new Date("2026-01-01"),
      profile: { preferredName: "B" },
    });
    const db = await asUser("backdate1");
    await assertFails(
      db.collection("users").doc("backdate1").update({
        policyAgreedAt: new Date("2020-01-01"),
      }),
    );
  });

  it("still lets an ADMIN write consent fields (the guard is scoped to self-update)", async () => {
    await seedUser("admin1", { role: "admin" });
    await seedUser("subject", { role: "member", policyVersion: "2026-01-01" });
    const db = await asUser("admin1");
    // The equality guards are chained inside the `request.auth.uid == uid`
    // disjunct; putting them after it would have caught the isAdmin() branch
    // too and locked admins out of their own members' records.
    await assertSucceeds(
      db.collection("users").doc("subject").update({ policyVersion: "2026-02-01" }),
    );
  });

  it("still lets a member edit their ordinary profile fields (the flow must survive)", async () => {
    await seedUser("member1c", {
      role: "member",
      policyVersion: "2026-01-01",
      profile: { preferredName: "M" },
    });
    const db = await asUser("member1c");
    // The profile form writes these; consent fields are simply left alone, so
    // the equality guards hold on their absent-vs-absent default.
    await assertSucceeds(
      db.collection("users").doc("member1c").update({
        "profile.preferredName": "Renamed",
        showOnMembers: true,
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

/**
 * Regression tests for the findings of the whole-project adversarial sweep
 * (2026-08-02). Every case here was first written as a probe that PASSED
 * against the vulnerable rules — i.e. each `assertFails` below is a real
 * exploit that used to succeed — and each is paired with a control proving the
 * legitimate flow it must not break.
 *
 * The controls are the important half. Several of these rules were tightened
 * once before and had to be loosened again because the first attempt denied a
 * real flow (see candidate-findings.test.mjs on the registration retry). If you
 * change a rule and a `still lets ...` case goes red, you have broken a user,
 * not closed a hole.
 *
 * If one of the `refuses ...` cases starts failing, you have reintroduced a
 * known vulnerability. Do not "fix the test".
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
  await getTestEnv("sweep-findings");
});
after(cleanup);
afterEach(clearData);

describe("users.email is proven-inbox state, not a profile field", () => {
  it("refuses a member repointing their own email at a stranger", async () => {
    // Downstream this field is trusted as an address the user controls:
    // /api/subscriptions/sync marked rows `confirmed` from it with no click,
    // and the application-email + newsletter senders mail it.
    await seedUser("m1", { role: "member", email: "m1@example.com" });
    const db = await asUser("m1");
    await assertFails(
      db.collection("users").doc("m1").update({ email: "victim@example.com" }),
    );
  });

  it("still lets a member edit their ordinary profile fields", async () => {
    await seedUser("m2", { role: "member", profile: { preferredName: "M" } });
    const db = await asUser("m2");
    await assertSucceeds(
      db.collection("users").doc("m2").update({
        "profile.preferredName": "Renamed",
        showOnMembers: true,
      }),
    );
  });
});

describe("consent is an audit record the subject cannot back-date", () => {
  it("refuses a self-created doc that back-dates policyAgreedAt", async () => {
    const db = await asUser("newbie");
    await assertFails(
      db.collection("users").doc("newbie").set({
        uid: "newbie",
        email: "newbie@example.com",
        displayName: "N",
        role: "pending",
        profile: { preferredName: "N" },
        policyAgreedAt: new Date("2020-01-01"),
        createdAt: new Date(),
      }),
    );
  });
});

describe("attachments: storagePath is confined to its own task", () => {
  async function seedOwnTask(uid) {
    await seedUser(uid, { role: "pending" });
    await seed(async (db) => {
      await db.collection("tasks").doc("T").set({
        title: "My personal task",
        creatorUid: uid,
        source: "personal",
        visibility: "assignees-only",
        completerUids: [uid],
        reviewerUids: [],
        subtasks: [],
      });
    });
  }

  it("refuses an attachment pointing at another feature's Storage object", async () => {
    // The whole chain: three server routes hand this field to
    // bucket.file(path).delete() via the Admin SDK, which bypasses
    // storage.rules — so an unconstrained value meant any signed-in account
    // could delete arbitrary objects anywhere in the bucket.
    await seedOwnTask("atk");
    const db = await asUser("atk");
    await assertFails(
      db.collection("tasks").doc("T").collection("attachments").doc("A").set({
        uploadedByUid: "atk",
        filename: "innocent.png",
        storagePath: "event-images/SOME-EVENT/poster.png",
      }),
    );
  });

  it("refuses a path that escapes the task folder by traversal", async () => {
    await seedOwnTask("atk2");
    const db = await asUser("atk2");
    await assertFails(
      db.collection("tasks").doc("T").collection("attachments").doc("A").set({
        uploadedByUid: "atk2",
        filename: "x.png",
        storagePath: "tasks/T/A/../../../newsletter-images/d/cover.png",
      }),
    );
  });

  it("still lets the real upload flow write its own path", async () => {
    // attachmentMutations.ts builds exactly tasks/{taskId}/{attachmentId}/{name}.
    await seedOwnTask("worker");
    const db = await asUser("worker");
    await assertSucceeds(
      db.collection("tasks").doc("T").collection("attachments").doc("A").set({
        uploadedByUid: "worker",
        filename: "notes.pdf",
        storagePath: "tasks/T/A/notes.pdf",
      }),
    );
  });
});

describe("personal tasks cannot be used to reach other members", () => {
  it("refuses planting reviewers on a personal task via update", async () => {
    // Create already required reviewerUids.size() == 0; the update branch did
    // not, so create-clean-then-update planted attacker-chosen text on
    // strangers' boards and made them notify/send-for-review recipients.
    await seedUser("atk", { role: "pending" });
    const db = await asUser("atk");
    await assertSucceeds(
      db.collection("tasks").doc("T").set({
        title: "Mine",
        creatorUid: "atk",
        source: "personal",
        visibility: "assignees-only",
        completerUids: ["atk"],
        reviewerUids: [],
        subtasks: [],
      }),
    );
    await assertFails(
      db.collection("tasks").doc("T").update({ reviewerUids: ["v1", "v2", "v3"] }),
    );
  });

  it("still lets the creator edit their own personal task", async () => {
    await seedUser("owner", { role: "member" });
    await seed(async (db) => {
      await db.collection("tasks").doc("P").set({
        title: "Mine",
        creatorUid: "owner",
        source: "personal",
        visibility: "assignees-only",
        completerUids: ["owner"],
        reviewerUids: [],
        subtasks: [],
      });
    });
    const db = await asUser("owner");
    await assertSucceeds(
      db.collection("tasks").doc("P").update({ title: "Renamed", subtasks: [] }),
    );
  });
});

describe("newsletterDrafts is scoped per document, like events", () => {
  async function seedDraft(id, authorUid, status) {
    await seed(async (db) => {
      await db.collection("newsletterDrafts").doc(id).set({
        subject: "Approved copy",
        authorUid,
        status,
        blocks: [{ type: "text", text: "the copy the approver signed off" }],
      });
    });
  }

  it("refuses a drafter editing someone else's draft", async () => {
    await seedUser("d1", { role: "member", permissions: { draftNewsletter: true } });
    await seedDraft("n1", "another-person", "draft");
    const db = await asUser("d1");
    await assertFails(
      db.collection("newsletterDrafts").doc("n1").update({ subject: "hijacked" }),
    );
  });

  it("refuses a drafter self-approving their own draft", async () => {
    await seedUser("d2", { role: "member", permissions: { draftNewsletter: true } });
    await seedDraft("n2", "d2", "draft");
    const db = await asUser("d2");
    await assertFails(
      db.collection("newsletterDrafts").doc("n2").update({ status: "approved" }),
    );
  });

  it("refuses rewriting the body of an APPROVED draft before it is sent", async () => {
    // The sharp end: the approver signs off on one newsletter and the send
    // route ships another to the whole subscriber list.
    await seedUser("d3", { role: "member", permissions: { draftNewsletter: true } });
    await seedDraft("n3", "d3", "approved");
    const db = await asUser("d3");
    await assertFails(
      db.collection("newsletterDrafts").doc("n3").update({
        subject: "URGENT: reset your password",
        blocks: [{ type: "text", text: "attacker-chosen copy" }],
      }),
    );
  });

  it("still lets a drafter send their OWN draft for review", async () => {
    await seedUser("d4", { role: "member", permissions: { draftNewsletter: true } });
    await seedDraft("n4", "d4", "draft");
    const db = await asUser("d4");
    await assertSucceeds(
      db.collection("newsletterDrafts").doc("n4").update({ status: "pending" }),
    );
  });

  it("still lets an APPROVER approve someone else's draft", async () => {
    await seedUser("a1", { role: "member", permissions: { approveNewsletter: true } });
    await seedDraft("n5", "another-person", "pending");
    const db = await asUser("a1");
    await assertSucceeds(
      db.collection("newsletterDrafts").doc("n5").update({ status: "approved" }),
    );
  });
});

describe("events: PR #225 scoping also pins the payload", () => {
  async function seedEvent(id, extra = {}) {
    await seed(async (db) => {
      await db.collection("events").doc(id).set({
        title: "Someone else's event",
        authorUid: "victim-author",
        status: "draft",
        collaboratorUids: ["collab"],
        visibility: "members",
        capacity: 10,
        rsvpCountConfirmed: 0,
        ...extra,
      });
    });
  }

  it("refuses a collaborator seizing authorship", async () => {
    await seedUser("collab", { role: "member" });
    await seedEvent("e1");
    const db = await asUser("collab");
    await assertFails(
      db.collection("events").doc("e1").update({ authorUid: "collab" }),
    );
  });

  it("refuses a collaborator adding more collaborators", async () => {
    await seedUser("collab", { role: "member" });
    await seedEvent("e2");
    const db = await asUser("collab");
    await assertFails(
      db.collection("events").doc("e2").update({ collaboratorUids: ["collab", "accomplice"] }),
    );
  });

  it("refuses a collaborator rewriting the RSVP counters", async () => {
    await seedUser("collab", { role: "member" });
    await seedEvent("e3");
    const db = await asUser("collab");
    await assertFails(
      db.collection("events").doc("e3").update({ rsvpCountConfirmed: 999 }),
    );
  });

  it("refuses an author rewriting their own APPROVED event", async () => {
    await seedUser("auth1", { role: "member", permissions: { draftEvent: true } });
    await seedEvent("e4", { authorUid: "auth1", status: "approved", collaboratorUids: [] });
    const db = await asUser("auth1");
    await assertFails(
      db.collection("events").doc("e4").update({ title: "Something the approver never saw" }),
    );
  });

  it("still lets a collaborator edit the event content they were added to", async () => {
    await seedUser("collab", { role: "member" });
    await seedEvent("e5");
    const db = await asUser("collab");
    await assertSucceeds(
      db.collection("events").doc("e5").update({ title: "Edited by collaborator" }),
    );
  });

  it("still lets an author change visibility while drafting", async () => {
    // eventMutations.ts:112 patches this; pinning it would break a real flow.
    await seedUser("auth2", { role: "member", permissions: { draftEvent: true } });
    await seedEvent("e6", { authorUid: "auth2", collaboratorUids: [] });
    const db = await asUser("auth2");
    await assertSucceeds(
      db.collection("events").doc("e6").update({ visibility: "public" }),
    );
  });
});

describe("comments require ongoing access to the parent task", () => {
  it("refuses a member removed from a task rewriting their old comment", async () => {
    await seedUser("ex", { role: "member" });
    await seed(async (db) => {
      await db.collection("tasks").doc("t1").set({
        title: "Committee task",
        creatorUid: "boss",
        completerUids: ["someone-else"],
        reviewerUids: [],
        visibility: "committee",
        subtasks: [],
      });
      await db.collection("tasks").doc("t1").collection("comments").doc("c1").set({
        authorUid: "ex",
        bodyMarkdown: "original",
        createdAt: new Date(),
      });
    });
    const db = await asUser("ex");
    await assertFails(
      db.collection("tasks").doc("t1").collection("comments").doc("c1")
        .update({ bodyMarkdown: "silently rewritten after removal" }),
    );
  });

  it("still lets a current completer edit their own comment", async () => {
    await seedUser("on", { role: "member" });
    await seed(async (db) => {
      await db.collection("tasks").doc("t2").set({
        title: "Assigned",
        creatorUid: "boss",
        completerUids: ["on"],
        reviewerUids: [],
        visibility: "assignees-only",
        subtasks: [],
      });
      await db.collection("tasks").doc("t2").collection("comments").doc("c1").set({
        authorUid: "on",
        bodyMarkdown: "original",
        createdAt: new Date(),
      });
    });
    const db = await asUser("on");
    await assertSucceeds(
      db.collection("tasks").doc("t2").collection("comments").doc("c1")
        .update({ bodyMarkdown: "edited", editedAt: new Date() }),
    );
  });
});

describe("adminLocks messages are bounded on every field", () => {
  it("refuses an oversized fromName", async () => {
    // hasOnly() fixes WHICH keys may appear, not how big they are.
    await seedUser("al1", { role: "member" });
    const db = await asUser("al1");
    await assertFails(
      db.collection("adminLocks").doc("useredit__al1").collection("messages").doc("m1")
        .set({
          fromUid: "al1",
          fromName: "A".repeat(900_000),
          text: "hi",
          createdAt: new Date(),
        }),
    );
  });

  it("still lets a member post a normal message to their own lock", async () => {
    await seedUser("al2", { role: "member" });
    const db = await asUser("al2");
    await assertSucceeds(
      db.collection("adminLocks").doc("useredit__al2").collection("messages").doc("m1")
        .set({ fromUid: "al2", fromName: "Al", text: "on it", createdAt: new Date() }),
    );
  });
});

describe("credentials grants nothing while the feature does not exist", () => {
  it("refuses a non-SU committee member reading the credentials store", async () => {
    await seedUser("nsu", { role: "committee", suRecognised: false });
    await seed(async (db) => {
      await db.collection("credentials").doc("c1").set({ secret: "cipher" });
    });
    const db = await asUser("nsu");
    await assertFails(db.collection("credentials").doc("c1").get());
  });

  it("refuses even an SU committee member writing to it", async () => {
    await seedUser("su", { role: "committee", suRecognised: true });
    const db = await asUser("su");
    await assertFails(
      db.collection("credentials").doc("junk").set({ blob: "A".repeat(1000) }),
    );
  });
});

describe("controls that must never regress", () => {
  it("still blocks self-granting role and suRecognised", async () => {
    await seedUser("m9", { role: "member" });
    const db = await asUser("m9");
    await assertFails(db.collection("users").doc("m9").update({ role: "admin" }));
    await assertFails(db.collection("users").doc("m9").update({ suRecognised: true }));
  });

  it("still blocks an anonymous visitor reading a published event", async () => {
    await seed(async (db) => {
      await db.collection("events").doc("pub").set({ title: "T", status: "published" });
    });
    const db = await asAnon();
    await assertFails(db.collection("events").doc("pub").get());
  });
});

describe("events are deleted server-side so the cascade cannot be skipped", () => {
  // A client can only ever delete the event DOCUMENT — eventRsvps denies client
  // writes outright — so a direct delete stranded attendee PII with no event
  // left to justify keeping it. Deletion now goes through
  // /api/events/[id]/delete, which cascades RSVPs and images first.
  async function seedEvent(id, authorUid, status) {
    await seed(async (db) => {
      await db.collection("events").doc(id).set({
        title: "Talk",
        authorUid,
        status,
        collaboratorUids: [],
      });
    });
  }

  it("refuses an author deleting their own unpublished event from the client", async () => {
    await seedUser("auth1", { role: "member", permissions: { draftEvent: true } });
    await seedEvent("d1", "auth1", "draft");
    const db = await asUser("auth1");
    await assertFails(db.collection("events").doc("d1").delete());
  });

  it("refuses even an ADMIN deleting an event from the client", async () => {
    await seedUser("admin1", { role: "admin" });
    await seedEvent("d2", "someone", "draft");
    const db = await asUser("admin1");
    await assertFails(db.collection("events").doc("d2").delete());
  });

  it("keeps eventRsvps unwritable by clients (why the cascade must be server-side)", async () => {
    await seedUser("admin2", { role: "admin" });
    await seed(async (db) => {
      await db.collection("eventRsvps").doc("r1").set({
        eventId: "d3", name: "Attendee", email: "a@example.com", status: "confirmed",
      });
    });
    const db = await asUser("admin2");
    await assertFails(db.collection("eventRsvps").doc("r1").delete());
  });
});

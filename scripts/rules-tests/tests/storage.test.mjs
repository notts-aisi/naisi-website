/**
 * `storage.rules` — the second, separately-deployed rulebook, governing every
 * uploaded file. It had exactly the same zero coverage `firestore.rules` did,
 * and it has already broken production once: commit ce8f140 ("fix: unbreak
 * events tab, email, and event-image uploads in prod") was a missing
 * `event-images/` match block hitting deny-by-default, because Storage rules
 * need their own `firebase deploy --only storage` and nothing verifies the
 * deployed set matches the repo.
 *
 * Every gate here reaches ACROSS services — `firestore.get(/documents/users/
 * $(uid))` to read the actor's role — so these tests seed Firestore and
 * exercise Storage together.
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  cleanup,
  clearData,
  getTestEnv,
  seedUser,
  storageAsAnon,
  storageAsUser,
} from "../lib/harness.mjs";

before(async () => {
  await getTestEnv("test");
});
after(cleanup);
afterEach(clearData);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const png = { contentType: "image/png" };

describe("newsletter-images — public read, permission-gated write", () => {
  it("is readable by a signed-out visitor (emails render without auth)", async () => {
    const s = await storageAsAnon();
    // Deny-by-default would reject the metadata call outright; a missing file
    // surfaces as a 404 from a permitted read, which assertSucceeds accepts.
    await assertSucceeds(
      s.ref("newsletter-images/d1/x.png").getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });

  it("blocks upload by a member with no newsletter permission", async () => {
    await seedUser("plain", { role: "member" });
    const s = await storageAsUser("plain");
    await assertFails(s.ref("newsletter-images/d1/x.png").put(PNG, png));
  });

  it("allows upload by a newsletter drafter", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftNewsletter: true } });
    const s = await storageAsUser("drafter");
    await assertSucceeds(s.ref("newsletter-images/d1/x.png").put(PNG, png));
  });

  it("blocks a non-image content type", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftNewsletter: true } });
    const s = await storageAsUser("drafter");
    await assertFails(
      s.ref("newsletter-images/d1/evil.html").put(PNG, { contentType: "text/html" }),
    );
  });

  it("CHARACTERISATION: image/.* admits SVG onto a world-readable path", async () => {
    // `image/svg+xml` satisfies `image/.*`, and this path is `allow read: if
    // true`. Exploiting it needs drafter/approver permission, and whether the
    // SVG executes depends on the serving headers of the download URL — which
    // rules cannot express. Recorded so that tightening the allowlist to a
    // raster-only list is a visible, deliberate change.
    await seedUser("drafter", { role: "member", permissions: { draftNewsletter: true } });
    const s = await storageAsUser("drafter");
    await assertSucceeds(
      s.ref("newsletter-images/d1/x.svg").put(PNG, { contentType: "image/svg+xml" }),
    );
  });
});

describe("event-images — same shape as newsletter", () => {
  it("blocks upload by a member with no event permission", async () => {
    await seedUser("plain", { role: "member" });
    const s = await storageAsUser("plain");
    await assertFails(s.ref("event-images/e1/x.png").put(PNG, png));
  });

  it("allows upload by an event drafter", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    const s = await storageAsUser("drafter");
    await assertSucceeds(s.ref("event-images/e1/x.png").put(PNG, png));
  });

  it("does not require the event to exist — the wildcard is unvalidated", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    const s = await storageAsUser("drafter");
    await assertSucceeds(s.ref("event-images/no-such-event/x.png").put(PNG, png));
  });
});

describe("task attachments — suRecognised now matches Firestore (was a divergence)", () => {
  async function seedCommitteeTask() {
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("tasks").doc("t1").set({
        title: "Committee task",
        creatorUid: "someone-else",
        completerUids: [],
        reviewerUids: [],
        visibility: "committee",
      });
    });
  }

  it("FIXED: a NON-SU committee member is refused attachments, as Firestore refuses the doc", async () => {
    // firestore.rules gates committee task access on isSuCommittee() —
    // role == 'committee' AND suRecognised == true. storage.rules used to check
    // only `role in ['committee','admin']`, with no suRecognised anywhere in
    // the file, so the document was denied while its attachment blobs were not.
    // The two gates now agree.
    await seedUser("nonSu", { role: "committee", suRecognised: false });
    await seedCommitteeTask();
    const s = await storageAsUser("nonSu");
    await assertFails(s.ref("tasks/t1/a1/file.png").put(PNG, png));
  });

  it("FIXED: and cannot READ them either — the blobs were the exposed half", async () => {
    await seedUser("nonSu2", { role: "committee", suRecognised: false });
    await seedCommitteeTask();
    const s = await storageAsUser("nonSu2");
    await assertFails(s.ref("tasks/t1/a1/file.png").getMetadata());
  });

  it("still lets a NON-SU committee member named on the task in (the flow must survive)", async () => {
    // This is precisely how a non-SU committee member is meant to reach a task:
    // by being explicitly added to it. Tightening the committee branch must not
    // take this away, or it breaks the collaboration model in CLAUDE.md.
    await seedUser("nonSuNamed", { role: "committee", suRecognised: false });
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("tasks").doc("t2").set({
        title: "Committee task they were added to",
        creatorUid: "someone-else",
        completerUids: ["nonSuNamed"],
        reviewerUids: [],
        visibility: "committee",
      });
    });
    const s = await storageAsUser("nonSuNamed");
    await assertSucceeds(s.ref("tasks/t2/a1/file.png").put(PNG, png));
  });

  it("an SU-recognised committee member is allowed (intended behaviour)", async () => {
    await seedUser("su", { role: "committee", suRecognised: true });
    await seedCommitteeTask();
    const s = await storageAsUser("su");
    await assertSucceeds(s.ref("tasks/t1/a1/file.png").put(PNG, png));
  });

  it("an unrelated member is still blocked (control)", async () => {
    await seedUser("outsider", { role: "member" });
    await seedCommitteeTask();
    const s = await storageAsUser("outsider");
    await assertFails(s.ref("tasks/t1/a1/file.png").put(PNG, png));
  });

  it("attachments are NOT publicly readable", async () => {
    await seedCommitteeTask();
    const s = await storageAsAnon();
    await assertFails(s.ref("tasks/t1/a1/file.png").getMetadata());
  });
});

describe("application-emails — was missing entirely, broke prod", () => {
  // Confirmed broken on production 2026-08-01: uploading an image in the Email
  // designs tab failed with storage/unauthorized on
  // `application-emails/application-submitted/application-submitted/...`.
  // No block covered the path, so it hit deny-by-default. These tests pin the
  // rule that fixes it — including the double-nested path the editor builds.
  it("allows an admin to upload, on the exact path the editor uses", async () => {
    await seedUser("admin1", { role: "admin" });
    const s = await storageAsUser("admin1");
    await assertSucceeds(
      s.ref("application-emails/application-submitted/application-submitted/x.png").put(PNG, png),
    );
  });

  it("blocks a non-admin, including a newsletter drafter", async () => {
    await seedUser("drafter", { role: "member", permissions: { draftNewsletter: true } });
    const s = await storageAsUser("drafter");
    await assertFails(s.ref("application-emails/tpl1/x.png").put(PNG, png));
  });

  it("blocks a non-image content type", async () => {
    await seedUser("admin1", { role: "admin" });
    const s = await storageAsUser("admin1");
    await assertFails(
      s.ref("application-emails/tpl1/x.html").put(PNG, { contentType: "text/html" }),
    );
  });

  it("is publicly readable, because sent emails render without auth", async () => {
    const s = await storageAsAnon();
    await assertSucceeds(
      s.ref("application-emails/tpl1/x.png").getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });
});

describe("unmatched paths deny by default", () => {
  it("rejects an arbitrary top-level path even for an admin", async () => {
    await seedUser("admin1", { role: "admin" });
    const s = await storageAsUser("admin1");
    await assertFails(s.ref("anything-else/x.png").put(PNG, png));
  });
});

describe("event-images — per-event scoping, matching firestore.rules", () => {
  async function seedEvent(id, authorUid, collaboratorUids = []) {
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().collection("events").doc(id);
      await ref.set({
        title: "Talk",
        authorUid,
        status: "published",
        collaboratorUids,
      });
      await ref.get();
    });
  }

  it("FIXED: a drafter cannot overwrite ANOTHER author's event cover", async () => {
    // The per-document scoping PR #225 added to firestore.rules stopped at the
    // Firestore boundary: the same actor was denied the event DOCUMENT while
    // still being allowed to overwrite its world-readable cover IMAGE here.
    // That is public defacement of the live site and of already-sent emails.
    await seedUser("drafter", { role: "member", permissions: { draftEvent: true } });
    await seedEvent("victim-event", "another-person");
    const s = await storageAsUser("drafter");
    await assertFails(s.ref("event-images/victim-event/cover.png").put(PNG, png));
  });

  it("still lets the event's AUTHOR upload its cover (the flow must survive)", async () => {
    await seedUser("owner", { role: "member", permissions: { draftEvent: true } });
    await seedEvent("own-event", "owner");
    const s = await storageAsUser("owner");
    await assertSucceeds(s.ref("event-images/own-event/cover.png").put(PNG, png));
  });

  it("still lets a named COLLABORATOR upload to that event", async () => {
    await seedUser("collab", { role: "member" });
    await seedEvent("shared-event", "another-person", ["collab"]);
    const s = await storageAsUser("collab");
    await assertSucceeds(s.ref("event-images/shared-event/cover.png").put(PNG, png));
  });

  it("still lets an APPROVER upload to any event under review", async () => {
    await seedUser("approver", { role: "member", permissions: { approveEvent: true } });
    await seedEvent("any-event", "another-person");
    const s = await storageAsUser("approver");
    await assertSucceeds(s.ref("event-images/any-event/cover.png").put(PNG, png));
  });
});

describe("course-images: was missing entirely, so every week-guide image failed", () => {
  // The third time this exact shape has bitten: no `course-images` match block
  // existed, so both editors' uploads hit deny-by-default. WeekEditor.tsx and
  // CourseEditor.tsx each carry a comment predicting it. These tests pin the
  // rule that fixes it, on the exact two path shapes those editors build.
  it("allows a course drafter to upload under a courseId (CourseEditor)", async () => {
    await seedUser("cDrafter", { role: "member", permissions: { draftCourse: true } });
    const s = await storageAsUser("cDrafter");
    await assertSucceeds(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("allows a course approver to upload under runId__weekId (WeekEditor)", async () => {
    await seedUser("cApprover", { role: "member", permissions: { approveCourse: true } });
    const s = await storageAsUser("cApprover");
    await assertSucceeds(s.ref("course-images/run-1__w03/1700-x.png").put(PNG, png));
  });

  it("allows an admin, who holds every permission implicitly", async () => {
    await seedUser("admin2", { role: "admin" });
    const s = await storageAsUser("admin2");
    await assertSucceeds(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("blocks a member with no course permission", async () => {
    await seedUser("plain", { role: "member" });
    const s = await storageAsUser("plain");
    await assertFails(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("blocks a committee member who was never granted one", async () => {
    // Course authoring is a permission, not a rank: sitting on the committee
    // (SU-recognised or not) grants nothing here.
    await seedUser("suCommittee", { role: "committee", suRecognised: true });
    const s = await storageAsUser("suCommittee");
    await assertFails(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("blocks a holder of the NEWSLETTER permissions (the keys are not shared)", async () => {
    await seedUser("nDrafter", {
      role: "member",
      permissions: { draftNewsletter: true, approveNewsletter: true },
    });
    const s = await storageAsUser("nDrafter");
    await assertFails(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("blocks a signed-out visitor from uploading", async () => {
    const s = await storageAsAnon();
    await assertFails(s.ref("course-images/course-1/x.png").put(PNG, png));
  });

  it("is readable by a signed-out visitor (the public course page renders it)", async () => {
    const s = await storageAsAnon();
    await assertSucceeds(
      s.ref("course-images/course-1/x.png").getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });

  it("blocks a non-image content type", async () => {
    await seedUser("cDrafter", { role: "member", permissions: { draftCourse: true } });
    const s = await storageAsUser("cDrafter");
    await assertFails(
      s.ref("course-images/course-1/evil.html").put(PNG, { contentType: "text/html" }),
    );
  });

  it("does not require the course or week to exist (the folder is unvalidated)", async () => {
    // Stated rather than assumed: unlike newsletter-images and event-images
    // there is no ownership test here, because `{folder}` is a courseId in one
    // editor and a runId__weekId pair in the other. See the block's comment.
    await seedUser("cDrafter", { role: "member", permissions: { draftCourse: true } });
    const s = await storageAsUser("cDrafter");
    await assertSucceeds(s.ref("course-images/no-such-thing/x.png").put(PNG, png));
  });
});

describe("worksheet-images: signed-in read, scoped committee write, no SVG", () => {
  // The two paths worksheets add are deliberately UNLIKE the four blocks above,
  // and each difference is a decision this suite pins:
  //  - read is SIGNED-IN, not public. A worksheet is never public, and a
  //    question body can carry a screenshot of something internal.
  //  - `image/svg+xml` is refused explicitly rather than merely characterised.
  //  - the {ownerId} folder IS scoped, unlike course-images, because it names
  //    a document either way: a worksheet (gate: authorUid) in the editor, a
  //    circulation (gate: staffUids) when staff edit the sent copy. Both are
  //    probed. Without that, a committee member refused the worksheet DOCUMENT
  //    in firestore.rules could still overwrite its IMAGES here, which is the
  //    event-images hole repeated on a newer path.

  /** A library worksheet, the document the author branch of the rule reads. */
  async function seedWorksheet(id, authorUid) {
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().collection("worksheets").doc(id);
      await ref.set({ title: "Reading reflection", authorUid, private: false, items: [] });
      await ref.get();
    });
  }

  /** A circulation, the document the staff branch of the rule reads. */
  async function seedCirculationDoc(id, staffUids) {
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().collection("circulations").doc(id);
      await ref.set({ worksheetId: "w1", title: "Reading reflection", staffUids, status: "open" });
      await ref.get();
    });
  }

  it("allows a NON-SU committee member to upload to their OWN worksheet", async () => {
    // Non-SU on purpose: the library is open to the whole committee, so if
    // this ever tightens to suRecognised, this is the test that goes red.
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    await seedWorksheet("w1", "wsCommittee");
    const s = await storageAsUser("wsCommittee");
    await assertSucceeds(s.ref("worksheet-images/w1/body.png").put(PNG, png));
  });

  it("allows an SU-recognised committee member to upload to their own", async () => {
    await seedUser("wsSu", { role: "committee", suRecognised: true });
    await seedWorksheet("w-su", "wsSu");
    const s = await storageAsUser("wsSu");
    await assertSucceeds(s.ref("worksheet-images/w-su/body.png").put(PNG, png));
  });

  it("blocks a committee member overwriting ANOTHER author's worksheet imagery", async () => {
    // The hole this block was fixed for. firestore.rules refuses this person
    // the worksheet DOCUMENT (edit somebody else's is admin-only, everyone
    // else makes a copy), so letting them replace the pictures inside it would
    // be the same edit through a side channel: the body of a question the
    // committee is reading, and the option images inside a live circulation.
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    await seedWorksheet("w-victim", "another-person");
    const s = await storageAsUser("wsCommittee");
    await assertFails(s.ref("worksheet-images/w-victim/body.png").put(PNG, png));
  });

  it("lets an ADMIN upload to somebody else's worksheet folder", async () => {
    // Editing somebody else's worksheet is admin-only rather than nobody's:
    // an admin fixing a broken image must not have to go through the author.
    await seedUser("wsAdmin", { role: "admin" });
    await seedWorksheet("w-victim", "another-person");
    const s = await storageAsUser("wsAdmin");
    await assertSucceeds(s.ref("worksheet-images/w-victim/body.png").put(PNG, png));
  });

  it("lets a circulation's STAFF upload under the circulation id", async () => {
    // The second shape of {ownerId}: staff editing the sent copy mid-flight
    // upload under the circulation, not the worksheet it was copied from.
    await seedUser("wsReviewer", { role: "committee", suRecognised: true });
    await seedCirculationDoc("circ-images", ["sender1", "wsReviewer"]);
    const s = await storageAsUser("wsReviewer");
    await assertSucceeds(s.ref("worksheet-images/circ-images/opt.png").put(PNG, png));
  });

  it("blocks a committee member who is NOT staff on that circulation", async () => {
    // A circulation's imagery is what its recipients are looking at while they
    // answer. Committee membership alone does not buy the right to change it.
    await seedUser("wsOutsider2", { role: "committee", suRecognised: true });
    await seedCirculationDoc("circ-images", ["sender1"]);
    const s = await storageAsUser("wsOutsider2");
    await assertFails(s.ref("worksheet-images/circ-images/opt.png").put(PNG, png));
  });

  it("allows an upload under an id that names NEITHER document yet", async () => {
    // The newsletter-images null-safety branch: firestore.get() on a missing
    // document returns null and .get() on null raises, which would deny by
    // error, and the editor can legitimately upload the first image before its
    // document has settled. Uploading under an id nothing references is
    // harmless; the hole closed above was overwriting somebody else's.
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    const s = await storageAsUser("wsCommittee");
    await assertSucceeds(s.ref("worksheet-images/w-unsettled/body.png").put(PNG, png));
  });

  it("blocks a plain member, even one holding circulateWorksheet", async () => {
    // Circulating is a permission to SEND, not to author. A member who holds it
    // must not gain the committee's authoring surface with it.
    await seedUser("wsMember", { role: "member" });
    await seedUser("wsCirculator", {
      role: "member",
      permissions: { circulateWorksheet: true },
    });
    const member = await storageAsUser("wsMember");
    await assertFails(member.ref("worksheet-images/w1/body.png").put(PNG, png));
    const circulator = await storageAsUser("wsCirculator");
    await assertFails(circulator.ref("worksheet-images/w1/body.png").put(PNG, png));
  });

  it("blocks a signed-out visitor from uploading", async () => {
    const s = await storageAsAnon();
    await assertFails(s.ref("worksheet-images/w1/body.png").put(PNG, png));
  });

  it("blocks image/svg+xml, unlike the older world-readable image paths", async () => {
    // `image/svg+xml` satisfies `image/.*`, and an SVG is a document format
    // that can carry script. newsletter-images has a CHARACTERISATION test
    // recording that it lets one through; this path was added afterwards, so
    // there is no reason to inherit the hole.
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    const s = await storageAsUser("wsCommittee");
    await assertFails(
      s.ref("worksheet-images/w1/evil.svg").put(PNG, { contentType: "image/svg+xml" }),
    );
  });

  it("blocks a non-image content type", async () => {
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    const s = await storageAsUser("wsCommittee");
    await assertFails(
      s.ref("worksheet-images/w1/evil.html").put(PNG, { contentType: "text/html" }),
    );
  });

  it("blocks an upload at or over the 5 MB cap", async () => {
    await seedUser("wsCommittee", { role: "committee", suRecognised: false });
    const s = await storageAsUser("wsCommittee");
    await assertFails(
      s.ref("worksheet-images/w1/huge.png").put(new Uint8Array(5 * 1024 * 1024), png),
    );
  });

  it("is readable by any signed-in account", async () => {
    await seedUser("wsMember", { role: "member" });
    const s = await storageAsUser("wsMember");
    await assertSucceeds(
      s.ref("worksheet-images/w1/body.png").getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });

  it("is NOT readable by a signed-out visitor (unlike every image path above)", async () => {
    const s = await storageAsAnon();
    await assertFails(s.ref("worksheet-images/w1/body.png").getMetadata());
  });
});

describe("worksheet-uploads: no client write at all, scoped read", () => {
  // The recipient's image ANSWERS. Every client write is refused, admin and
  // uploader included, because the route is the only thing that can check the
  // MAGIC BYTES: a storage rule sees the Content-Type the client declares,
  // which is a claim, so no version of this block would be equivalent.
  async function seedCirculation(staffUids = ["sender1", "reviewer1"]) {
    const env = await getTestEnv("test");
    await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().collection("circulations").doc("circ1");
      await ref.set({
        worksheetId: "w1",
        title: "Reading reflection",
        senderUid: "sender1",
        authorUid: "sender1",
        reviewerUids: ["reviewer1"],
        staffUids,
        status: "open",
      });
      await ref.get();
    });
  }

  const uploadPath = "worksheet-uploads/circ1/recipA/answer.png";

  it("refuses the recipient's own upload (it goes through the route)", async () => {
    await seedUser("recipA", { role: "committee", suRecognised: false });
    await seedCirculation();
    const s = await storageAsUser("recipA");
    await assertFails(s.ref(uploadPath).put(PNG, png));
  });

  it("refuses an ADMIN's upload as well", async () => {
    await seedUser("wsAdmin", { role: "admin" });
    await seedCirculation();
    const s = await storageAsUser("wsAdmin");
    await assertFails(s.ref(uploadPath).put(PNG, png));
  });

  it("refuses a staff upload, and a signed-out one", async () => {
    await seedUser("reviewer1", { role: "committee", suRecognised: true });
    await seedCirculation();
    const staff = await storageAsUser("reviewer1");
    await assertFails(staff.ref(uploadPath).put(PNG, png));
    const anon = await storageAsAnon();
    await assertFails(anon.ref(uploadPath).put(PNG, png));
  });

  it("lets the recipient read their own upload, with no cross-service lookup", async () => {
    await seedUser("recipA", { role: "committee", suRecognised: false });
    await seedCirculation();
    const s = await storageAsUser("recipA");
    await assertSucceeds(
      s.ref(uploadPath).getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });

  it("lets the circulation's staff read it", async () => {
    await seedUser("reviewer1", { role: "committee", suRecognised: true });
    await seedCirculation();
    const s = await storageAsUser("reviewer1");
    await assertSucceeds(
      s.ref(uploadPath).getMetadata().catch((e) => {
        if (e?.code === "storage/object-not-found") return null;
        throw e;
      }),
    );
  });

  it("refuses ANOTHER recipient of the same circulation", async () => {
    // The uploads path is the one place a recipient's own words leave the
    // response document, so it has to honour the same scoping the response
    // does: recipB is on this circulation and still cannot see recipA's files.
    await seedUser("recipB", { role: "committee", suRecognised: false });
    await seedCirculation();
    const s = await storageAsUser("recipB");
    await assertFails(s.ref(uploadPath).getMetadata());
  });

  it("refuses a committee member who is not staff on this circulation", async () => {
    await seedUser("wsOutsider", { role: "committee", suRecognised: true });
    await seedCirculation();
    const s = await storageAsUser("wsOutsider");
    await assertFails(s.ref(uploadPath).getMetadata());
  });

  it("refuses a signed-out visitor", async () => {
    await seedCirculation();
    const s = await storageAsAnon();
    await assertFails(s.ref(uploadPath).getMetadata());
  });

  it("denies rather than errors when the circulation does not exist", async () => {
    // firestore.get() on a missing document returns null and .get() on null
    // raises, so the staff branch is guarded with exists(). Without it this
    // would deny by ERROR, which is the same answer for the wrong reason and
    // hides the difference between "not staff" and "typo in the path".
    await seedUser("reviewer1", { role: "committee", suRecognised: true });
    const s = await storageAsUser("reviewer1");
    await assertFails(s.ref("worksheet-uploads/no-such-circ/recipA/answer.png").getMetadata());
  });
});

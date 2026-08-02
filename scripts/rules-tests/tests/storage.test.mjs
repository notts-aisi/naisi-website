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

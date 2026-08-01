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

describe("task attachments — the suRecognised divergence", () => {
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

  it("FINDING: a NON-SU committee member reaches attachments they are denied in Firestore", async () => {
    // firestore.rules gates committee task access on isSuCommittee() —
    // role == 'committee' AND suRecognised == true. storage.rules checks only
    // `role in ['committee','admin']`, with no suRecognised anywhere in the
    // file. So the document is denied while its attachment blobs are not.
    await seedUser("nonSu", { role: "committee", suRecognised: false });
    await seedCommitteeTask();
    const s = await storageAsUser("nonSu");
    await assertSucceeds(s.ref("tasks/t1/a1/file.png").put(PNG, png));
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

describe("application-emails — the drift check", () => {
  it("is denied by the committed rules, for an admin, on the exact path the app uses", async () => {
    // EmailDesignEditor uploads to `application-emails/{templateId}/...`, and
    // no committed block covers it. If this test ever starts FAILING, the repo
    // gained a rule — good. If the feature works in production while this
    // passes, the DEPLOYED ruleset is a superset of the repo, which is the
    // drift that broke event-image uploads once already.
    await seedUser("admin1", { role: "admin" });
    const s = await storageAsUser("admin1");
    await assertFails(s.ref("application-emails/tpl1/tpl1/x.png").put(PNG, png));
  });
});

describe("unmatched paths deny by default", () => {
  it("rejects an arbitrary top-level path even for an admin", async () => {
    await seedUser("admin1", { role: "admin" });
    const s = await storageAsUser("admin1");
    await assertFails(s.ref("anything-else/x.png").put(PNG, png));
  });
});

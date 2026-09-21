/**
 * `trackedLinks`: one short link, naisi.uk/q/<slug>, and where it goes.
 *
 * The slug is the document id and the thing that gets PRINTED, which is what
 * every case here comes back to:
 *
 *  - ADMINS ONLY, both directions. Nothing in a browser reads this collection
 *    but the admin console; a scan is answered by the short-link route on the
 *    Admin SDK. A wider read would list every campaign the society is running.
 *  - NOBODY DELETES, admins included. A printed code's record has to outlive
 *    every tidy-up, because the paper it is on cannot be recalled. A link is
 *    switched off with `active`.
 *  - A RECORD CANNOT CLAIM TO BE ANOTHER LINK. The `slug` field has to equal
 *    the document id.
 *  - WHO MADE A LINK, AND WHEN, IS NOT EDITABLE, and the editor named on a
 *    write is the person making it.
 *
 * What is NOT here: whether a destination is SAFE to follow. A rule has no URL
 * parser, so that is `parseDestination()`, run on save and again on every
 * scan, and held by `tests/tracked-links.test.mjs`.
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
  await getTestEnv("tracked-links");
});
after(cleanup);
afterEach(clearData);

const SLUG = "poster";
const CREATED_AT = new Date("2026-09-20T20:00:00Z");

/** A record shaped the way the console writes one, made by `admin1`. */
function link(overrides = {}) {
  return {
    slug: SLUG,
    label: "General society poster",
    destination: "/links",
    type: "qr",
    campaign: "Freshers 2026",
    active: true,
    countOffsite: false,
    createdByUid: "admin1",
    updatedByUid: "admin1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

async function seedLink() {
  await seed(async (db) => {
    await db.collection("trackedLinks").doc(SLUG).set(link());
  });
}

async function everyoneButAdmin() {
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
  ];
}

async function asAdmin(uid = "admin1") {
  await seedUser(uid, { role: "admin" });
  return asUser(uid);
}

describe("trackedLinks: who may touch it", () => {
  it("an admin reads one, lists them, creates one and edits one", async () => {
    await seedLink();
    const db = await asAdmin();
    await assertSucceeds(db.collection("trackedLinks").doc(SLUG).get());
    await assertSucceeds(db.collection("trackedLinks").get());
    await assertSucceeds(
      db.collection("trackedLinks").doc("flyer").set(link({ slug: "flyer", label: "A5 flyer" })),
    );
    await assertSucceeds(
      db.collection("trackedLinks").doc(SLUG).update({
        destination: "/events",
        updatedByUid: "admin1",
        updatedAt: new Date(),
      }),
    );
  });

  it("nobody else reads, lists, creates or edits, at any role", async () => {
    await seedLink();
    for (const [label, db] of await everyoneButAdmin()) {
      await assertFails(db.collection("trackedLinks").doc(SLUG).get(), `${label} read a link`);
      await assertFails(db.collection("trackedLinks").get(), `${label} listed the links`);
      await assertFails(
        db.collection("trackedLinks").doc("flyer").set(link({ slug: "flyer" })),
        `${label} created a link`,
      );
      await assertFails(
        db.collection("trackedLinks").doc(SLUG).update({ destination: "/events" }),
        `${label} repointed a link`,
      );
    }
  });

  it("REPOINTING A PRINTED CODE: a committee member cannot send the poster somewhere else", async () => {
    // The attack written out. Everybody who scans the poster follows this one
    // field, so it is the most valuable string in the collection to a
    // stranger, and a committee session is the likeliest one to be open.
    await seedLink();
    await seedUser("su1", { role: "committee", suRecognised: true });
    const db = await asUser("su1");
    await assertFails(
      db.collection("trackedLinks").doc(SLUG).update({
        destination: "https://example.com/not-the-society",
        updatedByUid: "su1",
      }),
    );
  });
});

describe("trackedLinks: a printed code's record cannot be removed", () => {
  it("nobody deletes a link, an admin included", async () => {
    await seedLink();
    const admin = await asAdmin();
    await assertFails(admin.collection("trackedLinks").doc(SLUG).delete(), "an admin deleted a link");
    for (const [label, db] of await everyoneButAdmin()) {
      await assertFails(db.collection("trackedLinks").doc(SLUG).delete(), `${label} deleted a link`);
    }
  });

  it("switching one off is the way, and an admin can", async () => {
    await seedLink();
    const db = await asAdmin();
    await assertSucceeds(
      db.collection("trackedLinks").doc(SLUG).update({
        active: false,
        updatedByUid: "admin1",
        updatedAt: new Date(),
      }),
    );
  });
});

describe("trackedLinks: the shape an admin may write", () => {
  it("the slug field has to equal the document id", async () => {
    const db = await asAdmin();
    await assertFails(db.collection("trackedLinks").doc("flyer").set(link({ slug: "poster" })));
  });

  it("the document id has to be a slug", async () => {
    const db = await asAdmin();
    for (const id of ["Flyer", "a_b", "way-too-long-to-be-a-slug", "fly er"]) {
      await assertFails(
        db.collection("trackedLinks").doc(id).set(link({ slug: id })),
        `"${id}" was accepted as a slug`,
      );
    }
  });

  it("the kind is one of the two", async () => {
    const db = await asAdmin();
    await assertFails(db.collection("trackedLinks").doc("flyer").set(link({ slug: "flyer", type: "banner" })));
    await assertSucceeds(db.collection("trackedLinks").doc("bio").set(link({ slug: "bio", type: "link" })));
  });

  it("a destination is a non-empty string of bounded length", async () => {
    const db = await asAdmin();
    const at = (id, destination) =>
      db.collection("trackedLinks").doc(id).set(link({ slug: id, destination }));
    await assertFails(at("a", ""));
    await assertFails(at("b", 42));
    await assertFails(at("c", `/${"x".repeat(500)}`));
    await assertSucceeds(at("d", `/${"x".repeat(499)}`));
  });

  it("label and campaign are bounded, and the two switches are booleans", async () => {
    const db = await asAdmin();
    const at = (id, overrides) =>
      db.collection("trackedLinks").doc(id).set(link({ slug: id, ...overrides }));
    await assertFails(at("a", { label: "x".repeat(81) }));
    await assertFails(at("b", { campaign: "x".repeat(41) }));
    await assertFails(at("c", { active: "yes" }));
    await assertFails(at("d", { countOffsite: 1 }));
    await assertSucceeds(at("e", { campaign: "" }));
  });

  it("no field outside the shape can ride along", async () => {
    // A counter on the record would be a number an admin could set, and the
    // scan counts are worth reading only because nothing but a scan moves them.
    const db = await asAdmin();
    await assertFails(
      db.collection("trackedLinks").doc("flyer").set({ ...link({ slug: "flyer" }), totalScans: 9000 }),
    );
  });
});

describe("trackedLinks: who made a link is not rewritten", () => {
  it("a new link names its maker as the person creating it", async () => {
    const db = await asAdmin();
    await assertFails(
      db.collection("trackedLinks").doc("flyer").set(link({ slug: "flyer", createdByUid: "someone-else" })),
    );
  });

  it("an edit names its editor as the person editing", async () => {
    await seedLink();
    const db = await asAdmin("admin2");
    await assertFails(
      db.collection("trackedLinks").doc(SLUG).update({ label: "Edited", updatedByUid: "admin1" }),
    );
    await assertSucceeds(
      db.collection("trackedLinks").doc(SLUG).update({ label: "Edited", updatedByUid: "admin2" }),
    );
  });

  it("an edit cannot change who created the link or when", async () => {
    await seedLink();
    const db = await asAdmin("admin2");
    await assertFails(
      db.collection("trackedLinks").doc(SLUG).update({ createdByUid: "admin2", updatedByUid: "admin2" }),
    );
    await assertFails(
      db.collection("trackedLinks").doc(SLUG).update({ createdAt: new Date(), updatedByUid: "admin2" }),
    );
  });
});

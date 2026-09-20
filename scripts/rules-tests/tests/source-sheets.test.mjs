/**
 * `sourceSheets/{slug}`: the bibliography behind one piece of printed
 * material, served publicly at `/sources/<slug>`.
 *
 * ONE PROPERTY MATTERS MORE THAN THE REST HERE, and it is the reason this
 * collection does not copy the `news` block sitting immediately above it in
 * `firestore.rules`. `news` is `allow read: if true`, which is defensible for
 * an article whose slug has to be guessed. A source sheet's slug is PRINTED ON
 * THE POSTER: guessing is not required, so a public read rule would put an
 * unpublished draft one client-side `getDoc` away from everybody holding one.
 *
 * So: admin read AND admin write, nobody else, not even a read, and the public
 * pages go through a server-only Admin SDK fetcher that filters on
 * `publishedAt` and projects what it returns.
 *
 * The consequence tested at the bottom is the one a reader will ask about: a
 * PUBLISHED sheet is not readable client-side either. That is correct. Nothing
 * in a browser reads this collection but an admin's own editor.
 */
import { after, afterEach, before, describe, it } from "node:test";
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

before(async () => {
  await getTestEnv("source-sheets");
});
after(cleanup);
afterEach(clearData);

/** One stored entry. `publishedAt` present means published. */
async function seedSheet(slug, { published = false } = {}) {
  await seed(async (db) => {
    const ref = db.collection("sourceSheets").doc(slug);
    await ref.set({
      title: "Freshers fair poster",
      context: "Societies fair, September 2026",
      summary: "",
      image: null,
      file: null,
      items: [
        { id: "a", n: 1, name: "International AI Safety Report", url: "https://example.ac.uk/r" },
        { id: "b", n: 4, name: "A second source", url: "https://example.ac.uk/s" },
      ],
      nextNumber: 5,
      createdByUid: "admin1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(published ? { publishedAt: new Date(), firstPublishedAt: new Date() } : {}),
    });
    await ref.get();
  });
}

/**
 * Every persona the site has, minus the admin. Written as one list because the
 * answer is the same for all of them and a test per role would hide that.
 */
const REFUSED = [
  ["a pending account", "pending1", { role: "pending" }],
  ["a member", "member1", { role: "member" }],
  ["a non-SU committee member", "committee1", { role: "committee", suRecognised: false }],
  ["an SU-recognised committee member", "sucom1", { role: "committee", suRecognised: true }],
  ["a draftEvent holder", "eDrafter", { role: "member", permissions: { draftEvent: true } }],
  ["a draftCourse holder", "cDrafter", { role: "member", permissions: { draftCourse: true } }],
];

describe("sourceSheets: an admin, and nobody else, in both directions", () => {
  it("lets an admin read one entry, list the collection, and write", async () => {
    await seedUser("admin1", { role: "admin" });
    await seedSheet("freshers-2026");
    const db = await asUser("admin1");

    await assertSucceeds(db.collection("sourceSheets").doc("freshers-2026").get());
    await assertSucceeds(db.collection("sourceSheets").get());
    await assertSucceeds(
      db.collection("sourceSheets").doc("freshers-2026").update({ title: "Renamed" }),
    );
    await assertSucceeds(
      db.collection("sourceSheets").doc("new-entry").set({
        title: "New entry",
        items: [],
        nextNumber: 1,
        createdByUid: "admin1",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    await assertSucceeds(db.collection("sourceSheets").doc("freshers-2026").delete());
  });

  for (const [label, uid, data] of REFUSED) {
    it(`refuses ${label} a read of a DRAFT, a list, and every write`, async () => {
      await seedUser(uid, data);
      await seedSheet("freshers-2026");
      const db = await asUser(uid);

      await assertFails(db.collection("sourceSheets").doc("freshers-2026").get());
      await assertFails(db.collection("sourceSheets").get());
      await assertFails(
        db.collection("sourceSheets").doc("freshers-2026").update({ title: "Defaced" }),
      );
      await assertFails(db.collection("sourceSheets").doc("theirs").set({ title: "Mine now" }));
      await assertFails(db.collection("sourceSheets").doc("freshers-2026").delete());
    });
  }

  it("refuses a signed-out visitor a read of a draft and of the collection", async () => {
    await seedSheet("freshers-2026");
    const db = await asAnon();
    await assertFails(db.collection("sourceSheets").doc("freshers-2026").get());
    await assertFails(db.collection("sourceSheets").get());
    await assertFails(db.collection("sourceSheets").doc("freshers-2026").set({ title: "x" }));
  });

  it("refuses a PUBLISHED entry to a signed-out visitor too, which is the design", async () => {
    // Deliberate, and the difference from `news`. The public page is served by
    // a server-only Admin SDK fetcher, so nothing is lost by closing the
    // client read, and what is gained is that the printed slug of an
    // UNPUBLISHED entry cannot be turned into a read of it.
    await seedSheet("freshers-2026", { published: true });
    const anon = await asAnon();
    await assertFails(anon.collection("sourceSheets").doc("freshers-2026").get());

    await seedUser("member1", { role: "member" });
    const member = await asUser("member1");
    await assertFails(member.collection("sourceSheets").doc("freshers-2026").get());
  });

  it("refuses a query that filters on publishedAt, the shape a leak would take", async () => {
    // The obvious client-side workaround if somebody later moves the public
    // page off the server fetcher: copy the news query into the browser. The
    // rule judges a list by its SHAPE, so the filter buys nothing, and this
    // test is here so the attempt fails as a named refusal rather than as a
    // silently empty page.
    await seedSheet("freshers-2026", { published: true });
    await seedUser("member1", { role: "member" });
    const db = await asUser("member1");
    await assertFails(
      db.collection("sourceSheets").where("publishedAt", "!=", null).get(),
    );
  });

  it("lets an admin unpublish: deleting publishedAt and clearing both files", async () => {
    // Unpublishing is a field delete plus two nulls, and it is what "pulled
    // down" means for material that has been printed. The storage half of it
    // is in storage.test.mjs, which pins the admin-only `allow delete`.
    await seedUser("admin1", { role: "admin" });
    await seedSheet("freshers-2026", { published: true });
    const db = await asUser("admin1");

    await assertSucceeds(
      db.collection("sourceSheets").doc("freshers-2026").update({
        publishedAt: firebase.firestore.FieldValue.delete(),
        image: null,
        file: null,
      }),
    );
  });
});

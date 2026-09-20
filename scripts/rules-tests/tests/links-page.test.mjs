/**
 * `linksPage/main`: what the public /links page says.
 *
 * Admins only, in BOTH directions, although the page it describes is public.
 * The public page reads this document on the server, which drops the hidden
 * rows and the editor's uid and validates every address before anything
 * reaches HTML. A public read rule would hand a browser the hidden rows and
 * the unvalidated addresses, and a wider write rule would let somebody put a
 * link of their choosing on the page most printed QR codes land on.
 *
 * The last case is that attack written out.
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
  await getTestEnv("links-page");
});
after(cleanup);
afterEach(clearData);

const PAGE = {
  applications: {
    fellowship: { open: false, href: "" },
    facilitator: { open: false, href: "" },
    incubator: { open: false, href: "" },
  },
  groups: [
    {
      id: "group-1",
      heading: "Get involved",
      rows: [{ id: "courses", label: "Our courses", sub: "", href: "/courses", soon: false, hidden: false }],
    },
  ],
  updatedByUid: "admin1",
  updatedAt: new Date("2026-09-21T09:00:00Z"),
};

async function seedPage() {
  await seed(async (db) => {
    await db.doc("linksPage/main").set(PAGE);
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

describe("linksPage", () => {
  it("an admin reads the page and saves it", async () => {
    await seedPage();
    await seedUser("admin1", { role: "admin" });
    const db = await asUser("admin1");
    await assertSucceeds(db.doc("linksPage/main").get());
    await assertSucceeds(db.doc("linksPage/main").set({ ...PAGE, groups: [] }));
  });

  it("an admin's first save creates it", async () => {
    await seedUser("admin1", { role: "admin" });
    const db = await asUser("admin1");
    await assertSucceeds(db.doc("linksPage/main").set(PAGE));
  });

  it("there is one page: an admin cannot write a second document beside it", async () => {
    await seedUser("admin1", { role: "admin" });
    const db = await asUser("admin1");
    await assertFails(db.doc("linksPage/other").set(PAGE));
  });

  it("nobody else reads it, although the page it describes is public", async () => {
    // The stored document carries hidden rows and addresses nobody has
    // validated yet. The public page gets a projection from the server.
    await seedPage();
    for (const [label, db] of await everyoneButAdmin()) {
      await assertFails(db.doc("linksPage/main").get(), `${label} read the links page document`);
      await assertFails(db.collection("linksPage").get(), `${label} listed the collection`);
    }
  });

  it("A LINK OF THEIR CHOOSING: nobody else can put a row on the page printed codes land on", async () => {
    await seedPage();
    const hostile = {
      ...PAGE,
      groups: [
        {
          id: "group-1",
          heading: "Get involved",
          rows: [{ id: "x", label: "Join the society", sub: "", href: "https://example.com/not-us", soon: false, hidden: false }],
        },
      ],
    };
    for (const [label, db] of await everyoneButAdmin()) {
      await assertFails(db.doc("linksPage/main").set(hostile), `${label} rewrote the links page`);
      await assertFails(db.doc("linksPage/main").delete(), `${label} deleted the links page`);
    }
  });
});

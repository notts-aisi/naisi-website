/**
 * The two WORLD-READABLE collections added by the site-notice feature. These
 * are the only `allow read: if true` data paths in the app besides `news`, so
 * they carry the most exposure per line of rules in the file.
 *
 * What must hold:
 *  - anyone can read the notice (signed-out visitors are the whole point)
 *  - nobody can write either collection from a client, admin included — every
 *    write goes through /api/admin/site-notice on the Admin SDK
 *  - `publicConfig` is pinned to the single doc id, so `list` cannot enumerate
 *    a future doc dropped into that collection
 *  - `config/siteNoticeAudit`, which holds who flipped the notice, stays
 *    unreadable — the audit trail is deliberately NOT on the public doc
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
  await getTestEnv("public-config");
});
after(cleanup);
afterEach(clearData);

describe("publicConfig/siteNotice", () => {
  it("is readable by a signed-out visitor", async () => {
    await seed(async (db) => {
      await db.collection("publicConfig").doc("siteNotice").set({ active: true, level: "warn" });
    });
    const db = await asAnon();
    await assertSucceeds(db.collection("publicConfig").doc("siteNotice").get());
  });

  it("is not writable by anyone — anonymous, member, or admin", async () => {
    await seedUser("admin1", { role: "admin" });
    await seedUser("member1", { role: "member" });
    for (const db of [await asAnon(), await asUser("member1"), await asUser("admin1")]) {
      await assertFails(
        db.collection("publicConfig").doc("siteNotice").set({ active: true }),
      );
    }
  });

  it("CANNOT be enumerated — the match is pinned to the single doc id", async () => {
    await seed(async (db) => {
      await db.collection("publicConfig").doc("siteNotice").set({ active: false });
      // A future doc someone drops in must NOT become world-readable just by
      // living in this collection. `allow read` covers `list`, which is why the
      // rule pins the doc id instead of using a {docId} wildcard.
      await db.collection("publicConfig").doc("someFutureSecret").set({ token: "shh" });
    });
    const db = await asAnon();
    await assertFails(db.collection("publicConfig").get());
    await assertFails(db.collection("publicConfig").doc("someFutureSecret").get());
  });
});

describe("maintenanceLog", () => {
  it("is readable and enumerable by a signed-out visitor (deliberate)", async () => {
    await seed(async (db) => {
      await db.collection("maintenanceLog").doc("m1").set({
        startedAt: new Date(),
        level: "warn",
        message: "Registrations were failing.",
      });
    });
    const db = await asAnon();
    // Enumerable ON PURPOSE — it is a public history page. The safety property
    // is what may be WRITTEN here, enforced by the route, not by rules.
    await assertSucceeds(db.collection("maintenanceLog").get());
    await assertSucceeds(db.collection("maintenanceLog").doc("m1").get());
  });

  it("is not writable by anyone, admin included", async () => {
    await seedUser("admin1", { role: "admin" });
    for (const db of [await asAnon(), await asUser("admin1")]) {
      await assertFails(
        db.collection("maintenanceLog").doc("forged").set({ startedAt: new Date() }),
      );
    }
  });
});

describe("config/siteNoticeAudit — who flipped the notice stays private", () => {
  it("is unreadable by an anonymous visitor and by a plain member", async () => {
    await seed(async (db) => {
      await db
        .collection("config")
        .doc("siteNoticeAudit")
        .set({ updatedByUid: "admin1", updatedByName: "Real Name" });
    });
    await seedUser("member1", { role: "member" });
    await assertFails((await asAnon()).collection("config").doc("siteNoticeAudit").get());
    await assertFails((await asUser("member1")).collection("config").doc("siteNoticeAudit").get());
  });
});

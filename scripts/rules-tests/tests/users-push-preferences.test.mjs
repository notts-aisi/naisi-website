/**
 * Rules tests for the notification grid stored on `users.profile.notifications`
 * (V3 W3 PR32, extended for the per-category grid).
 *
 * ## Why this file exists when the rules did not change
 *
 * The grid saves client-direct: the profile form writes the whole
 * `profile.notifications` map, and single cells save on toggle under
 * `profile.notifications.categories.*` and `profile.notifications.push.*`.
 * That works today only because the users self-update rule pins named FIELDS
 * (`role`, `tracks`, `permissions`, `suRecognised`, `admissionsReviewer`,
 * `paidMembershipYears`, `email`, the consent pair, the uni email) and has no
 * `keys().hasOnly()` over `profile`, so a member may write any profile
 * subfield the pins do not name.
 *
 * That is a load-bearing property of a file nobody edits for this feature,
 * which is exactly the kind of thing that gets tightened later by somebody
 * closing an unrelated hole. If a `hasOnly` is ever added to `profile` or to
 * `notifications` without listing every cell, switches stop saving with a
 * permission error and nothing else in the suite notices. These writes are the
 * alarm, and the source assertion below states the property directly rather
 * than only by its consequences.
 *
 * The last cases are the other half: the write is a member's own preference,
 * so it must not become a hole. Writing it may not carry any admin-set field,
 * and it may not be aimed at somebody else's document.
 *
 * EVERY CASE RUNS AS A MEMBER. The admin branch of the self-update rule is
 * resource-independent, so testing this as an admin would pass whatever the
 * member-facing half of the rule said.
 *
 * ## Mutation check (restore bit-exact afterwards)
 *
 *  1. Add `&& request.resource.data.profile.keys().hasOnly(['preferredName'])`
 *     to the users self-update rule -> the save tests and the source
 *     assertion go red.
 *  2. Delete `request.resource.data.role == resource.data.role` from the
 *     self-update branch -> the role-smuggling test goes red.
 *  3. Lower `smallEnough()`'s profile cap to 1 -> the size test goes red.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import {
  asUser,
  assertFails,
  assertSucceeds,
  cleanup,
  clearData,
  getTestEnv,
  seedUser,
} from "../lib/harness.mjs";

before(async () => {
  // Unique per file: a shared project id lets one file's clearFirestore()
  // wipe another's fixtures mid-test (see harness.mjs).
  await getTestEnv("users-push-preferences");
});
after(cleanup);
afterEach(clearData);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

/** The four rows of the grid, in both columns. */
const ROWS = ["newsletter", "events", "courses", "tasks"];

/** A complete stored grid, as the profile form writes it. */
function grid() {
  return {
    channels: { gmail: true, uniEmail: false },
    categories: { newsletter: true, events: false, courses: true, tasks: true },
    push: { newsletter: false, events: false, courses: true, tasks: false },
  };
}

describe("a member owns their notification grid", () => {
  it("can write the push map on their own document", async () => {
    await seedUser("member1", { role: "member" });
    const db = await asUser("member1");
    await assertSucceeds(
      db.collection("users").doc("member1").update({
        "profile.notifications.push": grid().push,
      }),
    );
  });

  it("can write a single cell in either column, one leaf at a time", async () => {
    // The grid's cells save on toggle, so each one is its own dotted-path
    // write. A rule that accepted the whole map but not a leaf would pass the
    // test above and still break every switch on the page.
    await seedUser("member5", {
      role: "member",
      profile: { preferredName: "Ash", notifications: grid() },
    });
    const db = await asUser("member5");
    for (const row of ROWS) {
      await assertSucceeds(
        db
          .collection("users")
          .doc("member5")
          .update({ [`profile.notifications.categories.${row}`]: false }),
      );
      await assertSucceeds(
        db
          .collection("users")
          .doc("member5")
          .update({ [`profile.notifications.push.${row}`]: true }),
      );
    }
  });

  it("can write it beside an untouched channels and categories map", async () => {
    // The profile form writes the whole `notifications` map; the push card
    // writes one field path inside it. Both shapes have to be accepted, or
    // the two save paths disagree about which one is allowed.
    await seedUser("member2", {
      role: "member",
      profile: {
        preferredName: "Sam",
        notifications: {
          channels: { gmail: true, uniEmail: false },
          categories: { newsletter: true, events: false, courses: false, tasks: true },
        },
      },
    });
    const db = await asUser("member2");
    await assertSucceeds(
      db.collection("users").doc("member2").update({ "profile.notifications": grid() }),
    );
  });

  it("the extra rows do not push the doc past the size cap", async () => {
    // `smallEnough()` caps `profile` at 30 KEYS, and `notifications` is ONE of
    // them however many rows it carries. Asserted with a profile that is
    // already busy, so the check is about the cap and not about an empty doc.
    const profile = { notifications: grid() };
    for (let i = 0; i < 20; i += 1) profile[`filler${i}`] = "x";
    await seedUser("member6", { role: "member", profile });
    const db = await asUser("member6");
    await assertSucceeds(
      db.collection("users").doc("member6").update({ "profile.notifications": grid() }),
    );
  });

  it("cannot smuggle a role change alongside it", async () => {
    await seedUser("member3", { role: "member" });
    const db = await asUser("member3");
    await assertFails(
      db.collection("users").doc("member3").update({
        "profile.notifications.push": grid().push,
        role: "admin",
      }),
    );
  });

  it("cannot carry ANY admin-set sibling along with a preference save", async () => {
    // The grid is the most-written field on the user doc, so it is the natural
    // carrier for a second field somebody hopes nobody is looking at. Every
    // pinned sibling is tried against the same otherwise-legitimate write.
    await seedUser("member7", {
      role: "member",
      profile: { preferredName: "Robin", universityEmail: "ab@nottingham.ac.uk" },
      email: "robin@example.com",
      policyVersion: "v4",
    });
    const db = await asUser("member7");
    const smuggled = {
      tracks: ["technical"],
      permissions: { approveNewsletter: true },
      suRecognised: true,
      admissionsReviewer: true,
      paidMembershipYears: ["2026"],
      email: "attacker@example.com",
      policyVersion: "v99",
      "profile.uniEmailVerifiedAt": new Date(),
    };
    for (const [field, value] of Object.entries(smuggled)) {
      await assertFails(
        db
          .collection("users")
          .doc("member7")
          .update({ "profile.notifications.push.tasks": false, [field]: value }),
      );
    }
  });

  it("cannot be written onto somebody else's document", async () => {
    await seedUser("member4", { role: "member" });
    await seedUser("victim", { role: "member" });
    const db = await asUser("member4");
    await assertFails(
      db.collection("users").doc("victim").update({ "profile.notifications.push": grid().push }),
    );
  });
});

describe("the absence a leaf write depends on", () => {
  it("no keys().hasOnly() is imposed over profile or notifications", () => {
    // Stated against the source, not only through its consequences: the tests
    // above would go red for this AND for a dozen unrelated reasons, and a
    // reader tightening the users rule needs to be told what they broke.
    const users = RULES.slice(RULES.indexOf("match /users/{uid}"));
    const rule = users.slice(0, users.indexOf("allow delete:"));
    for (const forbidden of [
      "profile.keys().hasOnly",
      "notifications.keys().hasOnly",
      "get('profile', {}).keys().hasOnly",
    ]) {
      assert.ok(
        !rule.includes(forbidden),
        `firestore.rules now imposes ${forbidden}. Every cell of the ` +
          "notification grid saves as its own dotted-path write, so a key " +
          "whitelist over profile or notifications silently breaks the /profile " +
          "switches. Pin the fields you meant to pin instead.",
      );
    }
  });

  it("the size cap still counts notifications as ONE profile key", () => {
    assert.ok(
      RULES.includes("request.resource.data.profile.size() <= 30"),
      "smallEnough() must still cap profile by KEY COUNT: the grid grows the " +
        "nested map, not the number of profile keys, and a cap that counted " +
        "leaves would fail a member for owning preferences.",
    );
  });
});

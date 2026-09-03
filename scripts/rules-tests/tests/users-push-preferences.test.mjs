/**
 * Rules tests for `users.profile.notifications.push` (V3 W3 PR32).
 *
 * ## Why this file exists when the rules did not change
 *
 * The push switches save on toggle, client-direct, under the
 * `profile.notifications.push` field path. That works today only because the
 * users self-update rule pins named FIELDS (`role`, `tracks`, `permissions`,
 * `suRecognised`, `admissionsReviewer`, `email`, the consent pair, the uni
 * email) and has no `keys().hasOnly()` over `profile`, so a member may write
 * any profile subfield the pins do not name.
 *
 * That is a load-bearing property of a file nobody edits for this feature,
 * which is exactly the kind of thing that gets tightened later by somebody
 * closing an unrelated hole. If a `hasOnly` is ever added to `profile` or to
 * `notifications` without listing `push`, the switches stop saving with a
 * permission error and nothing else in the suite notices. These two writes
 * are the alarm.
 *
 * The last two cases are the other half: the write is a member's own
 * preference, so it must not become a hole. Writing it may not carry a role
 * change, and it may not be aimed at somebody else's document.
 *
 * ## Mutation check (restore bit-exact afterwards)
 *
 *  1. Add `&& request.resource.data.profile.keys().hasOnly(['preferredName'])`
 *     to the users self-update rule -> the two save tests go red.
 *  2. Delete `request.resource.data.role == resource.data.role` from the
 *     self-update branch -> the role-smuggling test goes red.
 */
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

describe("a member owns their push switches", () => {
  it("can write the push map on their own document", async () => {
    await seedUser("member1", { role: "member" });
    const db = await asUser("member1");
    await assertSucceeds(
      db.collection("users").doc("member1").update({
        "profile.notifications.push": { tasks: false, courseDecisions: true },
      }),
    );
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
          categories: { newsletter: true, events: false, courses: false },
        },
      },
    });
    const db = await asUser("member2");
    await assertSucceeds(
      db
        .collection("users")
        .doc("member2")
        .update({
          "profile.notifications": {
            channels: { gmail: true, uniEmail: false },
            categories: { newsletter: true, events: false, courses: false },
            push: { tasks: true, courseDecisions: false },
          },
        }),
    );
  });

  it("cannot smuggle a role change alongside it", async () => {
    await seedUser("member3", { role: "member" });
    const db = await asUser("member3");
    await assertFails(
      db.collection("users").doc("member3").update({
        "profile.notifications.push": { tasks: true, courseDecisions: true },
        role: "admin",
      }),
    );
  });

  it("cannot be written onto somebody else's document", async () => {
    await seedUser("member4", { role: "member" });
    await seedUser("victim", { role: "member" });
    const db = await asUser("member4");
    await assertFails(
      db.collection("users").doc("victim").update({
        "profile.notifications.push": { tasks: false, courseDecisions: false },
      }),
    );
  });
});

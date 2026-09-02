/**
 * Rules tests for `users.admissionsReviewer` (V3 W1 PR8).
 *
 * The field is a SERVER-OWNED denormalisation of "this account is a reviewer
 * or the final decider on some admission round". It exists so the Admissions
 * entry in the sidebar can ride the auth snapshot, which is a live listener on
 * the caller's own user document, instead of costing an `admissionRounds`
 * query on every authed navigation for every user.
 *
 * That makes it exactly the class of field `tracks`, `permissions`,
 * `suRecognised` and `paidMembershipYears` already sit in: written by one
 * route, read by the UI, and pinned in rules on both the create and the
 * self-update path. Only the create clause is not optional-looking, so it is
 * worth stating what each half buys:
 *
 *  - CREATE: a brand-new account that could seed `admissionsReviewer: true`
 *    would draw itself the Admissions nav entry the moment it registered. The
 *    round's own `reviewerUids` is still what grants access to applications,
 *    so this is a link rather than a leak, but it is a link into a staff
 *    surface offered by a doc the subject wrote.
 *  - UPDATE: a member who could SET it grants themselves that link; a member
 *    who could CLEAR it silently drops themselves off the surface they were
 *    appointed to, and the round array that actually decides would then
 *    disagree with the only signal the UI has.
 *
 * ## Mutation check (each restored bit-exact afterwards)
 *
 *  1. Delete `&& !('admissionsReviewer' in request.resource.data)` from the
 *     create rule -> the create test goes red, the rest stay green.
 *  2. Delete the `get('admissionsReviewer', false)` pin from the self-update
 *     branch -> both self-update tests go red.
 *  3. Change the pin's default from `false` to `true` -> the absent-vs-absent
 *     test goes red, which is the case every ordinary profile save hits.
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
  await getTestEnv("users-admissions-reviewer");
});
after(cleanup);
afterEach(clearData);

describe("users.admissionsReviewer is server-owned", () => {
  it("cannot be seeded on a self-created user document", async () => {
    const db = await asUser("newbie");
    await assertFails(
      db.collection("users").doc("newbie").set({
        uid: "newbie",
        email: "newbie@example.com",
        displayName: "New Bie",
        role: "pending",
        admissionsReviewer: true,
        createdAt: new Date(),
      }),
    );
  });

  it("still lets an ordinary registration through", async () => {
    // The control. A create rule that refused everything would pass the test
    // above while breaking sign-up, which is the failure mode a pin like this
    // has to be checked against.
    const db = await asUser("newbie2");
    await assertSucceeds(
      db.collection("users").doc("newbie2").set({
        uid: "newbie2",
        email: "newbie2@example.com",
        displayName: "New Bie",
        role: "pending",
        createdAt: new Date(),
      }),
    );
  });

  it("cannot be self-granted by a member", async () => {
    await seedUser("member1", { role: "member" });
    const db = await asUser("member1");
    await assertFails(
      db.collection("users").doc("member1").update({ admissionsReviewer: true }),
    );
  });

  it("cannot be self-granted by an SU-recognised committee member either", async () => {
    // The people who ARE eligible to be appointed are the sharpest case: being
    // appointable is not being appointed, and the roles route is what decides.
    await seedUser("sucom", { role: "committee", suRecognised: true });
    const db = await asUser("sucom");
    await assertFails(
      db.collection("users").doc("sucom").update({ admissionsReviewer: true }),
    );
  });

  it("cannot be cleared by the reviewer it was granted to", async () => {
    await seedUser("reviewer1", {
      role: "committee",
      suRecognised: true,
      admissionsReviewer: true,
    });
    const db = await asUser("reviewer1");
    await assertFails(
      db.collection("users").doc("reviewer1").update({ admissionsReviewer: false }),
    );
  });

  it("does not block an ordinary profile save when it is absent on both sides", async () => {
    // The absent-vs-absent case, which is every member who has never been
    // appointed: without the `false` default on both sides of the pin this is
    // the write that would start failing for everybody.
    await seedUser("member2", { role: "member" });
    const db = await asUser("member2");
    await assertSucceeds(
      db.collection("users").doc("member2").update({ title: "Reading group lead" }),
    );
  });

  it("does not block a reviewer's own profile save when it is unchanged", async () => {
    await seedUser("reviewer2", {
      role: "committee",
      suRecognised: true,
      admissionsReviewer: true,
    });
    const db = await asUser("reviewer2");
    await assertSucceeds(
      db.collection("users").doc("reviewer2").update({ bio: "Reviews the autumn round." }),
    );
  });

  it("is settable by an admin, the fallback the roles route's write is modelled on", async () => {
    await seedUser("admin1", { role: "admin" });
    await seedUser("committee1", { role: "committee", suRecognised: true });
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("users").doc("committee1").update({ admissionsReviewer: true }),
    );
  });
});

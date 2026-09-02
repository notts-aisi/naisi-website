/**
 * The admin permissions editor writes the WHOLE `permissions` map, so any key
 * it forgets is a permission the next edit silently revokes.
 *
 * That is not hypothetical. `setPermissions` shipped rebuilding a four-key
 * object (the newsletter and event pair) while `UserPermissions` had grown to
 * six: an admin toggling somebody's newsletter permission destroyed their
 * `draftCourse` and `approveCourse` grants, with no warning and no way to
 * notice short of re-reading the Firestore document.
 *
 * The write is a client-direct `updateDoc`, so there is no route to test and
 * no emulator seam either: the mutation and the type live in two files and the
 * only thing that can hold them together is a source pin. Like
 * `e2e-no-privilege-grants.test.mjs`, this is a deliberate speed bump rather
 * than a proof, and it is aimed at the specific mistake that has already been
 * made once.
 *
 * WHEN THIS FAILS: a key was added to `UserPermissions` and not to
 * `PERMISSION_KEYS`, or the other way round. Add it to both, then give it a
 * control in `MemberItem` so it can actually be granted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

const USERS = src("lib", "firestore", "users.ts");
const MUTATIONS = src("features", "admin", "adminMutations.ts");
const MEMBER_ITEM = src("features", "admin", "MemberItem.tsx");
const AUTH_PROVIDER = src("auth", "AuthProvider.tsx");

/** Every key the permissions model declares, read off the type itself. */
function declaredPermissionKeys() {
  const block = /export type UserPermissions = \{([\s\S]*?)\};/.exec(USERS);
  assert.ok(block, "UserPermissions is no longer a type literal");
  return [...block[1].matchAll(/^\s*(\w+)\??:\s*boolean/gm)].map((m) => m[1]);
}

test("GUARD: UserPermissions still declares the six known permissions", () => {
  assert.deepEqual(declaredPermissionKeys().sort(), [
    "approveCourse",
    "approveEvent",
    "approveNewsletter",
    "draftCourse",
    "draftEvent",
    "draftNewsletter",
  ]);
});

test("GUARD: setPermissions writes every declared key, as a real boolean", () => {
  const keys = declaredPermissionKeys();

  // The list the write iterates. Pinned to the type above, so growing one
  // without the other fails here rather than in production.
  const listed = /export const PERMISSION_KEYS = \[([\s\S]*?)\] as const/.exec(MUTATIONS);
  assert.ok(listed, "PERMISSION_KEYS is no longer an array literal");
  const written = [...listed[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    written.slice().sort(),
    keys.slice().sort(),
    "PERMISSION_KEYS and UserPermissions have drifted apart",
  );

  // `satisfies` makes TypeScript reject a typo'd key, and the loop is what
  // makes the write exhaustive rather than a hand-listed object literal that
  // can fall behind again.
  assert.match(
    MUTATIONS,
    /as const satisfies readonly \(keyof UserPermissions\)\[\]/,
    "PERMISSION_KEYS is no longer checked against UserPermissions",
  );
  assert.match(
    MUTATIONS,
    /for \(const key of PERMISSION_KEYS\) clean\[key\] = Boolean\(permissions\[key\]\);/,
    "setPermissions no longer writes every key coerced to a boolean",
  );
  // Firestore refuses `undefined`, and a whole-map replacement means a missing
  // key is a revocation. Both are why every value goes through Boolean().
  assert.match(MUTATIONS, /permissions: clean/);
});

test("GUARD: every permission is grantable in the UI and readable on the client", () => {
  const keys = declaredPermissionKeys();
  for (const key of keys) {
    assert.ok(
      MEMBER_ITEM.includes(`"${key}"`),
      `${key} has no control on the admin Members row, so it can only be set by hand in Firestore`,
    );
    assert.ok(
      AUTH_PROVIDER.includes(`${key}: Boolean(raw.${key})`),
      `${key} is missing from the client auth snapshot, so useAuth().permissions cannot see it`,
    );
  }
});

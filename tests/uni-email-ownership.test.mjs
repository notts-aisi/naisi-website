/**
 * Verifying a university email credits the account that PROVES it, never a
 * bystander who clicks a link.
 *
 * WHY. `POST /api/verify-email/send` lets any signed-in caller mail a
 * NAISI-signed "verify your university email" link to any @nottingham.ac.uk
 * address, and the `emailVerifications` token binds to THAT CALLER's uid. Until
 * 8 September 2026 the confirmation (the click) credited the token's stored
 * `authUid` no matter who clicked, so a caller could set their own
 * `profile.universityEmail` to a victim's address, trigger the send, and — on
 * the victim clicking a genuine link addressed to them by name — squat the
 * victim's university address on the caller's account (the victim is then
 * refused with "already linked to another account"). Uni-email verification is
 * an attribute proof on an already-signed-in account, so the fix binds the
 * confirmation to the caller's own session: `confirmUniEmailVerification` now
 * takes the confirming caller's uid and refuses a token minted for a different
 * account before it flips `verifiedAt` or stamps the user doc. This guard:
 *
 *  1. EXECUTES `confirmUniEmailVerification` against a fake Firestore as the
 *     token's own account (verifies), as a different account (403, no write),
 *     and signed out (401, no write).
 *  2. THE TREE: every write of the trusted `profile.uniEmailVerifiedAt` flag in
 *     `src` is registered with whether it STAMPS (server-side, Admin SDK,
 *     bypassing the rules, so it must bind to a proven owner) or CLEARS it,
 *     both directions. A new stamp site fails here until it is declared.
 *  3. The two call sites of the helper pass the caller's own session uid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Fake Firestore: collection().doc().get(), and a batch with update()/commit().
// ---------------------------------------------------------------------------
function makeDb(store) {
  const data = store;
  const snapOf = (collection, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(data[collection] ?? {}, id),
    data: () => (data[collection] ?? {})[id],
    ref: { __collection: collection, __id: id },
  });
  const write = (ref, patch) => {
    data[ref.__collection] ??= {};
    data[ref.__collection][ref.__id] = { ...(data[ref.__collection][ref.__id] ?? {}), ...patch };
  };
  return {
    data,
    collection: (name) => ({
      doc: (id) => ({
        __collection: name,
        __id: id,
        get: async () => snapOf(name, id),
      }),
    }),
    batch() {
      const ops = [];
      return {
        update: (ref, patch) => ops.push(() => write(ref, patch)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
}

const { loadTs } = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    [
      "firebase-admin/firestore",
      `export const Timestamp = { now: () => ({ toMillis: () => ${NOW} }) };`,
    ],
    ["@/lib/signedTokens", "export const verifyToken = () => ({ s: 'verify-uni-email', v: 'tok1' });"],
    [
      "@/lib/firestore/uniEmailOwnership",
      "export const findVerifiedUniEmailOwner = async () => globalThis.__owner ?? null;",
    ],
  ]),
});

const { confirmUniEmailVerification } = await loadTs("lib/email/confirmUniEmailVerification.ts");

const UNI = "someone@nottingham.ac.uk";
const AUTH_UID = "owner-uid";

function seed() {
  return {
    emailVerifications: {
      tok1: {
        authUid: AUTH_UID,
        email: UNI,
        verifiedAt: null,
        expiresAt: { toMillis: () => NOW + 100_000, toDate: () => new Date(NOW + 100_000) },
      },
    },
    users: {
      [AUTH_UID]: { profile: { universityEmail: UNI } },
    },
  };
}

const tokenVerifiedAt = (db) => db.data.emailVerifications.tok1.verifiedAt;
const userStamp = (db) => db.data.users[AUTH_UID]["profile.uniEmailVerifiedAt"];

describe("confirmUniEmailVerification ownership binding", () => {
  test("the token's own account verifies, flipping the token and stamping the user doc", async (t) => {
    t.mock.method(console, "log", () => {});
    globalThis.__owner = null;
    const db = makeDb(seed());
    const res = await confirmUniEmailVerification(db, "signed", AUTH_UID);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(tokenVerifiedAt(db), "the token's verifiedAt was not set");
    assert.ok(userStamp(db), "the user doc's uniEmailVerifiedAt was not stamped");
  });

  test("a DIFFERENT account is refused (403) and nothing is written — the squat is dead", async (t) => {
    t.mock.method(console, "log", () => {});
    globalThis.__owner = null;
    const db = makeDb(seed());
    const res = await confirmUniEmailVerification(db, "signed", "attacker-uid");
    assert.equal(res.ok, false);
    assert.equal(res.status, 403, JSON.stringify(res));
    assert.equal(tokenVerifiedAt(db), null, "a stranger's confirmation flipped the token");
    assert.equal(userStamp(db), undefined, "a stranger's confirmation stamped the owner's account");
  });

  test("a signed-out caller is refused (401) and nothing is written", async (t) => {
    t.mock.method(console, "log", () => {});
    globalThis.__owner = null;
    const db = makeDb(seed());
    const res = await confirmUniEmailVerification(db, "signed", null);
    assert.equal(res.ok, false);
    assert.equal(res.status, 401, JSON.stringify(res));
    assert.equal(tokenVerifiedAt(db), null);
    assert.equal(userStamp(db), undefined);
  });
});

// ---------------------------------------------------------------------------
// The tree: every writer of the trusted uniEmailVerifiedAt flag.
// ---------------------------------------------------------------------------
/**
 * Files that write `profile.uniEmailVerifiedAt` via the dotted field path, and
 * what each does. A STAMP writes a truthy value and, because it uses the Admin
 * SDK (which bypasses firestore.rules), MUST bind the write to a proven owner —
 * these are the paths the squat would travel. A CLEAR removes the flag and is
 * safe anywhere (the rules already permit a self-clear). Both directions.
 */
const STAMP_SITES = {
  "src/lib/email/confirmUniEmailVerification.ts": {
    kind: "stamp",
    reason:
      "The magic-link click path. Binds the stamp to callerUid === token.authUid AND profile.universityEmail === the verified address, so only the account that proved the inbox is credited.",
  },
  "src/lib/firestore/uniEmailOwnership.ts": {
    kind: "stamp",
    reason:
      "stampVerifiedUniEmailForUser, the reconcile path. Binds the stamp to a VERIFIED emailVerifications token for (uid, uniEmail) and re-checks no other account owns the address before writing.",
  },
  "src/features/profile/ProfileForm.tsx": {
    kind: "clear",
    reason:
      "The profile form clears the stamp with deleteField() whenever the member changes their university email; a client write can only clear, never set (firestore.rules).",
  },
};

const LITERAL = /"profile\.uniEmailVerifiedAt"/;

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

describe("the tree: every writer of profile.uniEmailVerifiedAt", () => {
  test("every write site is registered, both directions", () => {
    const found = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      if (LITERAL.test(codeOf(file))) found.push(relative(REPO_ROOT, file).split("\\").join("/"));
    }
    const unregistered = found.filter((f) => !(f in STAMP_SITES));
    assert.deepEqual(
      unregistered,
      [],
      "These files write the trusted profile.uniEmailVerifiedAt flag. Register each " +
        "as a stamp (bound to a proven owner) or a clear, or the squat this guard " +
        "closes can travel through it unreviewed.",
    );
    const stale = Object.keys(STAMP_SITES).filter((f) => !found.includes(f));
    assert.deepEqual(stale, [], "These registered write sites no longer write the flag: remove them.");
    for (const [file, { kind, reason }] of Object.entries(STAMP_SITES)) {
      assert.ok(reason.trim().length >= 40, `${file}: the reason is a placeholder.`);
      assert.ok(["stamp", "clear"].includes(kind), `${file}: kind must be stamp or clear.`);
    }
  });

  test("a CLEAR site uses deleteField(), and a STAMP site is server-side", () => {
    for (const [file, { kind }] of Object.entries(STAMP_SITES)) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      if (kind === "clear") {
        assert.match(
          src,
          /deleteField\(\)/,
          `${file} is registered as a CLEAR but does not call deleteField().`,
        );
      } else {
        assert.match(
          src,
          /import "server-only"/,
          `${file} is registered as a STAMP but is not server-only; a stamp is an ` +
            "Admin-SDK write that bypasses the rules and must never run client-side.",
        );
      }
    }
  });
});

describe("the two call sites resolve and pass the caller's own uid", () => {
  for (const file of [
    "src/app/api/verify-email/confirm/route.ts",
    "src/app/verify-email/[tokenId]/page.tsx",
  ]) {
    test(`${file} passes a session uid into confirmUniEmailVerification`, () => {
      const src = codeOf(join(REPO_ROOT, file));
      assert.match(src, /getSessionUid\(\)/, `${file} must resolve the caller's session uid.`);
      assert.match(
        src,
        /confirmUniEmailVerification\([^)]*session[^)]*\)/,
        `${file} must pass the caller's uid into confirmUniEmailVerification, or the ` +
          "ownership binding is bypassed at this call site.",
      );
    });
  }
});

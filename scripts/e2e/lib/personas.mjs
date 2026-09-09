/**
 * THE ONE FILE IN THIS HARNESS THAT WRITES A ROLE ABOVE `pending`, AND IT
 * CAN ONLY WRITE IT TO A FIRESTORE EMULATOR.
 *
 * The harness's second safety property is that it never grants a privilege
 * on the dev project (scripts/e2e/README.md, "Safety properties"), and
 * `tests/e2e-no-privilege-grants.test.mjs` fences every other file under
 * scripts/e2e for the spellings of one. The per-persona route battery
 * (`tests/persona-route-gates.test.mjs`) needs a member, a committee member,
 * an SU-recognised one, an admin and every permission holder, so it needs
 * exactly what the fence forbids. The choice made here, and defended in the
 * pull request that added it, was NOT to loosen the fence for a file that
 * writes elevated roles to dev under a namespace check. It was to keep the
 * property literally true:
 *
 *   ELEVATED PERSONAS EXIST ONLY IN A FIRESTORE EMULATOR. Their Auth accounts
 *   are ordinary harness accounts on the dev project, bare and disposable,
 *   with no `users` document there at all. Their roles live in an emulator
 *   that `scripts/e2e/run.mjs` starts for the run and kills after it, behind
 *   a second loopback server (`E2E_PERSONA_ORIGIN`) that is the same build as
 *   the main one pointed at that emulator through `FIRESTORE_EMULATOR_HOST`.
 *
 * So the dev project never holds an admin this harness made, a crashed run
 * leaves nothing privileged behind (the emulator dies with the process, and
 * the bare Auth accounts are swept like every other harness account), and
 * the battery can drive every route as every persona, mutating ones
 * included, because what it mutates is a throwaway.
 *
 * The property is enforced, not promised. `assertEmulator()` runs first in
 * every exported function and refuses unless `FIRESTORE_EMULATOR_HOST` names
 * a loopback host, so a process without the emulator variable cannot reach
 * the seed. This module makes the ACCOUNTS; the requests under test are the
 * battery's own and live in it, the way every other battery's do. The fence guard imports this module with the variable unset and
 * proves that refusal by calling it, and reads this file to check that every
 * exported function starts with the assertion. The account namespace check
 * every other uid-taking helper carries is here as well, on the way in and
 * on the way out.
 */
import { getFirestore } from "firebase-admin/firestore";
import { adminApp, createHarnessUser, deleteHarnessUser, isHarnessAccount } from "./admin.mjs";
import { assertTarget } from "./env.mjs";
import { ACCEPTED_POLICY_VERSION } from "./firestore.mjs";
import { mintSessionCookie } from "./session.mjs";

/**
 * Every persona the battery knows, by the shape of its `users` document.
 * `anonymous` has no account and no cookie. The permission holders are plain
 * members with one key each, which is how the map is granted in the product.
 */
export const PERSONAS = {
  anonymous: null,
  pending: { role: "pending" },
  rejected: { role: "rejected" },
  member: { role: "member" },
  committee: { role: "committee", suRecognised: false },
  suCommittee: { role: "committee", suRecognised: true },
  admin: { role: "admin" },
  draftNewsletter: { role: "member", permissions: { draftNewsletter: true } },
  approveNewsletter: { role: "member", permissions: { approveNewsletter: true } },
  draftEvent: { role: "member", permissions: { draftEvent: true } },
  approveEvent: { role: "member", permissions: { approveEvent: true } },
  draftCourse: { role: "member", permissions: { draftCourse: true } },
  approveCourse: { role: "member", permissions: { approveCourse: true } },
  manageMembership: { role: "member", permissions: { manageMembership: true } },
  circulateWorksheet: { role: "member", permissions: { circulateWorksheet: true } },
};

export const PERSONA_NAMES = Object.keys(PERSONAS);

const LOOPBACK_EMULATOR = /^(127\.0\.0\.1|localhost):\d{2,5}$/;

/**
 * Refuses unless Firestore is the emulator. Called first by everything here.
 */
export function assertEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!LOOPBACK_EMULATOR.test(host)) {
    throw new Error(
      `REFUSING: FIRESTORE_EMULATOR_HOST is ${JSON.stringify(host)}, not a loopback emulator. ` +
        "Persona documents carry roles above pending and may only ever be written to an " +
        "emulator scripts/e2e/run.mjs started for this run.",
    );
  }
  return host;
}

/** The persona server's origin, asserted against the harness allowlist. */
export function personaOrigin() {
  assertEmulator();
  const origin = process.env.E2E_PERSONA_ORIGIN;
  if (!origin) throw new Error("E2E_PERSONA_ORIGIN is not set; scripts/e2e/run.mjs sets it.");
  return assertTarget(origin);
}

function emulatorDb() {
  assertEmulator();
  return getFirestore(adminApp());
}

/**
 * The `users` document for a persona, in the emulator. Everything the session
 * builder and the authed layout read: role, the SU flag, the permissions map,
 * and the current policy version so the re-consent gate lets it through.
 */
function personaDocument(uid, email, name) {
  const shape = PERSONAS[name];
  return {
    uid,
    email,
    displayName: `E2E ${name}`,
    role: shape.role,
    ...(shape.suRecognised === undefined ? {} : { suRecognised: shape.suRecognised }),
    ...(shape.permissions ? { permissions: shape.permissions } : {}),
    showOnMembers: false,
    policyVersion: ACCEPTED_POLICY_VERSION,
    policyAgreedAt: new Date(),
    createdAt: new Date(),
    profile: {
      preferredName: "E2E",
      status: "undergraduate",
      subject: "e2e",
      motivation: "automated persona fixture",
    },
  };
}

/**
 * Creates one persona: a bare harness Auth account on dev, its document in
 * the emulator, and a session cookie minted through the persona server.
 * `dispose()` removes both halves. `anonymous` yields no account and no
 * cookie.
 */
export async function withPersona(runId, name) {
  assertEmulator();
  if (!(name in PERSONAS)) throw new Error(`Unknown persona ${JSON.stringify(name)}`);
  if (PERSONAS[name] === null) {
    return { name, uid: null, email: null, cookie: null, refresh: async () => null, dispose: async () => {} };
  }
  const origin = personaOrigin();
  // No separator: the harness address pattern is `e2e-[a-z0-9]+@e2e.invalid`.
  const { uid, email } = await createHarnessUser(`${runId}${name.toLowerCase()}`);
  if (!isHarnessAccount(email)) throw new Error(`Refusing to seed a non-harness account ${email}`);
  let cookie = null;
  try {
    await emulatorDb().collection("users").doc(uid).set(personaDocument(uid, email, name));
    cookie = await mintSessionCookie(uid, origin);
  } catch (err) {
    await removePersona(uid).catch(() => {});
    throw err;
  }
  const persona = {
    name,
    uid,
    email,
    cookie,
    /** A fresh cookie after a route revoked the last one. */
    refresh: async () => {
      persona.cookie = await mintSessionCookie(uid, origin);
      return persona.cookie;
    },
    dispose: () => removePersona(uid),
  };
  return persona;
}

/** Removes a persona's emulator document and its Auth account, namespace-checked. */
async function removePersona(uid) {
  assertEmulator();
  const result = await deleteHarnessUser(uid); // refuses a non-harness account
  await emulatorDb().collection("users").doc(uid).delete();
  return result;
}

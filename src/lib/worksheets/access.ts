import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import type { Role, SessionUser } from "@/lib/firebase/session";
import {
  CIRCULATION_LIMITS,
  CIRCULATIONS_COLLECTION,
  normalizeCirculation,
  type CirculationDoc,
} from "@/lib/firestore/circulations";
import { canCirculateWorksheet } from "@/lib/firestore/users";

/**
 * WHO MAY DO WHAT TO A CIRCULATION, in one place.
 *
 * There are five doors onto the same document (create, add recipients, submit,
 * upload, and everything wave 2 adds: return, unfreeze, export, aggregate,
 * close), and they ask two questions between them: "may this person send a
 * worksheet at all" and "is this person staff of THIS circulation". Written out
 * once per route those two predicates drift, and the drift is silent: a route
 * that tests the raw `permissions.circulateWorksheet` key forgets that admins
 * hold every key implicitly, and one that tests `senderUid == uid` forgets the
 * worksheet's author and the named reviewers, who are staff by the contract.
 *
 * `assertNotImpersonating()` is deliberately NOT called from here. It reads
 * cookies and builds a `NextResponse`, so a module every route imports would
 * drag `next/server` into places that have no request; and a guard that lives
 * inside a helper is a guard `tests/impersonation-guard.test.mjs` cannot see,
 * because that scan looks for the call at the TOP of each handler. Every
 * mutating route in this tree calls it itself, first, before anything here.
 */

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches a route as a real
 * path separator and `doc()` would throw a 500 out of a member action. Same
 * guard as `registerAccess.ts` and the course submit route, deliberately
 * identical so every gate in the app agrees about what counts as addressable.
 */
export function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * May this person put a worksheet in front of named people at all?
 *
 * Delegates to `canCirculateWorksheet` rather than reading the key here: that
 * helper is where the admin-implicit half is written down, and the whole reason
 * it exists is so the half is never remembered in one place and dropped in
 * another. This wrapper is the name the routes use, so the routes read as
 * `canCirculate(actor)` and nobody has to remember which collection's helper
 * module the predicate came from.
 */
export function canCirculate(user: SessionUser): boolean {
  return canCirculateWorksheet(user);
}

/**
 * Load one circulation, normalised, or null when it is not there.
 *
 * The id is NOT validated here: a caller that has not run `isAddressableId`
 * would already have thrown inside `doc()`, and a helper that quietly returned
 * null for a malformed id would hide the caller's missing guard behind an
 * honest-looking 404. Guard at the door, load in here.
 */
export async function loadCirculation(
  db: Firestore,
  circulationId: string,
): Promise<CirculationDoc | null> {
  const snap = await db.collection(CIRCULATIONS_COLLECTION).doc(circulationId).get();
  if (!snap.exists) return null;
  return normalizeCirculation(snap.id, snap.data() ?? {});
}

/**
 * Staff of THIS circulation: the sender, the worksheet's author, the named
 * reviewers, or an admin.
 *
 * It reads `staffUids` and nothing else because that array is the one thing
 * every Firestore rule and every staff list query keys off (see
 * `circulationStaffUids`). A predicate here that reconstructed the set from
 * `senderUid`, `authorUid` and `reviewerUids` would be a second definition of
 * staff, and the day the two disagree the rules win and the route looks broken.
 *
 * Admins are resource-independent, matching `isAdmin()` in `firestore.rules`.
 */
export function isCirculationStaff(
  circulation: Pick<CirculationDoc, "staffUids">,
  user: Pick<SessionUser, "uid" | "role">,
): boolean {
  return user.role === "admin" || circulation.staffUids.includes(user.uid);
}

/**
 * The recipient list off a request body, or the sentence to answer 400 with.
 *
 * It lives beside the gates rather than in either route because BOTH the
 * circulate route and the add-recipients route read the same field and have to
 * agree about the cap: `CIRCULATION_LIMITS.maxRecipientsPerRequest` is a
 * budget (a response document, a task and an email each), and a second copy of
 * this parser is how one of the two doors ends up without it.
 *
 * OVER THE CAP IS A REFUSAL, NOT A TRUNCATION. Silently sending to the first
 * hundred of a hundred and twenty would leave twenty people the sender
 * believes were told, which is a worse failure than being asked to do it in
 * two goes. Duplicates and blanks ARE dropped rather than refused: they are
 * artefacts of a picker, not a mistake anybody made.
 */
export function parseRecipientUids(
  raw: unknown,
): { uids: string[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "Send `recipientUids` as an array of member ids." };
  }
  const uids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) continue;
    if (!uids.includes(entry)) uids.push(entry);
  }
  if (uids.length === 0) {
    return { error: "Pick at least one person to send this to." };
  }
  if (uids.length > CIRCULATION_LIMITS.maxRecipientsPerRequest) {
    return {
      error: `You can add ${CIRCULATION_LIMITS.maxRecipientsPerRequest} people at a time. That was ${uids.length}. Send the rest in a second go.`,
    };
  }
  return { uids };
}

/**
 * WHO MAY BE SENT A WORKSHEET, and it is a POLICY LINE rather than a property
 * of the model.
 *
 * Nothing in the data model requires it: a recipient is a response document
 * and a task, whatever their role (`docs/worksheets.md > Vocabulary` says so
 * in as many words, because a course exercise will want enrolled members).
 * v1 restricts it to the committee and admins because that is who the picker
 * offers, and because a worksheet arriving unannounced in a plain member's My
 * Work is a thing to decide on purpose rather than to discover. Widening it is
 * this function plus the recipients route's query, and nothing else.
 */
export function isEligibleRecipient(role: Role | null): boolean {
  return role === "committee" || role === "admin";
}

/**
 * The stored role of each uid, or null where there is no user document.
 *
 * ADDRESSED READS, never a query: the uids come from a request body, so a
 * query over them would be a way to ask the users collection questions. One
 * `getAll` costs one round trip for the whole list, and a uid nobody owns
 * comes back as null rather than as an error, because "you named somebody who
 * does not exist" is a skip and not a failure.
 */
export async function readRoles(
  db: Firestore,
  uids: string[],
): Promise<Map<string, Role | null>> {
  const out = new Map<string, Role | null>();
  const wanted = uids.filter((uid) => typeof uid === "string" && uid.length > 0);
  if (wanted.length === 0) return out;
  const snaps = await db.getAll(...wanted.map((uid) => db.collection("users").doc(uid)));
  for (const snap of snaps) {
    const role = snap.exists ? (snap.data() ?? {}).role : null;
    out.set(snap.id, typeof role === "string" ? (role as Role) : null);
  }
  return out;
}

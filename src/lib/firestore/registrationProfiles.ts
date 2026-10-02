import "server-only";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Whether an account has a profile behind it: a `users/{uid}` document (a
 * member, whatever its role) or a `collaborators` document carrying its uid.
 *
 * THIS IS THE FACT THE SIGNUP TRACKER REPORTS AGAINST. A registration row
 * carries a `profileComplete` flag, and the flag is a mirror: the browser
 * writes the profile client-direct and then tells the server it has, in a
 * request that a closed tab or a dropped connection can lose. A mirror is fine
 * for counting and wrong for a claim an admin acts on, so the two places that
 * make the claim both come here and look:
 *
 *  - the admin list (`/api/admin/registrations`) asks for every row it is about
 *    to show, so "Completed" on the screen means a document was there when the
 *    page loaded;
 *  - the flip itself (`/api/register/profile-complete`) asks before it sets the
 *    flag, so the flag can trail the document and can never run ahead of it.
 *
 * Reads only, and only existence: the member lookup asks for one field, so no
 * profile is carried into a route that has no use for it.
 */

const USERS = "users";
const COLLABORATORS = "collaborators";

/** Firestore's ceiling on the values in one `in` filter. */
const IN_FILTER_LIMIT = 30;

/** The subset of `uids` that have a member or collaborator profile. */
export async function uidsWithProfile(db: Firestore, uids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const wanted = [...new Set(uids.filter((uid) => typeof uid === "string" && uid.length > 0))];
  if (wanted.length === 0) return found;

  const members = await db.getAll(
    ...wanted.map((uid) => db.collection(USERS).doc(uid)),
    { fieldMask: ["uid"] },
  );
  for (const snap of members) {
    if (snap.exists) found.add(snap.id);
  }

  // A collaborator document is named `<name-slug>__<uid>`, so it is found by
  // its `uid` field rather than by id. Only the accounts with no member
  // profile are asked about.
  const rest = wanted.filter((uid) => !found.has(uid));
  for (let i = 0; i < rest.length; i += IN_FILTER_LIMIT) {
    const chunk = rest.slice(i, i + IN_FILTER_LIMIT);
    const snap = await db.collection(COLLABORATORS).where("uid", "in", chunk).select("uid").get();
    for (const doc of snap.docs) {
      const uid: unknown = doc.get("uid");
      if (typeof uid === "string") found.add(uid);
    }
  }
  return found;
}

/** Does this one account have a member or collaborator profile? */
export async function hasProfile(db: Firestore, uid: string): Promise<boolean> {
  return (await uidsWithProfile(db, [uid])).has(uid);
}

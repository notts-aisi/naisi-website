import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { canCirculate } from "@/lib/worksheets/access";

/**
 * The people a worksheet can be sent to, for the Circulate dialog's picker.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ────────────────────────────────────────────
 * `firestore.rules` locks the `users` collection to SU-recognised committee,
 * admins and each member's own document, and `circulateWorksheet` is
 * deliberately NOT an SU-recognised grant: a non-SU committee member, or a
 * plain member an admin has trusted with sending worksheets, holds the key and
 * cannot read a single user document. Without this route the picker would be
 * an empty list for exactly the people the key was invented for. So the key
 * stands in for the collection read, and the users rule is untouched
 * (docs/worksheets.md > Permissions, marked as a Decision there).
 *
 * ── WHAT IT WILL AND WILL NOT SAY ───────────────────────────────────────────
 * A name, a photo, a role and the SU flag. NO EMAIL ADDRESSES, no profile, no
 * course of study, and no way to ask about one particular person: the caller
 * sends no parameters, so this cannot be turned into a lookup service. The
 * wire type below has nowhere to put an address and none may be added; the
 * routes that need to reach these people resolve their own addresses
 * server-side and never hand them out.
 *
 * ── NOT MUTATING, SO NOT GUARDED ────────────────────────────────────────────
 * There is no `assertNotImpersonating()` here and there should not be: reading
 * what a member can see is precisely what view-as exists to do, and this GET
 * writes nothing. `tests/impersonation-guard.test.mjs` only requires the guard
 * on handlers that mutate, which is why this file needs no entry on its list.
 */

export type WorksheetRecipient = {
  uid: string;
  displayName: string;
  photoURL: string | null;
  role: string;
  /** Shown as a quiet tag in the picker; never a gate on being a recipient. */
  suRecognised: boolean;
};

/**
 * A ceiling on the roster read, well above any committee this society has had.
 * It exists so a corrupted `role` field on hundreds of documents cannot turn
 * one picker mount into an unbounded read, not because 200 is a meaningful
 * number of committee members.
 */
const MAX_ROSTER = 200;

/** Preferred name, then account name, then a neutral placeholder. Never an email. */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

export async function GET() {
  const actor = await getCurrentUser();
  // ONE refusal for "not signed in" and "not allowed", because the two are the
  // same answer to the same person: the picker is not for you. A 401 here
  // would tell an anonymous caller that this endpoint exists and is worth
  // getting a session for.
  if (!actor || !canCirculate(actor)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // Equality on ONE field (`in` over two values), so this needs no composite
  // index and no `orderBy`: the sort is done below, in memory, on a list that
  // is a committee long. Ordering in the query would also drop every document
  // missing the sort field, which is the repo-wide `orderBy` trap.
  const snap = await db
    .collection("users")
    .where("role", "in", ["committee", "admin"])
    .limit(MAX_ROSTER)
    .get();

  const members: WorksheetRecipient[] = snap.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      uid: doc.id,
      displayName: displayNameOf(data),
      photoURL: typeof data.photoURL === "string" ? data.photoURL : null,
      role: typeof data.role === "string" ? data.role : "member",
      suRecognised: data.suRecognised === true,
    };
  });
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return NextResponse.json({ members });
}

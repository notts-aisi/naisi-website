import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Roster lookup for the member-facing task views (/tasks, /dashboard).
 *
 * Plain members and non-SU-recognised committee cannot read the `users`
 * collection (firestore.rules locks it to SU committee, admins and self), so
 * they cannot resolve the names of the people they share tasks with. This
 * route fills that gap with the minimum needed: for the calling user it finds
 * every task they are a completer or reviewer on, and returns only
 * `{ uid, displayName, photoURL, role }` for the people on those tasks.
 *
 * Enumeration-safe: the caller cannot pass UIDs. The server derives the set
 * from the caller's own task memberships, so you only ever learn the names of
 * people already collaborating with you. No emails, no profile, no PII.
 */

export type RosterMember = {
  uid: string;
  displayName: string;
  photoURL: string | null;
  role: string;
};

export async function GET() {
  const session = await getCurrentUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Tasks the caller is on, as completer or reviewer. Two array-contains
  // queries, since Firestore can't OR across two array fields in one query.
  const [asCompleter, asReviewer] = await Promise.all([
    db.collection("tasks").where("completerUids", "array-contains", session.uid).get(),
    db.collection("tasks").where("reviewerUids", "array-contains", session.uid).get(),
  ]);

  // Always include the caller; resolve every collaborator on those tasks.
  const uids = new Set<string>([session.uid]);
  for (const snap of [asCompleter, asReviewer]) {
    for (const taskDoc of snap.docs) {
      const data = taskDoc.data();
      for (const field of ["completerUids", "reviewerUids"] as const) {
        const arr = data[field];
        if (Array.isArray(arr)) {
          for (const u of arr) if (typeof u === "string") uids.add(u);
        }
      }
      if (typeof data.creatorUid === "string") uids.add(data.creatorUid);
    }
  }

  const refs = [...uids].map((uid) => db.collection("users").doc(uid));
  const userDocs = refs.length ? await db.getAll(...refs) : [];

  const members: RosterMember[] = userDocs
    .filter((d) => d.exists)
    .map((d) => {
      const data = d.data() ?? {};
      const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
      const preferred = profile.preferredName;
      const display = data.displayName;
      const name =
        (typeof preferred === "string" && preferred.trim()) ||
        (typeof display === "string" && display.trim()) ||
        "NAISI member";
      return {
        uid: d.id,
        displayName: name,
        photoURL: typeof data.photoURL === "string" ? data.photoURL : null,
        role: typeof data.role === "string" ? data.role : "member",
      };
    });

  return NextResponse.json({ members });
}

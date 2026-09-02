import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { clearSessionCookieOnly, getSessionUid } from "@/lib/firebase/session";
import { deleteAccountCascade } from "@/lib/firestore/accountDeletion";
import { CURRENT_POLICY_VERSION } from "@/lib/legal/policies";

/**
 * Backs the re-consent gate. The signed-in user either ACCEPTS the updated
 * policies (we re-stamp their accepted version + timestamp on their own doc) or
 * DECLINES.
 *
 *  - accept → stamp { policyVersion: CURRENT_POLICY_VERSION, policyAgreedAt }.
 *  - delete → tear the account down via the shared cascade, but ONLY for
 *             collaborators and unfinished accounts, where the cascade is
 *             complete. A FINISHED member is refused (409): their content
 *             cascade (tasks / events / comments) isn't built, so declining
 *             members are signed out and asked to contact an admin instead
 *             (handled client-side). Mirrors /api/account/delete's scope guard.
 *
 * Always acts on the caller's OWN uid (from the session cookie) — no id is taken
 * from the client, so there's no IDOR surface.
 */
export async function POST(req: Request) {
  // Never inside a view-as session. The reason is the ACCEPT stamp, not the
  // decline branch: accepting is the one write on this site whose entire
  // value is that the person themselves made it, and a view-as session
  // records it on the member's own document as the member, so an admin could
  // stamp a consent that was never given and nothing afterwards could tell.
  // (The decline branch needs no protection from this guard. Impersonation
  // targets always have a users doc, so `isMember` is true and the delete is
  // refused with a 409 a few lines down regardless.) The gate in
  // (app)/layout.tsx skips the redirect during view-as for the same reason,
  // but an admin can still reach /re-consent by typing it, so the refusal
  // belongs here as well as there.
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "accept" && action !== "delete") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const uid = session.uid;
  // Resolve which kind of account this is. Members have a users doc; external
  // collaborators have a collaborators doc keyed by the `uid` field.
  const [userSnap, collabSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("collaborators").where("uid", "==", uid).limit(1).get(),
  ]);
  const isMember = userSnap.exists;
  const collabDoc = collabSnap.empty ? null : collabSnap.docs[0];

  if (action === "accept") {
    const stamp = {
      policyVersion: CURRENT_POLICY_VERSION,
      policyAgreedAt: FieldValue.serverTimestamp(),
    };
    try {
      if (isMember) {
        await db.collection("users").doc(uid).update(stamp);
      } else if (collabDoc) {
        await collabDoc.ref.update(stamp);
      } else {
        // No member or collaborator doc — nothing to stamp. Such accounts don't
        // reach the gate, so this is just defensive.
        return NextResponse.json({ error: "No account to update" }, { status: 400 });
      }
    } catch (err) {
      console.error("[reconsent] stamp failed:", uid, err);
      return NextResponse.json({ error: "Couldn't record your acceptance." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // action === "delete"
  // Finished members can't be self-deleted (no content cascade yet) — same scope
  // guard as /api/account/delete. The client shows "sign out + contact an admin"
  // for them and only calls delete for collaborators / unfinished accounts.
  if (isMember) {
    return NextResponse.json(
      {
        error:
          "Your account has a member profile, so it can't be self-deleted here. You've been signed out; email ai-safety@uonsu.com to have it removed.",
      },
      { status: 409 },
    );
  }

  try {
    const summary = await deleteAccountCascade(auth, db, uid);
    await clearSessionCookieOnly();
    return NextResponse.json(
      { ok: true, ...summary },
      summary.warning ? { status: 207 } : undefined,
    );
  } catch (err) {
    console.error("[reconsent] delete cascade failed:", uid, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 },
    );
  }
}

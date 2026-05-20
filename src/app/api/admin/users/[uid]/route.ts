import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { deleteEventsForSubscriptions } from "@/lib/firestore/subscriptions";

type Ctx = RouteContext<"/api/admin/users/[uid]">;

/**
 * Hard-delete a user. Removes the Firestore user doc, the Firebase Auth
 * account, and the user's subscription rows. Admin-only. If the Auth
 * account is already gone, we still remove the doc.
 *
 * Cascade scope (this slice): subscriptions only. Every row in
 * `subscriptions/` where `audience: "user", audienceId: <uid>` gets
 * deleted in the same call. Without this, the row's audienceId became
 * a dangling reference and the digest sender would still mail the
 * deleted user (the row's `email` field is the source of truth at send
 * time).
 *
 * NOT covered by this slice (queued for the broader hygiene sweep):
 *   - tasks where the user is creator / completer / reviewer
 *   - task subcollections (comments, activity, attachments) authored by
 *     the user
 *   - bookings where the user is host or guest
 *   - newsletter drafts authored by the user
 *   - events authored by the user
 *   - eventRsvps where the user is the attendee
 *   - emailVerifications with matching authUid
 *   - Storage objects (e.g. attachment files in tasks/<id>/<file>)
 *
 * The hygiene sweep is the place where each of those cross-collection
 * references gets mapped, the cascade-delete logic gets written, and
 * orphan-detection tooling lands. See the queued sweep memory.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { uid } = await ctx.params;
  if (!uid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  if (uid === actor.uid) {
    return NextResponse.json(
      { error: "You can't delete yourself. Ask another admin." },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Cascade subscriptions FIRST. Doing this before the user-doc delete
  // means a partial failure (subscriptions deleted, user-doc delete
  // raised) leaves the user without a doc but their cleaned-up rows
  // are gone, which is the safer direction. Doing it after risks
  // leaving rows pointing at a dead uid if the subscription delete
  // fails.
  let subscriptionsDeleted = 0;
  try {
    const snap = await db
      .collection("subscriptions")
      .where("audienceId", "==", uid)
      .get();
    if (!snap.empty) {
      // Filter to audience === "user" defensively; the audienceId space
      // for "guest" rows is the sanitised email, which is extremely
      // unlikely to collide with a uid, but the filter costs nothing.
      const ownedDocs = snap.docs.filter(
        (d) => (d.data() as { audience?: string }).audience === "user",
      );
      // Firestore batches cap at 500. NAISI users have at most a handful
      // of channels; one batch covers a single user's rows easily.
      const batch = db.batch();
      for (const doc of ownedDocs) {
        batch.delete(doc.ref);
      }
      if (ownedDocs.length > 0) {
        await batch.commit();
        subscriptionsDeleted = ownedDocs.length;
        // Drop the deleted rows' event-log entries too, so no PII lingers
        // in subscriptionEvents after the user is gone.
        await deleteEventsForSubscriptions(
          db,
          ownedDocs.map((d) => d.id),
        );
      }
    }
  } catch (err) {
    console.error("[admin delete] subscription cascade failed:", uid, err);
    return NextResponse.json(
      { error: "Failed to delete user's subscription rows or event log. User doc and Auth account were NOT deleted." },
      { status: 500 },
    );
  }

  try {
    await db.collection("users").doc(uid).delete();
  } catch (err) {
    console.error("[admin delete] Firestore delete failed:", err);
    return NextResponse.json(
      {
        error: "Failed to delete user record. Subscription rows were already removed.",
        subscriptionsDeleted,
      },
      { status: 500 },
    );
  }

  try {
    await auth.deleteUser(uid);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== "auth/user-not-found") {
      console.error("[admin delete] Auth delete failed:", err);
      return NextResponse.json(
        {
          ok: true,
          warning: "User doc + subscriptions deleted but Auth account could not be removed.",
          subscriptionsDeleted,
        },
        { status: 207 },
      );
    }
  }

  return NextResponse.json({ ok: true, subscriptionsDeleted });
}

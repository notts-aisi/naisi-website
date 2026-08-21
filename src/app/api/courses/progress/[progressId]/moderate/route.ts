import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Hide or re-publish one member's public comment. ADMIN ONLY — not
 * facilitators, not track leads: taking down something a member wrote in front
 * of their cohort is a governance act, and the audit stamp it leaves names an
 * accountable person.
 *
 * ── HIDING IS NOT DELETING ──────────────────────────────────────────────────
 * `hide` stamps `moderatedByUid` + `moderatedAt` and leaves the comment TEXT
 * in place. The comments route filters stamped rows out of the cohort lane, so
 * the effect is immediate, while the text survives as the audit trail of what
 * was actually taken down. `clear` removes both fields and the comment returns
 * to the lane — which is why the stamp, not a text edit, is the mechanism.
 *
 * The caller is the week page's cohort-notes disclosure, which renders these
 * two actions for admins only. That route serves hidden rows to admins alone
 * (flagged `moderated: true`) precisely so `clear` has something to act on —
 * a lane that hid rows from everyone would make hiding one-way.
 *
 * The member cannot undo either. `courseProgress` is the one client-direct
 * write in this feature, and its rules pin both moderation fields verbatim on
 * every update (and forbid them at create), so re-saving the row cannot
 * fabricate, clear, or launder a stamp — see the collection's module comment.
 * A member who wants the comment gone deletes their own row, which REMOVES the
 * content; that is the moderation outcome, not a way around it.
 *
 * `progressId` is the opaque doc id carried by the comments payload. It is
 * used VERBATIM as a doc id and never parsed: `runId` may itself contain the
 * `__` separator, so the parts are only ever read from the document's fields.
 */

type ModerationAction = "hide" | "clear";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ progressId: string }> },
) {
  const { progressId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
  // separator and `doc()` would throw — a 500 out of an admin action. Same
  // guard as `runAccess.ts`, deliberately identical so the two agree about what
  // counts as an addressable id.
  if (
    !progressId ||
    progressId.includes("/") ||
    progressId === "." ||
    progressId === ".."
  ) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "hide" && body.action !== "clear") {
    return NextResponse.json(
      { error: 'action must be "hide" or "clear".' },
      { status: 400 },
    );
  }
  const action: ModerationAction = body.action;

  const ref = db.collection("courseProgress").doc(progressId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  // `updatedAt` is deliberately untouched: the member did not edit their row,
  // and their own surfaces order on that field.
  //
  // Re-hiding an already-hidden row restamps it with the current admin (last
  // action wins) rather than erroring — the button stays idempotent from the
  // caller's side either way.
  await ref.update(
    action === "hide"
      ? { moderatedByUid: actor.uid, moderatedAt: FieldValue.serverTimestamp() }
      : { moderatedByUid: FieldValue.delete(), moderatedAt: FieldValue.delete() },
  );

  return NextResponse.json({ ok: true, action });
}

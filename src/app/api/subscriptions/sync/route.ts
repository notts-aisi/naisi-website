import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  getVerifiedEmails,
  SUBSCRIPTION_CATEGORIES,
  type SubscriptionCategory,
} from "@/lib/firestore/notifications";
import {
  claimGuestSubscriptions,
  subscribe,
  unsubscribe,
  type SubscriptionActor,
} from "@/lib/firestore/subscriptions";

/**
 * Apply a member's per-(email, channel) subscription matrix as deltas
 * against the subscriptions collection. Used by:
 *  - The register flow (after `completeRegistration` writes the user doc):
 *    claims any guest rows for the new user's verified email(s), then
 *    applies the form's chosen matrix.
 *  - The profile settings UI (after the existing user-doc write to keep the
 *    legacy notifications field in sync): applies the same matrix.
 *
 * Body shape:
 *   {
 *     matrix: {
 *       "[email]": { newsletter: boolean, events: boolean },
 *       ...
 *     }
 *   }
 *
 * Source-of-truth rule: the server pulls the session user's verified emails
 * via `getVerifiedEmails()` and only writes / unsubscribes rows for those.
 * Any matrix entry for an email the helper doesn't return is silently
 * dropped. This stops a client from claiming arbitrary email-channel rows
 * and aligns the write set with the matrix UI's columns.
 *
 * For each (verified email, channel) pair: subscribe if `matrix[email][channel]`
 * is true, unsubscribe otherwise. Most-recent-action wins, so flipping a
 * checkbox off in the UI promptly drops the row's subscribed flag.
 *
 * Iterates `SUBSCRIPTION_CATEGORIES`, NOT `ALL_CATEGORIES`: the matrix is the
 * per-address subscription editor, and `courses` is an account-level opt-out
 * with no subscription row of its own (cohort mail rides `cohort:<runId>`).
 * Iterating every category here would mint a top-level `courses` row nothing
 * sends to — see the constant's comment in notifications.ts.
 */

type MatrixCell = { newsletter?: unknown; events?: unknown };

type Body = {
  matrix?: Record<string, MatrixCell>;
};

export async function POST(req: Request) {
  const session = await getCurrentUser();
  if (!session?.email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const matrix = parsed.matrix ?? {};

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Pull the user doc once. The verified-email helper reads
  // profile.universityEmail + profile.uniEmailVerifiedAt off it, and we
  // also pull a member name to stamp on each row.
  const userSnap = await db.collection("users").doc(session.uid).get();
  if (!userSnap.exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const userData = userSnap.data() ?? {};
  const profile = (userData.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = userData.displayName;
  const memberName: string | undefined =
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    undefined;

  // Take the primary address from the SESSION, not the user document. The
  // session's email comes out of the verified Firebase session cookie; the
  // document field is client-writable, and every row created below is stamped
  // `inboxProven: true` (i.e. confirmed with no click). Preferring the document
  // therefore let a self-registered account point `users/{uid}.email` at a
  // stranger and mint a confirmed subscription for an inbox it does not own —
  // forged marketing consent. firestore.rules now pins the field too; this is
  // the half that does not depend on a rules deploy.
  const verifiedEmails = getVerifiedEmails({
    email: session.email,
    profile: profile as { universityEmail?: unknown; uniEmailVerifiedAt?: unknown },
  });

  // Claim any guest rows for each verified email. Idempotent, a no-op when
  // already claimed in a prior run.
  for (const ve of verifiedEmails) {
    try {
      await claimGuestSubscriptions(db, {
        email: ve.email,
        uid: session.uid,
        name: memberName,
      });
    } catch (err) {
      console.warn("[/api/subscriptions/sync] claim failed", session.uid, ve.email, err);
      // Don't bail, the deltas below should still run.
    }
  }

  // Every write below is the member acting on their own settings.
  const actor: SubscriptionActor = {
    kind: "member",
    uid: session.uid,
    label: "profile settings",
  };

  // Apply per-(email, channel) deltas. Iterate verified emails server-side
  // so the client can't write rows for unverified addresses.
  for (const ve of verifiedEmails) {
    const cell = matrix[ve.email] ?? matrix[normaliseEmail(ve.email)];
    for (const cat of SUBSCRIPTION_CATEGORIES) {
      const wants = readMatrixCell(cell, cat);
      if (wants) {
        await subscribe(db, {
          email: ve.email,
          channel: cat,
          audience: "user",
          audienceId: session.uid,
          // This route iterates only the member's own verified emails, so
          // every row here is genuinely their inbox: skip the click flow.
          inboxProven: true,
          actor,
          source: "register-or-settings",
          name: memberName,
        });
      } else {
        await unsubscribe(db, { email: ve.email, channel: cat, actor });
      }
    }
  }

  return NextResponse.json({ ok: true });
}

function readMatrixCell(
  cell: MatrixCell | undefined,
  cat: SubscriptionCategory,
): boolean {
  if (!cell) return false;
  return Boolean(cell[cat]);
}

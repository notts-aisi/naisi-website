import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  ALL_CATEGORIES,
  type NotificationCategory,
} from "@/lib/firestore/notifications";
import {
  claimGuestSubscriptions,
  subscribe,
  unsubscribe,
} from "@/lib/firestore/subscriptions";

/**
 * Apply a member's notification-category prefs as deltas against the
 * subscriptions collection. Used by:
 *  - The register flow (after `completeRegistration` writes the user doc):
 *    claims any guest rows for the new user's email(s), then applies the
 *    form's chosen categories.
 *  - The profile settings UI (after the existing `updateDoc` to keep the
 *    legacy fields in sync): applies the same deltas without the claim
 *    side-effect (which is a no-op for an already-claimed user anyway).
 *
 * Body shape:
 *   {
 *     prefs: { newsletter: boolean, events: boolean },
 *     // Optional secondary email to also claim (uni email). Only honoured if
 *     // the user has a verified-or-recorded uni email on their profile —
 *     // arbitrary email-claim would let any user drag a guest's
 *     // subscription onto their own account.
 *     claimUniEmail?: boolean
 *   }
 *
 * Source-of-truth rule: most-recent-action wins. The form's choices are
 * authoritative — if newsletter is unticked here, we unsubscribe regardless
 * of any prior guest-row state (which the claim has just absorbed).
 */

type Body = {
  prefs?: { newsletter?: unknown; events?: unknown };
  claimUniEmail?: unknown;
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

  const wantsNewsletter = Boolean(parsed.prefs?.newsletter);
  const wantsEvents = Boolean(parsed.prefs?.events);
  const wantClaimUni = Boolean(parsed.claimUniEmail);

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const googleEmail = normaliseEmail(session.email);

  // Optionally claim guest rows for the user's uni email too. Only honoured
  // when the user actually has one on their profile (server-side check —
  // the client could lie about claimUniEmail).
  let uniEmail: string | null = null;
  if (wantClaimUni) {
    const userSnap = await db.collection("users").doc(session.uid).get();
    const profile = (userSnap.data()?.profile as Record<string, unknown> | undefined) ?? {};
    const recorded = profile.universityEmail;
    if (typeof recorded === "string" && recorded.trim().length > 0) {
      uniEmail = normaliseEmail(recorded);
    }
  }

  // Claim any guest rows for these addresses. Idempotent — no-op when the
  // user has already had their guest rows claimed in a prior run.
  try {
    await claimGuestSubscriptions(db, { email: googleEmail, uid: session.uid });
    if (uniEmail && uniEmail !== googleEmail) {
      await claimGuestSubscriptions(db, { email: uniEmail, uid: session.uid });
    }
  } catch (err) {
    console.warn("[/api/subscriptions/sync] claim failed", session.uid, err);
    // Don't bail — the deltas below should still run. Worst case: a guest
    // row isn't claimed yet and ends up duplicate-feeling for one send,
    // which the next sync run cleans up.
  }

  const wantedByCategory: Record<NotificationCategory, boolean> = {
    newsletter: wantsNewsletter,
    events: wantsEvents,
  };

  // Apply deltas. Each category becomes one row scoped to the user's primary
  // (Google) email — that's the address the existing newsletter sender uses
  // for member-shape sends. Uni-email channel routing for member sends is
  // still handled by the existing `addressesForSend()` helper based on the
  // user doc's `notifications.channels.uniEmail` flag, so we don't need a
  // second subscription row for the uni email.
  for (const cat of ALL_CATEGORIES) {
    if (wantedByCategory[cat]) {
      await subscribe(db, {
        email: googleEmail,
        channel: cat,
        audience: "user",
        audienceId: session.uid,
        source: "register-or-settings",
      });
    } else {
      await unsubscribe(db, { email: googleEmail, channel: cat });
    }
  }

  return NextResponse.json({ ok: true });
}

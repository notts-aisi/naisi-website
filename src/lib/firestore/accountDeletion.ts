import "server-only";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { REGISTRATIONS_COLLECTION } from "./registrations";
import { deleteEventsForSubscriptions } from "./subscriptions";

export type AccountDeletionSummary = {
  subscriptionsDeleted: number;
  registrationDeleted: boolean;
  collaboratorDeleted: boolean;
  userDocDeleted: boolean;
  emailVerificationsDeleted: number;
  authDeleted: boolean;
  /** Set when the teardown was not fully clean (a best-effort step failed, or the
   *  Auth account could not be deleted). Routes return 207 when this is present. */
  warning?: string;
};

/**
 * Cascade-delete an account by uid — the single source of truth for "delete this
 * account," reused by the admin Members delete, the collaborator delete, the
 * admin registrations-tracker delete, and the self-service unfinished-account
 * delete. Centralising this is what fixes the ghost-row bug: every deletion path
 * now tears down the `registrations` tracker doc instead of leaving it dangling.
 *
 * Ordering rationale:
 *  - Subscription ROWS go first and are FATAL on failure — a surviving row would
 *    keep mailing a deleted user. Their append-only event log is best-effort
 *    (the rows are already gone, so a stale audit line is acceptable degradation,
 *    mirroring safeRecordEvent) and must NOT abort the rest of the teardown.
 *  - The Auth user is deleted near-LAST so a late failure leaves at worst a
 *    benign Auth orphan, never a half-account with dangling profile docs. If Auth
 *    deletion fails the account survives, so its refresh tokens are revoked
 *    (best-effort) — otherwise a "deleted" account keeps live sessions elsewhere.
 *  - The `registrations` tracker row is deleted ONLY AFTER a FULLY CLEAN teardown
 *    (Auth gone AND no best-effort step failed). If anything was left behind, the
 *    row is intentionally kept so the orphan stays visible in the tracker for a
 *    retry — clearing it would strand untracked residue (e.g. PII-bearing
 *    emailVerifications tokens) invisible to the very tool built to surface it.
 *    A re-run is idempotent (auth/user-not-found counts as success) and clears
 *    the row once the failed step succeeds.
 *
 * SCOPE: deletes registration-stage + identity data — subscriptions (+ their
 * event log), the registrations row, the collaborators doc, the users doc, the
 * account's email-verification token docs, and the Auth user. It deliberately
 * does NOT delete a member's substantive content (tasks, comments, attachments,
 * events, RSVPs, bookings). That's the deferred hygiene sweep, and retaining
 * content for a period after deletion is the intended behaviour (a privacy-policy
 * retention clause is backburnered).
 */
export async function deleteAccountCascade(
  auth: Auth,
  db: Firestore,
  uid: string,
): Promise<AccountDeletionSummary> {
  const summary: AccountDeletionSummary = {
    subscriptionsDeleted: 0,
    registrationDeleted: false,
    collaboratorDeleted: false,
    userDocDeleted: false,
    emailVerificationsDeleted: 0,
    authDeleted: false,
  };
  // Tracks whether any best-effort step (2-4) failed after attempting, so we can
  // surface it (207) and keep the tracker row for re-cleanup.
  let partialFailure = false;

  // 1. Subscription ROWS (audience=user, audienceId=uid). FATAL on failure —
  //    abort before deleting anything else so we never strand a row that would
  //    keep mailing a deleted user.
  let ownedSubIds: string[] = [];
  try {
    const snap = await db.collection("subscriptions").where("audienceId", "==", uid).get();
    const owned = snap.docs.filter(
      (d) => (d.data() as { audience?: string }).audience === "user",
    );
    if (owned.length > 0) {
      const batch = db.batch();
      for (const d of owned) batch.delete(d.ref);
      await batch.commit();
      summary.subscriptionsDeleted = owned.length;
      ownedSubIds = owned.map((d) => d.id);
    }
  } catch (err) {
    console.error("[deleteAccount] subscription row delete failed:", uid, err);
    throw new Error("Failed to delete the account's subscription rows; nothing else was removed.");
  }

  // 1b. Their append-only event log. BEST-EFFORT: the rows (the mailing source)
  //     are already gone, so a failure here is acceptable degradation and must
  //     not abort the cascade.
  if (ownedSubIds.length > 0) {
    try {
      await deleteEventsForSubscriptions(db, ownedSubIds);
    } catch (err) {
      console.error("[deleteAccount] subscriptionEvents cleanup failed (best-effort):", uid, err);
    }
  }

  // 2. collaborators doc (id is name-slug__uid, so query the uid field).
  try {
    const snap = await db.collection("collaborators").where("uid", "==", uid).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.delete();
      summary.collaboratorDeleted = true;
    }
  } catch (err) {
    console.error("[deleteAccount] collaborator delete failed:", uid, err);
    partialFailure = true;
  }

  // 3. users/{uid} doc.
  try {
    const userRef = db.collection("users").doc(uid);
    if ((await userRef.get()).exists) {
      await userRef.delete();
      summary.userDocDeleted = true;
    }
  } catch (err) {
    console.error("[deleteAccount] user doc delete failed:", uid, err);
    partialFailure = true;
  }

  // 4. emailVerifications token docs (login-email + uni-email both carry authUid).
  //    These hold the account's email PII and, for unfinished accounts, an
  //    unverified login-email token a same-email re-registration could match.
  try {
    const snap = await db.collection("emailVerifications").where("authUid", "==", uid).get();
    if (!snap.empty) {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      summary.emailVerificationsDeleted = snap.size;
    }
  } catch (err) {
    console.error("[deleteAccount] emailVerifications delete failed:", uid, err);
    partialFailure = true;
  }

  // 5. Firebase Auth user. Already-gone counts as success.
  try {
    await auth.deleteUser(uid);
    summary.authDeleted = true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "auth/user-not-found") {
      summary.authDeleted = true;
    } else {
      console.error("[deleteAccount] Auth delete failed:", uid, err);
      summary.warning = "Account data removed, but the Auth account could not be deleted.";
      // The account survives, so its sessions/refresh tokens are still live on
      // every device. Best-effort revoke so a "deleted" account can't keep
      // authenticating elsewhere until a retry actually removes it.
      try {
        await auth.revokeRefreshTokens(uid);
      } catch (revokeErr) {
        console.error("[deleteAccount] revokeRefreshTokens failed:", uid, revokeErr);
      }
    }
  }

  // 6. registrations/{uid} tracker row — ONLY on a fully clean teardown (Auth gone
  //    AND no best-effort step failed). Otherwise keep the row so the orphan stays
  //    surfaced in the tracker; a re-run (idempotent) retries the failed step and
  //    then clears it.
  if (summary.authDeleted && !partialFailure) {
    try {
      await db.collection(REGISTRATIONS_COLLECTION).doc(uid).delete();
      summary.registrationDeleted = true;
    } catch (err) {
      console.error("[deleteAccount] registrations delete failed:", uid, err);
      partialFailure = true;
    }
  }

  // A swallowed best-effort failure is still a non-clean delete — surface it as a
  // warning (→ 207) so callers don't report a clean success.
  if (partialFailure && !summary.warning) {
    summary.warning =
      "Some account data couldn't be removed; the registration row was kept so the deletion can be retried.";
  }

  return summary;
}

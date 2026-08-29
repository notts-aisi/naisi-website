import "server-only";

import { sendPushToUid } from "./send";

/*
 * The task system's push mirror.
 *
 * Policy, deliberately simple: any time the task pipeline EMAILS a member, it
 * also pushes to whatever devices that member has enabled. Having enabled
 * notifications on a device IS the opt-in, exactly as native apps behave, so
 * there is no new preference field and no touching the email-routing model
 * in lib/firestore/notifications.ts (whose docblock warns that `channels`
 * means email-address routing, not transport).
 *
 * Two consequences of mirroring the EMAIL sends specifically:
 *   - the config/task-emails kill switch covers push for free, because every
 *     caller early-returns before reaching a send when it is off;
 *   - a member with push enabled but no email failures still gets exactly
 *     one push per email, so volume is bounded by an existing, understood
 *     budget rather than a new one.
 *
 * NEVER throws and never awaits anything the caller's error accounting can
 * see: a push failure must not mark an email send as failed, and a member
 * with zero enabled devices costs one Firestore query. Callers await it (so
 * Cloud Run cannot reap the work after the response) but need no try/catch.
 */
export async function mirrorTaskEmailToPush(
  uid: string,
  { title, body, taskId }: { title: string; body: string; taskId: string },
): Promise<void> {
  try {
    await sendPushToUid(uid, {
      title,
      body,
      // Path only; the service worker resolves it against the app origin.
      // Same destination the email's button uses.
      url: `/committee/tasks?task=${encodeURIComponent(taskId)}`,
    });
  } catch (err) {
    console.warn("[push] task mirror failed", { uid, err });
  }
}

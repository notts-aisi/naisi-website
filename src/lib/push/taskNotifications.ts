import "server-only";

import { isPushConfigured } from "./config";
import { wantsPushFor } from "./preferences";
import { sendPushToUid } from "./send";

/*
 * The task system's push mirror.
 *
 * Policy: any time the task pipeline EMAILS a member, it also pushes to
 * whatever devices that member has enabled, UNLESS they have switched
 * `notifications.push.tasks` off on their profile. Enabling notifications on
 * a device is still the opt-in that makes any of this happen; the switch is
 * the opt-out on top of it, for the member who wants their phone to buzz for
 * a decision but not for every comment on a task.
 *
 * The switch is its own axis in lib/firestore/notifications.ts, alongside
 * (never inside) `channels`, which means email-address routing rather than
 * transport.
 *
 * COST: an enabled member now costs one user-doc read before the
 * subscriptions query. A member who has switched tasks off costs only that
 * read, and nothing is sent.
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
 *
 * No retryFresh here, deliberately: a task push that coincides with the
 * first seconds of a device's subscription (send.ts explains the push
 * service's lag) is dropped rather than holding a task route open. The
 * email still goes, so nothing is lost.
 */
export async function mirrorTaskEmailToPush(
  uid: string,
  { title, body, taskId }: { title: string; body: string; taskId: string },
): Promise<void> {
  try {
    // Cheapest gate first: with no VAPID keys the whole feature is dormant
    // and there is no reason to read anybody's preferences.
    if (!isPushConfigured()) return;
    if (!(await wantsPushFor(uid, "tasks"))) return;
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

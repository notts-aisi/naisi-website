import "server-only";

import { isPushConfigured } from "./config";
import { wantsPushFor } from "./preferences";
import { sendPushToUid } from "./send";

/*
 * The decision push.
 *
 * WHAT PUSHES: the two moments a member is waiting on an answer, and only
 * those. An appointment or a refusal on an admissions round, and a placement
 * when an allocation is published. Both are already emailed; this mirrors the
 * email to the member's enabled devices so somebody refreshing the status
 * page on a Friday evening hears about it without refreshing.
 *
 * WHAT DOES NOT PUSH, deliberately: the weekly course reminder, the
 * deadline reminders and the stage-release announcement. A course sends
 * those on a schedule to everybody at once, and a scheduled email that also
 * buzzes every phone in a cohort is how people turn notifications off for
 * good. `tests/push-preferences.test.mjs` asserts none of those three files
 * imports anything from `@/lib/push`, so this stays a decision rather than a
 * habit.
 *
 * THE BODY NAMES THE ROUND OR THE COURSE, NEVER THE REASON. A push renders
 * on a lock screen, which is a surface the member did not choose and other
 * people can read over their shoulder. The decider's note, the shared reason
 * and the outcome's wording stay in the email, behind the account. The push
 * says an answer has arrived and where to read it.
 *
 * BEST EFFORT, ALWAYS. Never throws into the caller, never delays a
 * committed decision, and sends nothing when the environment has no VAPID
 * configuration (which is every environment until the secrets are
 * provisioned, see docs/pwa.md). A failure here must not turn a saved
 * decision into a 500 that reads as "it did not save".
 *
 * No `retryFresh`, for the same reason the task mirror does not use it: a
 * push landing in the first seconds of a subscription's life is dropped
 * rather than held open. The email still goes.
 */
export async function mirrorCourseDecisionToPush(
  uid: string,
  {
    title,
    body,
    url,
  }: {
    title: string;
    body: string;
    /** Same-origin PATH. The service worker resolves it against the origin. */
    url: string;
  },
): Promise<void> {
  try {
    if (!isPushConfigured()) return;
    if (!uid) return;
    if (!(await wantsPushFor(uid, "courseDecisions"))) return;
    await sendPushToUid(uid, { title, body, url });
  } catch (err) {
    console.warn("[push] course decision mirror failed", { uid, err });
  }
}

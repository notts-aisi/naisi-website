import "server-only";

import { isPushConfigured } from "./config";
import { wantsPushFor } from "./preferences";
import { sendPushToUid } from "./send";

/*
 * The decision push.
 *
 * WHAT PUSHES: the moments an applicant or a member is waiting on us, and
 * only those. An appointment or a refusal on an admissions round, a placement
 * when an allocation is published, and (by the owner's decision of 6
 * September 2026) a new part of an application form opening. All three are
 * already emailed; this mirrors the email to the member's enabled devices so
 * somebody checking their application on a Friday evening hears about it.
 *
 * WHAT DOES NOT PUSH, deliberately: the weekly course reminder and the
 * admissions deadline reminders. Those are a schedule nagging everybody at
 * once about a date they already know, and a scheduled email that also buzzes
 * every phone in a cohort is how people turn notifications off for good. The
 * stage release is the line between the two: it is not a countdown, it is the
 * one moment there is something new to answer.
 * `tests/push-preferences.test.mjs` asserts neither of those two files
 * imports anything from `@/lib/push`, and that the stage-release job reaches
 * for THIS door rather than building its own.
 *
 * THE BODY NAMES THE ROUND OR THE COURSE, NEVER THE REASON. A push renders
 * on a lock screen, which is a surface the member did not choose and other
 * people can read over their shoulder. The decider's note, the shared reason
 * and the outcome's wording stay in the email, behind the account. The push
 * says an answer has arrived and where to read it. A stage announcement is
 * held to the same line: the round's name and the stage's title, never a
 * question.
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
    // The `courses` row of the notification grid. Members who answered under
    // the old `courseDecisions` key are still honoured: `normaliseNotifications`
    // reads it as an alias when `courses` is absent.
    if (!(await wantsPushFor(uid, "courses"))) return;
    await sendPushToUid(uid, { title, body, url });
  } catch (err) {
    console.warn("[push] course decision mirror failed", { uid, err });
  }
}

import "server-only";

import { isPushConfigured } from "./config";
import { sendPushToUid } from "./send";

/*
 * THE NOTICE LANE'S PUSH DOOR, and the one push path in the estate that reads
 * no preference at all.
 *
 * Every other push in this product is a MIRROR: an email has just gone, and the
 * push column of that email's row decides whether a phone buzzes beside it.
 * `mirrorTaskEmailToPush` and `mirrorCourseDecisionToPush` both consult their
 * row and both stay exactly as they are. This one does not, and the difference
 * is the whole point of the class: a notice is a person responsible for an
 * audience telling that audience something about the thing they signed up for,
 * and it reaches them by email AND notification whichever switches they set.
 * The profile grid says so on its face (the Important notices row is drawn
 * locked, with copy explaining it), so the member has been told, which is what
 * makes the bypass honest rather than a surprise.
 *
 * THIS FILE THEREFORE IMPORTS NO PREFERENCE HELPER, and a test asserts it by
 * reading the source rather than trusting this comment: the moment a row is
 * consulted here, an organiser's "we have moved to B52" becomes deliverable to
 * some of the room and not the rest, which is the failure the lane exists to
 * prevent. The email still reaches everyone, so the failure would also be
 * invisible.
 *
 * WHAT STILL GATES IT. A device: push needs a subscription, so a member who has
 * never enabled notifications gets nothing here and the email alone, and this
 * says nothing about it because there is nothing to say. VAPID configuration:
 * without keys the whole feature is dormant (see docs/pwa.md) and the cheapest
 * gate runs first. And a uid: a guest who RSVP'd with an address and no account
 * has nothing to push to, so the caller simply has no uid to pass.
 *
 * BEST EFFORT, ALWAYS. It never throws into the caller and never delays one. A
 * notice's email is the message; the notification is the nudge that gets it
 * read tonight. A push failure must not turn a delivered broadcast into a 500
 * that reads as "nothing was sent".
 *
 * IT ANSWERS WHETHER A PHONE ACTUALLY BUZZED, which is the only honest thing a
 * caller can put in a `pushed` count. Every gate above is silent by design (no
 * VAPID keys, no uid, no device, a rejected destination), so a caller that
 * counted CALLS would answer `pushed: 40` on a backend where the feature is
 * dormant and nobody was notified at all. The boolean is true when at least one
 * of that member's devices took the notification, and false for every other
 * outcome including a partial failure across two devices.
 *
 * No `retryFresh`, for the reason the two mirrors give: a push landing in the
 * first seconds of a subscription's life is dropped rather than held open, and
 * the email has already gone.
 */

/**
 * A caller-supplied destination, or null if it is not one this module will hand
 * to a notification.
 *
 * The service worker passes the payload's path straight to `clients.openWindow`
 * (`public/sw.js`), which will just as happily open `https://elsewhere/`, so a
 * notification carrying this site's name and icon that opens somebody else's
 * page is the worst thing this file could do. `//elsewhere.example` is refused
 * alongside the obvious absolute forms: it starts with "/" and is still
 * off-origin, which is exactly the case a `startsWith("/")` check waves
 * through. Same rule, same reasoning, as `taskPushPath`.
 */
function noticePushPath(url: string): string | null {
  if (typeof url !== "string" || url === "") return null;
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  return url;
}

/**
 * @returns true when at least one of this member's devices was handed the
 * notification. False for every silent outcome, so a caller's `pushed` count
 * is notifications rather than attempts. See "IT ANSWERS WHETHER A PHONE
 * ACTUALLY BUZZED" above.
 */
export async function sendNoticePush(
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
): Promise<boolean> {
  try {
    // Cheapest gate first: with no VAPID keys nothing pushes anywhere.
    if (!isPushConfigured()) return false;
    if (!uid) return false;
    const path = noticePushPath(url);
    // A destination this module will not vouch for is a dropped push, not a
    // notification sent somewhere else. The email carries the same message.
    if (!path) {
      console.warn("[push] notice dropped: destination is not a same-origin path");
      return false;
    }
    const counts = await sendPushToUid(uid, { title, body, url: path });
    return counts.sent > 0;
  } catch (err) {
    console.warn("[push] notice failed", { uid, err });
    return false;
  }
}

import "server-only";
import type { ReactElement } from "react";
import NoticeMarker from "@/emails/NoticeMarker";
import type { EmailSendSurface } from "@/lib/firestore/emailSends";
import { sendEmail, type SendResult } from "./send";

/**
 * THE NOTICE LANE'S EMAIL DOOR.
 *
 * The notification grid has three classes and this is the third: a person
 * responsible for an audience addressing that audience about something the
 * audience signed up for. It goes out whatever the recipient's rows say. The
 * two other classes are grid (consult the row) and transactional (never consult
 * it because the member asked for the message by doing the thing).
 *
 * ── IT IS A WRAPPER, NEVER A SECOND DOOR ────────────────────────────────────
 * `sendEmail` stays the one place mail leaves this product, because that is
 * where the suppression list is read (`tests/email-suppression-chokepoint.test.mjs`
 * pins it). A notice bypasses PREFERENCES, never DELIVERABILITY: a bounce or a
 * complaint is a fact about an address, not a choice, and no class of message
 * outranks it. So this function does exactly three things `sendEmail` cannot do
 * for itself and then calls it.
 *
 * ── THE THREE THINGS ────────────────────────────────────────────────────────
 *  1. THE MARKER. It builds `NoticeMarker` for the surface and hands it to the
 *     template as a slot, so the visible "Sent as an important notice" line and
 *     the sentence under it are written once, here, rather than per caller. A
 *     template chooses where it renders (under the greeting, above the body in
 *     every one today); it never chooses what it says. That is why the caller
 *     passes `render`, a function from the marker to the email, rather than a
 *     finished element: an element the caller had already built could not be
 *     guaranteed to carry the line at all.
 *  2. THE RECEIPT. `kind: "notice"` plus the `surface`, so the deliverability
 *     tab can answer "how much un-switch-off-able mail went out, and from
 *     where" without reading subject lines. Neither is a caller's to choose.
 *  3. NO UNSUBSCRIBE. `listUnsubscribe` is not in the argument list and is
 *     never passed on, matching every other bypass path in the estate. A footer
 *     or an RFC 8058 header offering to switch off something that cannot be
 *     switched off is the one dishonest thing this lane could ship, and leaving
 *     the option out of the signature is how that stays true.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not push (that is `sendNoticePush`, its sibling, which is a separate
 * call because a member with no device gets the email alone and a guest with no
 * account gets email only), it does not derive an audience, and it does not
 * rate limit. Audiences are per surface and PII-shaped, so each route derives
 * its own server side and returns counts; the caps are
 * `src/lib/email/noticeCaps.ts`, claimed by the route before its first send.
 */

/** The surfaces the lane serves. One string, receipt and marker copy alike. */
export type NoticeSurface = EmailSendSurface;

export type SendNoticeArgs = {
  /** ONE address. Callers dispatch per recipient, never a list and never a Cc. */
  to: string;
  subject: string;
  /** Which lane this is, for the receipt and for the marker's sentence. */
  surface: NoticeSurface;
  /** The uid of the person who chose to send it. The receipt's actor. */
  actorUid: string;
  /** The event, group or run this is about. The receipt's reference. */
  referenceId: string;
  /**
   * The template, handed the marker to render above its body. Not an element:
   * see "THE THREE THINGS" above.
   */
  render: (marker: ReactElement) => ReactElement;
  /** Override the From display name (e.g. "NAISI Events"). */
  fromName?: string;
  replyTo?: string;
};

export async function sendNotice({
  to,
  subject,
  surface,
  actorUid,
  referenceId,
  render,
  fromName,
  replyTo,
}: SendNoticeArgs): Promise<SendResult> {
  return sendEmail({
    to,
    subject,
    react: render(NoticeMarker({ surface })),
    fromName,
    replyTo,
    kind: "notice",
    surface,
    actorUid,
    referenceId,
  });
}

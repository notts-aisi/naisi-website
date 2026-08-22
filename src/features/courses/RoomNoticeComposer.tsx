"use client";

import { useId, useState } from "react";
import Link from "next/link";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import Skeleton from "@/components/ui/Skeleton";
import type { GroupSessionMode } from "@/lib/firestore/courseGroups";
import { groupNoticeUrl } from "./useGroupWeeks";
import { useGroupRoster } from "./useGroupRoster";
import styles from "./RoomNoticeComposer.module.css";

/**
 * The one-click "we've moved" message: a short operational notice to everyone
 * in one group, prefilled from how that group's current week is meeting.
 *
 * ── WHY THIS EXISTS NEXT TO THE MODE SWITCH ─────────────────────────────────
 * Flipping a week to online changes what the week page shows. It does not tell
 * anybody. The gap between "the site is now correct" and "the group knows" is
 * where people turn up to an empty room, so the composer sits on the same page
 * as the switch with the sentence already written — the facilitator's job is to
 * read it, not to compose it at 4pm on the day.
 *
 * ── THE OPERATIONAL LANE ────────────────────────────────────────────────────
 * This is not an announcement. It goes to everyone placed in the group whatever
 * their course-email preference says, because "the room has changed" is not
 * marketing and a member who opted out of course news has not opted out of
 * being told where to go. What it still honours is SUPPRESSION: an address that
 * has bounced or been marked as spam is skipped, and the report says how many.
 * The distinction is the whole reason this is a separate lane from the group
 * email composer, and the copy states it rather than implying it.
 *
 * ── THE CAP IS A REAL NUMBER AND IT IS STATED ───────────────────────────────
 * Room notices have their own daily budget per group — separate from the group
 * email composer's hourly one, precisely so that a genuine double-change
 * evening ("we're on Zoom" then "actually B14") is not blocked by a limit meant
 * for something else. It is a real limit though, and every send is logged, so
 * the number is on screen before anyone runs into it.
 *
 * ── SENDING IS IRREVERSIBLE, SO THE GUARD ARMS BEFORE DISPATCH ──────────────
 * Copied deliberately from `StaffEmailComposer`, whose header carries the full
 * argument: the attempt is recorded the instant Send is pressed, because that
 * is the instant the message may start reaching people. A route that answers
 * with a SENTENCE refused before its first send, so the button re-arms. Silence
 * — a dropped connection, an unparseable body — is UNKNOWN: some, all or none
 * of the group may have it, and saying so is the only honest option.
 *
 * ── THERE IS NO TEST SEND, AND THAT IS DELIBERATE ───────────────────────────
 * The group email composer offers one; this does not, because the notice route
 * takes `{ message }` and nothing else — no subject to compose, no test lane.
 * A "Send a test" button here would post a flag the route ignores and mail the
 * ENTIRE GROUP while claiming to reach only the author, which is the worst
 * possible failure for a control whose whole promise is that it is safe. What
 * replaces it is cheaper and truer: the message is plain text, so the box IS
 * the preview, and the confirm dialog restates it verbatim before anything
 * leaves. If the route ever grows a test lane, add the button in the same
 * change — never ahead of it.
 */

type Props = {
  groupId: string;
  groupName: string;
  /** Where to send them for the roster; the composer never sees an address. */
  groupHref: string;
  /**
   * How this group's CURRENT week is meeting, resolved server-side (the group
   * doc is not client-readable by a facilitator). Null when the group has no
   * dated week right now — the composer still works, it just cannot prefill.
   */
  session: {
    /** "Week 4", "Reading week", "Before the course starts". */
    weekLabel: string;
    /** "Tuesdays 18:00–19:30", or "" when the slot is half-authored. */
    slotLabel: string;
    /** Null when no week-level mode is set — the usual arrangement stands. */
    mode: GroupSessionMode | null;
    location: string;
    meetingUrl: string | null;
  } | null;
};

/**
 * `NOTICES_PER_WINDOW` in the notice route, mirrored for one SENTENCE.
 * Deliberately not enforced here: the route refuses on its own durable
 * counter, and a client-side block would hide that refusal instead of letting
 * a facilitator meet it with an explanation.
 */
const DAILY_CAP = 10;

/** `MAX_MESSAGE` in the notice route. A notice is a paragraph, not a newsletter. */
const MESSAGE_MAX = 1000;

type SendOutcome =
  | { state: "pending" }
  | { state: "done"; sent: number; skipped: number; remaining: number | null }
  /** The route answered with a sentence: nothing was sent. */
  | { state: "refused"; message: string }
  /** No usable answer: some, all or none of the group may have it. */
  | { state: "unknown"; message: string };

type Attempt = { signature: string; outcome: SendOutcome };

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/**
 * The sentence the switch implies, written out. Deliberately complete on its
 * own — a member reading it in a notification with no context should know where
 * to be and when.
 */
function prefillFor(session: Props["session"]): string {
  // No week-level mode set means nothing has changed this week, so there is
  // nothing to announce — the facilitator writes their own notice instead of
  // being handed a sentence that asserts a switch that never happened.
  if (!session || session.mode === null) return "";

  const when = session.slotLabel ? ` We're still meeting ${session.slotLabel}.` : "";
  if (session.mode === "virtual") {
    const where = session.meetingUrl
      ? ` Join here: ${session.meetingUrl}`
      : " I'll send the joining link separately.";
    return `${session.weekLabel}: we're meeting online this week rather than in person.${where}${when}`;
  }
  const where = session.location
    ? ` We're in ${session.location}.`
    : " I'll confirm the room separately.";
  return `${session.weekLabel}: we're meeting in person this week.${where}${when}`;
}

export default function RoomNoticeComposer({
  groupId,
  groupName,
  groupHref,
  session,
}: Props) {
  const roster = useGroupRoster(groupId);
  const { toast, run: runAction, dismiss } = useActionToast();

  const prefill = prefillFor(session);
  const [message, setMessage] = useState(prefill);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * The last REAL send. In-memory only: a reload clears it and re-arms Send on
   * identical text, which is exactly the dropped-connection case. The durable
   * backstop is the route's own daily counter.
   */
  const [sendAttempt, setSendAttempt] = useState<Attempt | null>(null);
  const [clearedForResend, setClearedForResend] = useState<string | null>(null);

  const domId = useId();
  const messageId = `${domId}-message`;

  const signature = message.trim();
  const written = signature.length > 0;

  // Null is "we do not know", which is NOT zero — see StaffEmailComposer.
  const count = roster.memberCount;
  const countKnown = count !== null;

  const attempt = sendAttempt?.signature === signature ? sendAttempt : null;
  const blocking = attempt !== null && attempt.outcome.state !== "refused";
  const armed = blocking && clearedForResend !== signature;
  const resending = blocking && clearedForResend === signature;
  const canSend = written && countKnown && count > 0 && !armed && !busy;

  function send() {
    // Frozen: the field stays editable while the request is in flight, and the
    // attempt must be filed against the text that was actually dispatched.
    const attemptSignature = signature;
    const record = setSendAttempt;

    // ARM FIRST. Past this line the notice may already be reaching people.
    record({ signature: attemptSignature, outcome: { state: "pending" } });
    setClearedForResend(null);
    setBusy(true);

    void runAction(
      async () => {
        let res: Response;
        try {
          res = await fetch(groupNoticeUrl(groupId), {
            method: "POST",
            headers: { "content-type": "application/json" },
            // `{ message }` and nothing else — the route's whole body. It
            // rejects a body that is not an object and ignores extra keys, so
            // sending a flag it does not implement (a `testOnly`, say) would
            // read as safe here and mail the entire group. See the header.
            body: JSON.stringify({ message: attemptSignature }),
          });
        } catch (err) {
          const text =
            err instanceof Error ? err.message : "The request didn't complete.";
          record({ signature: attemptSignature, outcome: { state: "unknown", message: text } });
          throw new Error(text);
        }

        const payload = (await res.json().catch(() => null)) as
          | {
              ok?: true;
              sent?: number;
              skipped?: number;
              remaining?: number;
              error?: string;
            }
          | null;

        if (res.ok && payload?.ok) {
          record({
            signature: attemptSignature,
            outcome: {
              state: "done",
              sent: payload.sent ?? 0,
              skipped: payload.skipped ?? 0,
              remaining:
                typeof payload.remaining === "number" ? payload.remaining : null,
            },
          });
          return;
        }

        // The route's own sentence where it gave one — the daily cap has to
        // read as itself, not as "something went wrong". It is also the
        // evidence that nothing was sent: the route refuses before dispatch.
        const sentence =
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : null;
        const text = sentence ?? `That didn't go through (${res.status}).`;
        record({
          signature: attemptSignature,
          outcome: sentence
            ? { state: "refused", message: text }
            : { state: "unknown", message: text },
        });
        throw new Error(text);
      },
      {
        savingMessage: "Sending the notice…",
        successMessage: "Sent — the report below has the numbers",
      },
    ).finally(() => setBusy(false));
  }

  return (
    <>
      <Card as="section" padding="lg" className={styles.composer}>
        <h2 className={styles.sectionTitle}>Tell the group</h2>
        <p className={styles.hint}>
          A short notice about this week&apos;s session — a moved room, a switch
          to online, a cancellation. Changing how the week meets updates the week
          page; it does not tell anybody, so this is how they find out.
        </p>

        {/* ---- Who this reaches ------------------------------------------ */}

        <div className={styles.recipients}>
          {roster.loading && !countKnown ? (
            <Skeleton
              width="20rem"
              height="1.25rem"
              ariaLabel="Counting who this reaches…"
            />
          ) : !countKnown ? (
            <>
              <p className={styles.recipientsBlocked}>
                We couldn&apos;t load {groupName}&apos;s roster, so we can&apos;t
                tell you how many people this would reach. Sending is off until we
                can.
              </p>
              {roster.error && (
                <p className={styles.recipientsNote}>{roster.error.message}</p>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={roster.reload}
                disabled={roster.loading}
              >
                {roster.loading ? "Trying…" : "Try again"}
              </Button>
            </>
          ) : count === 0 ? (
            <p className={styles.recipientsBlocked}>
              No one is placed in {groupName} yet, so there is nobody to tell.
            </p>
          ) : (
            <>
              <p className={styles.recipientsLine}>
                This goes to the {count} active{" "}
                {count === 1 ? "member" : "members"} of {groupName}.
              </p>
              <p className={styles.recipientsNote}>
                One message each — nobody sees who else it went to. It is an
                operational message about their own group, so{" "}
                <strong>
                  everyone gets it whatever their course-email settings say
                </strong>
                . Addresses that have bounced or been marked as spam are still
                skipped, and the report says how many. Room notices are capped at{" "}
                {DAILY_CAP} a day for this group and every one is logged.{" "}
                <Link className={styles.inlineLink} href={groupHref}>
                  See who is in the group
                </Link>
              </p>
            </>
          )}
        </div>

        {/* ---- The message ------------------------------------------------ */}

        <Field
          id={messageId}
          label="Message"
          hint="Plain text — no formatting, no images. It is sent as it appears here; your name is not added for you."
        >
          <CountedTextarea
            id={messageId}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            max={MESSAGE_MAX}
            rows={5}
            disabled={busy}
            placeholder="We're in B14 rather than the usual room this Tuesday. Same time."
          />
        </Field>

        {prefill && (
          <div className={styles.prefillRow}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMessage(prefill)}
              disabled={busy || message === prefill}
            >
              Use the wording for this week
            </Button>
            <span className={styles.prefillNote}>
              {session?.mode === "virtual"
                ? "Written from this week being online — it carries the joining link."
                : "Written from this week being in person — it carries the room."}
            </span>
          </div>
        )}

        {!prefill && (
          <p className={styles.hint}>
            {!session
              ? "Your group has no dated week right now, so there is nothing to prefill. Write the notice yourself."
              : `You haven't set how ${session.weekLabel} meets, so there's no change to announce. Set it on the week, or just write the notice yourself.`}
          </p>
        )}

        {/* ---- Actions ---------------------------------------------------- */}

        <div className={styles.actions}>
          <div className={styles.noteColumn}>
            <p className={styles.actionNote}>
              <strong>There is no test send on this lane.</strong> The notice is
              plain text and goes out exactly as written above, so the box you
              just typed in is the preview — and the confirm step shows it back
              to you one more time before anything leaves.
            </p>
          </div>

          <div className={styles.sendAction}>
            <Button onClick={() => setConfirming(true)} disabled={!canSend}>
              {countKnown && count > 0 ? `Send to ${people(count)}` : "Send the notice"}
            </Button>
            <p className={styles.actionNote}>
              {!written
                ? "Write the notice first."
                : !countKnown
                  ? "Blocked until we know who this reaches: we will not ask you to confirm a number we cannot vouch for."
                  : count === 0
                    ? `There is nobody in ${groupName} to send to.`
                    : armed
                      ? attempt?.outcome.state === "done"
                        ? "This exact notice has already gone out. Edit it to send again."
                        : attempt?.outcome.state === "unknown"
                          ? "This exact notice may already have gone out. Edit it, or use the report below to send it again anyway."
                          : "This notice is going out now."
                      : resending
                        ? "Resending: anyone who already received the earlier attempt will get it twice."
                        : "You will get one more chance to confirm. After that it cannot be recalled."}
            </p>
          </div>
        </div>

        {/* ---- What actually happened ------------------------------------- */}

        {sendAttempt && (
          <div
            className={`${styles.report} ${
              sendAttempt.outcome.state === "unknown" ? styles.reportUnknown : ""
            }`}
            role="status"
          >
            <p className={styles.reportHead}>
              {sendAttempt.outcome.state === "pending"
                ? "Sending"
                : sendAttempt.outcome.state === "unknown"
                  ? "Last notice — outcome unknown"
                  : sendAttempt.outcome.state === "refused"
                    ? "Last notice — refused"
                    : "Last notice"}
            </p>

            {sendAttempt.outcome.state === "pending" && (
              <p className={styles.reportBody}>
                Going out now, one message at a time. The numbers appear here when
                the route answers.
              </p>
            )}

            {sendAttempt.outcome.state === "done" && (
              <p className={styles.reportBody}>
                Sent to {people(sendAttempt.outcome.sent)}.{" "}
                {sendAttempt.outcome.skipped > 0
                  ? `${sendAttempt.outcome.skipped} skipped: a suppressed address (one that has bounced or been marked as spam before), an account with no usable address, or a send that failed. Nothing reached those people — worth catching them another way.`
                  : "Nobody was skipped."}{" "}
                {sendAttempt.outcome.remaining !== null &&
                  `${sendAttempt.outcome.remaining} of today's ${DAILY_CAP} notices left for this group. `}
                Sending is not the same as arriving: this says what left, not what
                landed.
              </p>
            )}

            {sendAttempt.outcome.state === "refused" && (
              <p className={styles.reportBody}>
                This attempt sent nothing — it was refused before the first
                message went out. {sendAttempt.outcome.message}
              </p>
            )}

            {sendAttempt.outcome.state === "unknown" && (
              <>
                <p className={styles.reportBody}>
                  We didn&apos;t get an answer, so we cannot tell you what
                  happened: this notice may have reached nobody, some of{" "}
                  {groupName}, or all of it. An error here is NOT proof that
                  nothing was sent — the route sends one message at a time and a
                  connection that dies part-way through leaves no report.{" "}
                  {sendAttempt.outcome.message}
                </p>
                <p className={styles.reportBody}>
                  Before sending it again, find out: ask someone in the group
                  whether it arrived, or have an admin check the send log on the
                  Deliverability tab, which lists every message that actually
                  left.
                </p>
                {attempt && !resending && (
                  <div className={styles.reportActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setClearedForResend(signature)}
                      disabled={busy}
                    >
                      Let me send this again anyway
                    </Button>
                    <p className={styles.actionNote}>
                      Unblocks Send for this exact notice. Anyone who already
                      received it will get it a second time.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

      </Card>

      {/* ---- The last stop ------------------------------------------------ */}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        ariaLabel={`Send this notice to ${groupName}`}
        width="sm"
      >
        <div className={styles.confirm}>
          <h2 className={styles.confirmTitle}>
            {countKnown && count > 0 ? `Send to ${people(count)}?` : "Send the notice?"}
          </h2>
          <p className={styles.confirmBody}>
            This emails everyone placed in {groupName}, including anyone who has
            turned course announcements off. Here it is, exactly as it will
            arrive:
          </p>
          {/* The author's own text, rendered as a text node. */}
          <p className={styles.confirmMessage}>{signature}</p>
          {resending && (
            <p className={styles.confirmBody}>
              This is a resend of a notice whose outcome we couldn&apos;t confirm.
              Anyone who received the earlier attempt gets it twice.
            </p>
          )}
          <p className={styles.confirmBody}>
            Email cannot be recalled once it has gone. A few people can still be
            skipped — a suppressed address, or an account with no usable one — and
            the report will say how many.
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                send();
              }}
              disabled={!canSend}
            >
              Send the notice
            </Button>
          </div>
        </div>
      </Modal>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

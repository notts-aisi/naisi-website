"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import Skeleton from "@/components/ui/Skeleton";
import { useGroupRoster } from "./useGroupRoster";
import styles from "./StaffEmailComposer.module.css";

/**
 * Write one staff email — to ONE GROUP (the operational lane) or to a WHOLE
 * COHORT (the announcement lane). One component, two audiences, because the
 * guards are the feature and two copies of them would drift.
 *
 * ── EVERY GUARD HERE EXISTS BECAUSE SENDING IS IRREVERSIBLE ─────────────────
 * There is no unsend, no draft state to walk back and no moderation queue
 * behind this form, so the composer is built around three claims it has to be
 * able to make honestly:
 *
 *  1. WHO IT REACHES, stated before the send and restated in the confirm. For a
 *     group the count is the roster route's active members; for a run it is the
 *     number of rows on the cohort channel, counted by the page's server shell,
 *     and stated as "up to N" because opt-outs and suppression are applied
 *     later, server-side, and can only make it smaller. When the count is
 *     unknown the real send is BLOCKED rather than sent with a hedge — a
 *     confirm dialog whose number is a guess is worse than no confirm at all.
 *     The test send stays available, because it reaches nobody but the author.
 *  2. WHAT ACTUALLY WENT OUT, after the fact. The routes report `sent` and
 *     `skipped`; both are shown. "Skipped" covers the suppression list —
 *     addresses that have bounced or been marked as spam — plus, on the run
 *     lane, everyone who has turned course announcements off. Folding those
 *     into a cheerful "sent to everyone" would quietly hide the one thing a
 *     facilitator needs to know about a member who never hears from them.
 *  3. THAT IT HAS NOT ALREADY GONE — see the next block, which is the whole
 *     reason this component holds state at all.
 *
 * ── THE DOUBLE-SEND GUARD ARMS BEFORE DISPATCH, NOT ON SUCCESS ──────────────
 * The attempt is recorded the instant Send is pressed, BEFORE the request
 * leaves — because that is the instant the message may start reaching people.
 * Arming on the response instead would leave the one case that actually
 * duplicates mail wide open: a request that dies (dropped connection, a
 * timeout) AFTER the route's per-recipient loop has begun sends to some of the
 * list, returns no report, and — if the button re-armed only on success —
 * leaves an untouched-looking Send holding the identical text.
 *
 * So a failure does not clear the guard. It moves the attempt to one of two
 * states, and they are not the same thing:
 *
 *   REFUSED  — the route answered with a sentence (a validation error, a rate
 *              limit, the over-cap refusal). Both send routes return every
 *              refusal BEFORE the first `sendEmail`, so a sentence is proof
 *              nothing went out; the guard does not arm and the author can fix
 *              and retry immediately. If a route ever starts refusing mid-loop,
 *              this classification has to change with it.
 *   UNKNOWN  — anything else: no response, an unparseable one, a bare 5xx. We
 *              cannot say whether the loop ran, so we say exactly that. The
 *              guard stays armed and a resend needs an explicit
 *              acknowledgement that some people may get the message twice.
 *
 * A clean success blocks the identical text outright — edit it to send again —
 * which is the rule that was already here.
 *
 * Test sends carry their own attempt record, deliberately separate: proofing a
 * message must never look like sending it, and (the older bug) a test must
 * never clear the guard on a real send that has already happened.
 *
 * ── NO ADDRESSES, EITHER DIRECTION ──────────────────────────────────────────
 * This form never sees an email address. It posts a subject and a body; the
 * route resolves recipients server-side, filters the suppression list and
 * returns counts only. The group roster it counts from carries names, and they
 * are not rendered here at all; the run count crosses as a bare number.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Toast, not inline, for both actions (the plan's toast-vs-inline rule): a
 * send is a must-not-continue action other people will read.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Which lane this composer is in — the ONE thing that varies between them.
 *
 * Deliberately a discriminated union rather than a bag of copy props. The
 * component's safety property is that its sentences are true, and a
 * copy-in-props API would let any caller describe any audience however it
 * liked. Keeping both lanes' wording in this file also means a change to one
 * is read next to the other.
 */
export type StaffEmailAudience =
  | {
      kind: "group";
      groupId: string;
      /**
       * From the page's server gate, not from the payload — the recipient
       * sentence has to be able to name the group before anything has loaded.
       */
      groupName: string;
    }
  | {
      kind: "run";
      /** The run's own label ("Autumn 2026"), from the page's server gate. */
      runLabel: string;
      /**
       * Rows on `cohort:<runId>`, counted server-side by the page shell, or
       * null when that count could not be taken — which BLOCKS the real send
       * exactly as an unloadable roster does. An upper bound, never a promise:
       * see claim 1 in the header.
       */
      subscriberCount: number | null;
    };

type Props = {
  runId: string;
  audience: StaffEmailAudience;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The caps the fields count against — MIRRORED, not imported.
 *
 * The real numbers are `COURSE_STAFF_EMAIL_LIMITS` in
 * `lib/email/courseFacilitatorEmails.ts`, which both send routes validate
 * against and which is therefore the boundary. That module starts with
 * `import "server-only"`, so pulling the constant into this client component
 * would fail the build rather than share a number — the same barrier every
 * other client mirror of a server limit runs into. Keep these two in sync;
 * they are checked by the route, so a drift shows up as a 400 with the route's
 * own sentence rather than as silent truncation.
 */
const SUBJECT_MAX = 150;
const BODY_MAX = 4000;

/**
 * `MAX_RECIPIENTS_PER_REQUEST` in the run email route, mirrored for one
 * SENTENCE and nothing else. Deliberately not enforced here: the route refuses
 * rather than truncates, and a client-side block would hide that refusal
 * instead of letting a facilitator meet it with an explanation attached.
 */
const RUN_RECIPIENT_CAP = 200;

/** What a completed attempt turned out to be. See the header. */
type SendOutcome =
  | { state: "pending" }
  | { state: "done"; sent: number; skipped: number }
  /** The route answered with a sentence: nothing was sent. */
  | { state: "refused"; message: string }
  /** No usable answer: some, all or none of the list may have it. */
  | { state: "unknown"; message: string };

type Attempt = {
  /** The exact text this attempt was made with — see the double-send guard. */
  signature: string;
  outcome: SendOutcome;
};

/**
 * Subject + body as one comparable string. The separator is an invisible
 * separator character, which cannot appear in either field by typing, so two
 * different (subject, body) pairs can never collide into one signature.
 */
function signatureOf(subject: string, body: string): string {
  return `${subject.trim()}\n⁣\n${body.trim()}`;
}

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

// ---------------------------------------------------------------------------
// Per-lane copy
// ---------------------------------------------------------------------------

type LaneCopy = {
  endpoint: string;
  /** "the group" / "the cohort" — the noun the shared sentences use. */
  noun: string;
  /** Count is unknown: the real send is off, and this says why. */
  blockedLine: string;
  /** How to get the count back. Null when there is no in-page retry. */
  retryHint: string | null;
  /** Count is zero. */
  emptyLine: string;
  /** Count is known and non-zero. */
  audienceLine: string;
  audienceNote: ReactNode;
  sendLabel: string;
  confirmAria: string;
  confirmTitle: string;
  confirmBody: string;
};

function laneCopy(
  runId: string,
  audience: StaffEmailAudience,
  count: number | null,
): LaneCopy {
  const runHref = `/learn/${encodeURIComponent(runId)}`;

  if (audience.kind === "group") {
    const label = audience.groupName || "this group";
    const groupHref = `${runHref}/group/${encodeURIComponent(audience.groupId)}`;
    const members =
      count === null ? "the active members" : `the ${count} active ${count === 1 ? "member" : "members"}`;
    return {
      endpoint: `/api/courses/groups/${encodeURIComponent(audience.groupId)}/email`,
      noun: "the group",
      blockedLine: `We couldn't load ${label}'s roster, so we can't tell you how many people this would reach. Sending is off until we can.`,
      retryHint: null,
      emptyLine: `No one is placed in ${label} yet, so there is nobody to email.`,
      audienceLine: `This goes to ${members} of ${label}.`,
      audienceNote: (
        <>
          One message each, signed with your name — nobody sees who else it went
          to. It is an operational message about their group, so everyone in the
          group gets it whatever their newsletter settings say. A few can still
          be skipped: an address that has bounced or been marked as spam before,
          or an account with no usable address. The report after the send says
          how many.{" "}
          <Link className={styles.inlineLink} href={groupHref}>
            See who is in the group
          </Link>
        </>
      ),
      sendLabel: count === null ? "Send to the group" : `Send to ${people(count)}`,
      confirmAria: `Send this email to ${label}`,
      confirmTitle: count === null ? "Send to the group?" : `Send to ${people(count)}?`,
      confirmBody: `This emails ${members} of ${label}, with the subject:`,
    };
  }

  const label = audience.runLabel || "this cohort";
  const upTo = count === null ? "" : ` — up to ${people(count)}`;
  return {
    endpoint: `/api/courses/runs/${encodeURIComponent(runId)}/email`,
    noun: "the cohort",
    blockedLine: `We couldn't count who is subscribed to ${label}'s cohort channel, so we can't tell you how many people this would reach. Sending is off until we can.`,
    retryHint: "Reload the page to try the count again.",
    emptyLine: `Nobody is subscribed to ${label}'s cohort channel yet, so there is nobody to email. Members are subscribed when they're placed in a group.`,
    audienceLine: `This goes to everyone subscribed to the cohort channel for ${label}${upTo}.`,
    audienceNote: (
      <>
        One message each, signed with your name — nobody sees who else it went
        to. This is an ANNOUNCEMENT: every message carries an unsubscribe link
        for this cohort, and anyone who has turned course announcements off on
        their profile is skipped — so the number who receive it can be lower
        than the number above, and the report after the send says how many.
        Bounced and spam-marked addresses are skipped too. One announcement
        reaches at most {RUN_RECIPIENT_CAP} people; past that the send is
        refused rather than trimmed. For something only one group needs — a
        moved room, this week&apos;s reading — send from that group&apos;s own
        page instead: that mail is operational and reaches everyone in the
        group.{" "}
        <Link className={styles.inlineLink} href={runHref}>
          Back to the course
        </Link>
      </>
    ),
    sendLabel: "Send to the cohort",
    confirmAria: `Send this announcement to the ${label} cohort`,
    confirmTitle: "Send to the cohort?",
    confirmBody: `This emails everyone subscribed to the cohort channel for ${label}${upTo}, with the subject:`,
  };
}

// ---------------------------------------------------------------------------
// StaffEmailComposer
// ---------------------------------------------------------------------------

export default function StaffEmailComposer({ runId, audience }: Props) {
  // Idle (empty id) on the run lane, where the count comes from the server
  // shell instead — the hook's own no-op path, not a wasted fetch.
  const roster = useGroupRoster(audience.kind === "group" ? audience.groupId : "");
  const { toast, run: runAction, dismiss } = useActionToast();

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * The last REAL send attempt — the guard. Never written by a test.
   *
   * In-memory only: a reload clears it and re-arms Send on identical text,
   * which is exactly the dropped-connection case. The durable backstop is the
   * route's own reserveSendSlot (3/hour per sender+audience), which survives a
   * reload; this guard stops the reflex re-click, not a determined one.
   */
  const [sendAttempt, setSendAttempt] = useState<Attempt | null>(null);
  const [testAttempt, setTestAttempt] = useState<Attempt | null>(null);
  /** The signature the author has explicitly cleared for a resend. */
  const [clearedForResend, setClearedForResend] = useState<string | null>(null);

  const domId = useId();
  const subjectId = `${domId}-subject`;
  const bodyId = `${domId}-body`;

  const signature = signatureOf(subject, body);
  const written = subject.trim().length > 0 && body.trim().length > 0;

  // Null is "we do not know", which is NOT zero — see the module header.
  const count = audience.kind === "group" ? roster.memberCount : audience.subscriberCount;
  const countKnown = count !== null;
  const countLoading = audience.kind === "group" ? roster.loading : false;
  const countError = audience.kind === "group" ? (roster.error?.message ?? null) : null;
  const copy = laneCopy(runId, audience, count);

  // THE GUARD. An attempt on THIS text blocks a repeat unless it was refused
  // outright (nothing went out) or explicitly cleared for a resend.
  const attempt = sendAttempt?.signature === signature ? sendAttempt : null;
  const blocking = attempt !== null && attempt.outcome.state !== "refused";
  const armed = blocking && clearedForResend !== signature;
  const resending = blocking && clearedForResend === signature;
  const canSend = written && countKnown && count > 0 && !armed && !busy;

  function send(testOnly: boolean) {
    // Frozen: the fields stay editable while the request is in flight, and the
    // attempt must be filed against the text that was actually dispatched.
    const attemptSignature = signature;
    const record = testOnly ? setTestAttempt : setSendAttempt;

    // ARM FIRST. Past this line the message may already be reaching people —
    // see the double-send guard in the module header.
    record({ signature: attemptSignature, outcome: { state: "pending" } });
    if (!testOnly) setClearedForResend(null);
    setBusy(true);

    void runAction(
      async () => {
        let res: Response;
        try {
          res = await fetch(copy.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: subject.trim(),
              body: body.trim(),
              testOnly,
            }),
          });
        } catch (err) {
          // The request never completed. The route may have dispatched none,
          // some or all of its loop before the connection died.
          const message =
            err instanceof Error ? err.message : "The request didn't complete.";
          record({
            signature: attemptSignature,
            outcome: { state: "unknown", message },
          });
          throw new Error(message);
        }

        const payload = (await res.json().catch(() => null)) as
          | { ok?: true; sent?: number; skipped?: number; error?: string }
          | null;

        if (res.ok && payload?.ok) {
          record({
            signature: attemptSignature,
            outcome: {
              state: "done",
              sent: payload.sent ?? 0,
              skipped: payload.skipped ?? 0,
            },
          });
          return;
        }

        // The route's own sentence where it gave one — a rate limit or a
        // refusal has to read as itself, not as "something went wrong". It is
        // also the evidence that nothing was sent: both routes refuse before
        // their first dispatch.
        const sentence =
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : null;
        const message = sentence ?? `That didn't go through (${res.status}).`;
        record({
          signature: attemptSignature,
          outcome: sentence
            ? { state: "refused", message }
            : { state: "unknown", message },
        });
        throw new Error(message);
      },
      {
        savingMessage: testOnly ? "Sending the test…" : "Sending…",
        // Deliberately no number in either: the toast fires before the counts
        // are on screen, and the report below is the thing that may claim them.
        successMessage: testOnly
          ? "Test sent to your own address"
          : "Sent — the report below has the numbers",
      },
    ).finally(() => setBusy(false));
  }

  return (
    <>
      <Card as="section" padding="md" className={styles.composer}>
        {/* ---- Who this reaches ------------------------------------------ */}

        <div className={styles.recipients}>
          {countLoading && !countKnown ? (
            <Skeleton width="22rem" height="1.25rem" ariaLabel="Counting who this reaches…" />
          ) : !countKnown ? (
            <>
              <p className={styles.recipientsBlocked}>{copy.blockedLine}</p>
              {countError && <p className={styles.recipientsNote}>{countError}</p>}
              {copy.retryHint ? (
                <p className={styles.recipientsNote}>{copy.retryHint}</p>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={roster.reload}
                  disabled={countLoading}
                >
                  {countLoading ? "Trying…" : "Try again"}
                </Button>
              )}
            </>
          ) : count === 0 ? (
            <p className={styles.recipientsBlocked}>{copy.emptyLine}</p>
          ) : (
            <>
              <p className={styles.recipientsLine}>{copy.audienceLine}</p>
              <p className={styles.recipientsNote}>{copy.audienceNote}</p>
            </>
          )}
        </div>

        {/* ---- The message ----------------------------------------------- */}

        <Field
          id={subjectId}
          label="Subject"
          hint={`What the message is about, as it appears in their inbox. One line, up to ${SUBJECT_MAX} characters.`}
        >
          <Input
            id={subjectId}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={SUBJECT_MAX}
            disabled={busy}
            placeholder={
              audience.kind === "group"
                ? "This week's session has moved rooms"
                : "Week 4's reading has changed"
            }
          />
        </Field>

        <Field
          id={bodyId}
          label="Message"
          hint={`Plain text — no formatting, no images. Write it the way you would write the email yourself; your name and ${copy.noun}'s name are not added for you.`}
        >
          <CountedTextarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            max={BODY_MAX}
            rows={10}
            disabled={busy}
            placeholder={
              audience.kind === "group"
                ? "Hi all — we're in B14 rather than the usual room this Tuesday. Same time."
                : "Hi all — we've swapped the week 4 reading for a shorter paper. The week page has the new link."
            }
          />
        </Field>

        {/* ---- Actions ---------------------------------------------------- */}

        <div className={styles.actions}>
          <div className={styles.testAction}>
            <Button
              variant="secondary"
              onClick={() => send(true)}
              disabled={!written || busy}
            >
              Send a test to yourself first
            </Button>
            <p className={styles.actionNote}>
              Goes to the address on your own account and nowhere else. Nobody in{" "}
              {copy.noun} sees it.
            </p>
          </div>

          <div className={styles.sendAction}>
            <Button onClick={() => setConfirming(true)} disabled={!canSend}>
              {copy.sendLabel}
            </Button>
            {/* A disabled control with no stated reason is a dead end, so the
                note always carries the why — in the order the person hits
                them. */}
            <p className={styles.actionNote}>
              {!written
                ? "Add a subject and a message first."
                : !countKnown
                  ? "Blocked until we know who this reaches: we will not ask you to confirm a number we cannot vouch for."
                  : count === 0
                    ? `There is nobody in ${copy.noun} to send to.`
                    : armed
                      ? attempt?.outcome.state === "done"
                        ? "This exact message has already gone out. Edit it to send again."
                        : attempt?.outcome.state === "unknown"
                          ? "This exact message may already have gone out. Edit it, or use the report below to send it again anyway."
                          : "This message is going out now."
                      : resending
                        ? "Resending: anyone who already received the earlier attempt will get it twice."
                        : "You will get one more chance to confirm. After that it cannot be recalled."}
            </p>
          </div>
        </div>

        {/* ---- What actually happened ------------------------------------- */}

        {/* The real send's record stays on screen after the text is edited: a
            previous version that reached people is a fact the author needs,
            and hiding it would make the edit look like an undo. */}
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
                  ? "Last send — outcome unknown"
                  : sendAttempt.outcome.state === "refused"
                    ? "Last send — refused"
                    : "Last send"}
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
                  ? `${sendAttempt.outcome.skipped} skipped: a suppressed address (one that has bounced or been marked as spam before), an account with no usable address${
                      audience.kind === "run"
                        ? ", someone who has turned course announcements off"
                        : ""
                    }, or a send that failed. Nothing reached those people — worth following up another way.`
                  : "Nobody was skipped."}{" "}
                Sending is not the same as arriving: this says what left, not what
                landed.
              </p>
            )}

            {sendAttempt.outcome.state === "refused" && (
              /* "This attempt", not "nobody has this": an earlier attempt on
                 the same text may have gone out, and the refusal says nothing
                 about it. */
              <p className={styles.reportBody}>
                This attempt sent nothing — it was refused before the first
                message went out. {sendAttempt.outcome.message}
              </p>
            )}

            {sendAttempt.outcome.state === "unknown" && (
              <>
                <p className={styles.reportBody}>
                  We didn&apos;t get an answer, so we cannot tell you what happened:
                  this message may have reached nobody, some of {copy.noun}, or all
                  of it. An error here is NOT proof that nothing was sent — the
                  route sends one message at a time and a connection that dies
                  part-way through leaves no report. {sendAttempt.outcome.message}
                </p>
                <p className={styles.reportBody}>
                  Before sending it again, find out: ask someone in {copy.noun}{" "}
                  whether it arrived, or have an admin check the send log on the
                  Deliverability tab, which lists every message that actually left.
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
                      Unblocks the Send button for this exact message. Anyone who
                      already received it will get it a second time.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {testAttempt && (
          <div className={styles.report} role="status">
            <p className={styles.reportHead}>Test send</p>
            <p className={styles.reportBody}>
              {testAttempt.outcome.state === "pending"
                ? "Going out to your own address now."
                : testAttempt.outcome.state === "done"
                  ? testAttempt.outcome.sent > 0
                    ? `Sent to your own address only. If it has not arrived in a minute or two, check your spam folder before sending it to ${copy.noun}.`
                    : "Nothing went out — your own address was skipped. That happens when it is on the suppression list (after a bounce or a spam complaint), which an admin can clear on the Deliverability tab, or when the send itself failed."
                  : `The test didn't go through: ${testAttempt.outcome.message} Nobody in ${copy.noun} was affected either way — a test only ever goes to your own address.`}
            </p>
          </div>
        )}
      </Card>

      {/* ---- The last stop ------------------------------------------------ */}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        ariaLabel={copy.confirmAria}
        width="sm"
      >
        <div className={styles.confirm}>
          <h2 className={styles.confirmTitle}>{copy.confirmTitle}</h2>
          <p className={styles.confirmBody}>{copy.confirmBody}</p>
          {/* The author's own text, rendered as a text node. */}
          <p className={styles.confirmSubject}>{subject.trim()}</p>
          {resending && (
            <p className={styles.confirmWarning}>
              This is a resend of a message whose outcome we couldn&apos;t confirm.
              Anyone who received the earlier attempt gets it twice.
            </p>
          )}
          <p className={styles.confirmNote}>
            Email cannot be recalled once it has gone. A few people can still be
            skipped — a suppressed address, or an account with no usable one — and
            the report will say how many.
          </p>
          <div className={styles.confirmActions}>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                send(false);
              }}
              disabled={!canSend}
            >
              {copy.sendLabel}
            </Button>
          </div>
        </div>
      </Modal>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

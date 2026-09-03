"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Modal from "@/components/ui/Modal";
import Skeleton from "@/components/ui/Skeleton";
import { COURSE_TZ } from "@/lib/courses/weekPlan";
import type { NudgePreviewPayload } from "@/app/api/courses/runs/[runId]/nudge/route";
import styles from "./NudgePanel.module.css";

/**
 * Send this week's nudge — the prepared reminder a cohort gets about the week
 * they are on.
 *
 * ── A PERSON SENDS THIS. THERE IS NO SCHEDULER. ─────────────────────────────
 * App Hosting gives this app no cron and a 60s request timeout, so nothing in
 * the estate can fire on a timer: every time-driven behaviour is computed at
 * read time or lazily materialised (the same constraint that made the My Work
 * task mirror a mount-time sync rather than a nightly job). A weekly nudge
 * therefore cannot nudge itself. What this surface is, and all it is, is a
 * PREPARED MESSAGE with a button: the route composes the week's subject and
 * body from the admin-edited template, this panel shows exactly what would go
 * out and to how many people, and a facilitator presses send.
 *
 * The panel says that out loud, at the top, in one sentence. It has to: a
 * surface that looks like an automation and isn't is the kind of thing a
 * cohort silently stops hearing from in week 3, with everyone assuming
 * something else was handling it.
 *
 * ── BUILT FOR A CRON THAT DOES NOT EXIST YET ────────────────────────────────
 * The send route is IDEMPOTENT PER (run, week): the first send for a cohort
 * week writes a marker, and a second call for that same week sends nothing and
 * answers `alreadySent: true`. That is what makes the human button safe today
 * — a double-click, two facilitators pressing at once, a reload-and-retry all
 * collapse to one email — and it is deliberately also what would make an
 * EXTERNAL SCHEDULER safe tomorrow. Point a Cloud Scheduler job or a GitHub
 * Action at this endpoint on a daily cron and it sends exactly once per cohort
 * week with no code change: the days it runs inside an already-nudged week are
 * no-ops. Nothing here builds that, and nothing here should — but nothing here
 * may assume a human is the only caller either, which is why this panel reads
 * the marker off the server on every load rather than remembering what it did.
 *
 * That is also why the ALREADY-SENT STATE IS SERVER TRUTH, not local state.
 * If a colleague sent it ten minutes ago, or a future scheduler did at 08:00,
 * this panel finds out the same way: `alreadySentAt` in the preview payload.
 *
 * ── WHY THE SEND GUARD IS MIRRORED FROM StaffEmailComposer, NOT EXTRACTED ───
 * The P9 composer's guard (its module header is the canonical write-up) keys
 * on a SIGNATURE OF EDITABLE TEXT — "has this exact subject+body gone out?" —
 * and every remedy it offers is phrased in those terms: edit it to send again,
 * this exact message may already have gone. Three of the four things that
 * component's guard does are text-shaped, and none of them exist here: there
 * is no editable text on this surface, the key is (run, week), and the
 * authoritative answer to "has it gone" lives in a Firestore marker rather
 * than in a React ref. Extracting would mean parameterising the signature, the
 * remedy copy and the escape hatch — i.e. everything but the state machine —
 * and handing the composer a prop bag describing its own sentences, which is
 * exactly the API its header refuses. The two guards also carry different
 * weight: over there the in-memory guard is the only thing between a
 * double-click and 400 emails; here the route refuses the second send outright
 * and this guard is a courtesy laid over a server guarantee. So the BEHAVIOUR
 * is mirrored deliberately and the classification is identical:
 *
 *   pending  — armed the instant Send is pressed, BEFORE the request leaves,
 *              because that is the instant mail may start moving.
 *   done     — it went (or the route told us it had already gone).
 *   refused  — the route answered with a sentence, which is proof nothing was
 *              sent: every refusal lands before the first dispatch. Retry is
 *              allowed.
 *   unknown  — no usable answer. Some, all or none of the cohort may have it.
 *              The guard stays armed, and the remedy is better than the
 *              composer's: reload the preview and read the marker.
 *
 * ── HONEST NUMBERS ──────────────────────────────────────────────────────────
 * `sent` and `skipped` are both reported, always. The preview's `recipients` is
 * the number after EVERY filter the route applies — opt-outs, subscribers with
 * no active enrolment, and suppressed addresses are all resolved inside
 * `resolveCohortAudience`, before the count comes back — so it is what `sent`
 * should equal. `skipped` is everyone that filtering dropped PLUS any send that
 * failed on the way out. Nothing here says "sent to everyone", because sending
 * is not arriving and this panel cannot see inboxes.
 *
 * ── A FORCED SEND IS A SEND ─────────────────────────────────────────────────
 * `alreadySent` means "a marker existed before this request", and the force path
 * returns it TRUE alongside a non-zero `sent` — the cohort has now had the nudge
 * twice, and both halves of that are true. So the report tests WHAT LEFT before
 * it tests the marker. Reading `alreadySent` first tells an admin who has
 * knowingly emailed 200 people a second time that nothing happened.
 *
 * ── NO ADDRESSES, EITHER DIRECTION ──────────────────────────────────────────
 * This component posts an empty body and receives counts and rendered copy.
 * It never sees a recipient's address, and the force path never sends a list.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  runId: string;
  /**
   * The run's own label ("Autumn 2026"), from the page's server gate — the
   * recipient sentence has to be able to name the cohort before the preview
   * has loaded.
   */
  runLabel: string;
  /**
   * From the server gate, never inferred from the payload. Gates the real send
   * and the force path: V3 made this lane the ADMIN CATCH-UP, because the
   * weekly reminder now rides a facilitator's attendance push. The route
   * re-derives it and is the real boundary: a tampered flag would reveal a
   * button that 403s, not a second send.
   */
  isAdmin: boolean;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `timeZone: COURSE_TZ` because a cohort thinks in course time: a facilitator
 * checking whether Monday's nudge went wants Monday's London clock, not their
 * own if they happen to be reading from another zone. `timeZoneName` is on so
 * the reading names the zone it is in rather than quietly implying local time.
 * Module-scoped — constructing a formatter is expensive relative to using one.
 */
const SENT_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: COURSE_TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

/** Null on an unparseable timestamp — the marker still counts, the clock doesn't. */
function sentAtLabel(iso: string): string | null {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : SENT_AT_FORMAT.format(when);
}

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/**
 * The recipient sentence's noun phrase, in words rather than as a bare number:
 * "the 18 members of Autumn 2026 who haven't opted out". The count is everyone
 * the route resolved — subscribed to the cohort channel, actively enrolled, not
 * opted out of course announcements, and not on the suppression list — which is
 * why the phrase can name the opt-out rather than hedging about it. Every filter
 * runs before this number is returned, so it is what `sent` should come back as;
 * only a send that fails in flight can move it.
 */
function audiencePhrase(count: number, label: string): string {
  return count === 1
    ? `the one member of ${label} who hasn't opted out`
    : `the ${count} members of ${label} who haven't opted out`;
}

// ---------------------------------------------------------------------------
// The preview fetch
// ---------------------------------------------------------------------------

/**
 * `GET /api/courses/runs/[runId]/nudge` — which week the cohort is on, the
 * rendered subject and body, how many people it reaches, when the session is,
 * and whether this week's nudge has already gone.
 *
 * One-shot with a manual refresh, the `useRunOverview` idiom. Nothing here is
 * live: a cohort's week does not roll while someone reads the page, and the
 * one fact that CAN change underneath — the marker, if a colleague or a future
 * scheduler sends first — is re-read after every send attempt, which is when it
 * matters. The week is recomputed server-side per request; this client never
 * sends a week number and the route would not trust one.
 */
type PreviewState = {
  data: NudgePreviewPayload | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

function useNudgePreview(runId: string): PreviewState {
  const [data, setData] = useState<NudgePreviewPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const [settledNonce, setSettledNonce] = useState(-1);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/nudge`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (NudgePreviewPayload & { error?: string })
          | null;
        if (!res.ok || !body) {
          throw new Error(
            body?.error ?? `Couldn't load this week's nudge (${res.status}).`,
          );
        }
        return body;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setSettledNonce(nonce);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading: settledNonce !== nonce, error, reload };
}

// ---------------------------------------------------------------------------
// The attempt guard — see the module header
// ---------------------------------------------------------------------------

type SendOutcome =
  | { state: "pending" }
  | {
      state: "done";
      sent: number;
      skipped: number;
      /** The route found this week already nudged and stopped. Nothing went out. */
      alreadySent: boolean;
      /** The week the ROUTE decided on, which may not be the previewed one. */
      weekNumber: number | null;
    }
  /** The route answered with a sentence: nothing was sent. */
  | { state: "refused"; message: string }
  /** No usable answer: some, all or none of the cohort may have it. */
  | { state: "unknown"; message: string };

type Attempt = {
  /** The cohort week this attempt was filed against — the guard's key. */
  weekKey: string;
  /** Whether it went through the admin force path. */
  forced: boolean;
  outcome: SendOutcome;
};

type SendMode = "test" | "real" | "force";

// ---------------------------------------------------------------------------
// NudgePanel
// ---------------------------------------------------------------------------

export default function NudgePanel({ runId, runLabel, isAdmin }: Props) {
  const preview = useNudgePreview(runId);
  const { toast, run: runAction, dismiss } = useActionToast();

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"real" | "force" | null>(null);
  /** The last REAL send attempt (forced or not). Never written by a test. */
  const [sendAttempt, setSendAttempt] = useState<Attempt | null>(null);
  /**
   * Test attempts are recorded separately and deliberately: proofing a message
   * must never look like sending it, and a test must never clear the guard on
   * a real send that has already happened.
   */
  const [testAttempt, setTestAttempt] = useState<Attempt | null>(null);

  const payload = preview.data;
  const week = payload?.week ?? null;
  const recipients = payload?.recipients ?? 0;
  const alreadySentAt = payload?.alreadySentAt ?? null;
  const alreadySent = alreadySentAt !== null;
  const sentWhen = alreadySentAt ? sentAtLabel(alreadySentAt) : null;

  // The guard's key. A week that doesn't exist can't be sent, so the sentinel
  // never matches a real attempt.
  const weekKey = week ? `w${week.weekNumber}` : "none";
  const attempt = sendAttempt?.weekKey === weekKey ? sendAttempt : null;
  const blocking = attempt !== null && attempt.outcome.state !== "refused";

  const endpoint = `/api/courses/runs/${encodeURIComponent(runId)}/nudge`;
  const runHome = `/learn/${encodeURIComponent(runId)}`;

  const sendable = week !== null && recipients > 0;
  // V3: the weekly reminder is sent by a facilitator pushing their register,
  // per group. This lane is the ADMIN CATCH-UP (the session-1 welcome, and
  // recovery when a push failed to mail its group), so the real send is
  // admin-only and the route re-checks. A run facilitator keeps the preview
  // and the test send, which reach nobody but themselves.
  const canSend = isAdmin && sendable && !alreadySent && !blocking && !busy;
  // Only where the ordinary send is closed — otherwise the force path is noise
  // pointed at a loaded gun. Admins only, and the route re-checks.
  const showForce = isAdmin && week !== null && (alreadySent || blocking);
  const forcedAlready = attempt?.forced === true && attempt.outcome.state === "done";

  function send(mode: SendMode) {
    const testOnly = mode === "test";
    const forced = mode === "force";
    // Frozen: the preview can refresh under a request in flight, and the
    // attempt has to be filed against the week it was actually made for.
    const key = weekKey;
    const record = testOnly ? setTestAttempt : setSendAttempt;

    // ARM FIRST. Past this line mail may already be moving.
    record({ weekKey: key, forced, outcome: { state: "pending" } });
    setBusy(true);

    void runAction(
      async () => {
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            // The week is deliberately NOT in the body: the route recomputes it
            // server-side and would not trust a client's number.
            body: JSON.stringify(
              testOnly ? { testOnly: true } : forced ? { force: true } : {},
            ),
          });
        } catch (err) {
          // The request never completed. The route may have dispatched none,
          // some or all of its loop before the connection died.
          const message =
            err instanceof Error ? err.message : "The request didn't complete.";
          record({ weekKey: key, forced, outcome: { state: "unknown", message } });
          throw new Error(message);
        }

        const body = (await res.json().catch(() => null)) as
          | {
              ok?: true;
              weekNumber?: number | null;
              sent?: number;
              skipped?: number;
              alreadySent?: boolean;
              error?: string;
            }
          | null;

        if (res.ok && body?.ok) {
          record({
            weekKey: key,
            forced,
            outcome: {
              state: "done",
              sent: body.sent ?? 0,
              skipped: body.skipped ?? 0,
              alreadySent: body.alreadySent === true,
              weekNumber: body.weekNumber ?? null,
            },
          });
          // Converge on the server's marker rather than assuming it now says
          // what we just did — the same read that would show a scheduler's or a
          // colleague's send. A test writes no marker, so it needs no refresh.
          if (!testOnly) preview.reload();
          return;
        }

        // The route's own sentence where it gave one — a rate limit or a
        // refusal has to read as itself. It is also the evidence that nothing
        // was sent: refusals land before the first dispatch.
        const sentence =
          typeof body?.error === "string" && body.error.trim()
            ? body.error.trim()
            : null;
        const message = sentence ?? `That didn't go through (${res.status}).`;
        record({
          weekKey: key,
          forced,
          outcome: sentence
            ? { state: "refused", message }
            : { state: "unknown", message },
        });
        throw new Error(message);
      },
      {
        savingMessage: testOnly ? "Sending the test…" : "Sending the nudge…",
        // Deliberately not "Sent": a real send can legitimately come back
        // having sent nothing (the week was already nudged), and the toast
        // fires before the report is on screen to say which happened.
        successMessage: testOnly
          ? "Test sent to your own address"
          : "Done — the report below says what happened",
      },
    ).finally(() => setBusy(false));
  }

  // -------------------------------------------------------------------------
  // Loading / failed-to-load
  // -------------------------------------------------------------------------

  if (!payload) {
    if (preview.error) {
      return (
        <Card as="section" padding="md" className={styles.panel}>
          <EmptyState
            title="Couldn't load this week's nudge"
            body={preview.error.message}
            action={<Button onClick={preview.reload}>Try again</Button>}
          />
        </Card>
      );
    }
    return (
      <Card as="section" padding="md" className={styles.panel}>
        <div className={styles.loading}>
          <Skeleton width="18rem" height="1.5rem" ariaLabel="Loading this week's nudge…" />
          <Skeleton width="26rem" height="1.25rem" ariaLabel="" />
          <Skeleton width="100%" height="11rem" radius="var(--radius-md)" ariaLabel="" />
          <Skeleton width="14rem" height="2.75rem" ariaLabel="" />
        </div>
      </Card>
    );
  }

  const blockReason = !week
    ? "There's no week to nudge about right now, so there's nothing to send."
    : recipients === 0
      ? `Nobody on ${runLabel} is set to receive this, so there's nothing to send.`
      : attempt?.outcome.state === "pending"
        ? "This week's nudge is going out now."
        : alreadySent
          ? "This week's nudge has already gone out."
          : attempt?.outcome.state === "done"
            ? "You've just sent it — the report below has the numbers."
            : attempt?.outcome.state === "unknown"
              ? "We couldn't confirm what happened to the last attempt. Reload the preview and read the marker before trying again."
              : null;

  return (
    <>
      <Card as="section" padding="md" className={styles.panel}>
        {/* ---- Who sends this, and when --------------------------------- */}

        <p className={styles.byline}>
          Nothing sends this on a schedule: this week&apos;s nudge goes out when a
          person presses the button on this page.
        </p>

        {/* ---- Which week ----------------------------------------------- */}

        {week ? (
          <div className={styles.week}>
            <p className={styles.weekEyebrow}>
              Week {week.weekNumber}
              {week.title ? ` · ${week.title}` : ""}
            </p>
            {week.summary && <p className={styles.weekSummary}>{week.summary}</p>}
          </div>
        ) : (
          <div className={styles.week}>
            <p className={styles.weekEyebrow}>No week to nudge about</p>
            <p className={styles.weekSummary}>
              The cohort isn&apos;t on a taught week right now — it hasn&apos;t
              started, it&apos;s on a break, or it has finished. A nudge names a
              week&apos;s work, so there is nothing to send until the next taught
              week begins.{" "}
              <Link className={styles.inlineLink} href={runHome}>
                Back to the course
              </Link>
            </p>
          </div>
        )}

        {/* ---- Who this reaches ------------------------------------------ */}

        {week && (
          <div className={styles.recipients}>
            {recipients === 0 ? (
              <p className={styles.recipientsBlocked}>
                Nobody on {runLabel} is set to receive this week&apos;s nudge.
                Either no one is subscribed to the cohort channel yet — members
                are subscribed when they&apos;re placed in a group — or everyone
                who is has turned course announcements off.
              </p>
            ) : (
              <>
                <p className={styles.recipientsLine}>
                  This reaches {audiencePhrase(recipients, runLabel)}.
                </p>
                <p className={styles.recipientsNote}>
                  One message each — nobody sees who else it went to — and every
                  message carries an unsubscribe link for this cohort. This count
                  is already the final one: anyone who has turned course
                  announcements off, anyone no longer enrolled, and any address
                  that has bounced or been marked as spam is out of it. Only a
                  send that fails on the way out can still move the number, and
                  the report afterwards says how many did.
                </p>
              </>
            )}
          </div>
        )}

        {/* ---- When the session is --------------------------------------- */}

        {week && (
          <div className={styles.meta}>
            <p className={styles.metaLabel}>The session it points at</p>
            <p className={styles.metaValue}>
              {payload.sessionLine ?? (
                <span className={styles.metaMissing}>
                  No session time for this week, so the nudge won&apos;t name one.
                  Set the group&apos;s slot if it should.
                </span>
              )}
            </p>
          </div>
        )}

        {/* ---- What actually goes out ------------------------------------ */}

        {week && (payload.subjectPreview || payload.bodyPreview) && (
          <div className={styles.letter}>
            <p className={styles.letterLabel}>What they receive</p>
            <p className={styles.letterSubject}>{payload.subjectPreview}</p>
            {/* Server-rendered text, rendered as a text node. `pre-wrap` in the
                stylesheet keeps the template's own line breaks. */}
            <p className={styles.letterBody}>{payload.bodyPreview}</p>
            <p className={styles.letterNote}>
              The wording comes from the course email template, not from this
              page — there is nothing to type here, which is the point: the same
              message goes out every week, prepared the same way.
              {isAdmin && (
                <>
                  {" "}
                  <Link
                    className={styles.inlineLink}
                    href="/admin/email-designs/course/course-week-nudge"
                  >
                    Edit the nudge template
                  </Link>
                </>
              )}
            </p>
          </div>
        )}

        {/* ---- Already sent ---------------------------------------------- */}

        {week && alreadySent && (
          <div className={styles.marker}>
            <p className={styles.markerHead}>Already sent this week</p>
            <p className={styles.markerBody}>
              Week {week.weekNumber}&apos;s nudge{" "}
              {sentWhen ? `went out on ${sentWhen}` : "has already gone out"}. It
              may have been you, another facilitator, or an admin — the record is
              per cohort week, not per person. Sending is off because the route
              keeps one nudge per week: pressing it again would send nothing.
            </p>
          </div>
        )}

        {/* ---- Actions ---------------------------------------------------- */}

        <div className={styles.actions}>
          <div className={styles.testAction}>
            <Button
              variant="secondary"
              onClick={() => send("test")}
              disabled={!week || busy}
            >
              Send a test to yourself first
            </Button>
            <p className={styles.actionNote}>
              Goes to the address on your own account and nowhere else. It
              doesn&apos;t count as this week&apos;s nudge and nobody on the
              cohort sees it.
            </p>
          </div>

          <div className={styles.sendAction}>
            <Button onClick={() => setConfirming("real")} disabled={!canSend}>
              {sendable ? `Send to ${people(recipients)}` : "Send this week's nudge"}
            </Button>
            {/* A disabled control with no stated reason is a dead end, so the
                note always carries the why — in the order you meet them. */}
            <p className={styles.actionNote}>
              {!isAdmin
                ? "The weekly reminder goes out when a facilitator pushes their group's register. An admin sends this run-wide catch-up: the welcome before the first session, or a re-send when a push didn't reach a group."
                : (blockReason ??
                  "You'll get one more chance to confirm. After that it cannot be recalled.")}
            </p>
          </div>
        </div>

        {/* ---- The admin override ----------------------------------------- */}

        {showForce && (
          <div className={styles.forceAction}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirming("force")}
              disabled={!sendable || busy || attempt?.outcome.state === "pending"}
            >
              Send it again anyway
            </Button>
            <p className={styles.actionNote}>
              Admins only. This overrides the once-a-week record and emails{" "}
              {audiencePhrase(recipients, runLabel)} a second time — nobody is
              told it is a duplicate.
              {forcedAlready
                ? " You have already forced this week's nudge; a further send would be a third copy."
                : ""}
            </p>
          </div>
        )}

        {/* ---- What actually happened -------------------------------------- */}

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
                    : sendAttempt.forced
                      ? "Last send — forced"
                      : "Last send"}
            </p>

            {sendAttempt.outcome.state === "pending" && (
              <p className={styles.reportBody}>
                Going out now, one message at a time. The numbers appear here when
                the route answers.
              </p>
            )}

            {sendAttempt.outcome.state === "done" && (
              <>
                {/* WHAT LEFT IS TESTED FIRST. A forced send comes back with
                    `alreadySent: true` AND a non-zero `sent` — see the module
                    header — so branching on the marker would report the one
                    moment in this feature that most needs reporting, an admin
                    knowingly emailing a cohort twice, as "Nothing was sent." */}
                {sendAttempt.outcome.sent === 0 && sendAttempt.outcome.alreadySent ? (
                  <p className={styles.reportBody}>
                    Nothing was sent. The route found this week&apos;s nudge
                    already recorded and stopped rather than sending a second
                    copy — which is exactly what it is meant to do. Whoever sent
                    it first got there before you.
                  </p>
                ) : (
                  <>
                    {sendAttempt.outcome.alreadySent && (
                      <p className={styles.reportBody}>
                        This was a SECOND copy. Everyone counted below had
                        already received this week&apos;s nudge, and nothing in
                        the message they just got tells them so.
                      </p>
                    )}
                    <p className={styles.reportBody}>
                      Sent to {people(sendAttempt.outcome.sent)}.{" "}
                      {sendAttempt.outcome.skipped > 0
                        ? `${sendAttempt.outcome.skipped} skipped: someone who has turned course announcements off or is no longer enrolled, a suppressed address (one that has bounced or been marked as spam before), or a send that failed. Nothing reached those people.`
                        : "Nobody was skipped."}{" "}
                      Sending is not the same as arriving: this says what left,
                      not what landed.
                    </p>
                  </>
                )}
                {sendAttempt.outcome.weekNumber === null &&
                  sendAttempt.outcome.sent === 0 &&
                  !sendAttempt.outcome.alreadySent && (
                    <p className={styles.reportBody}>
                      The route found no taught week to nudge about by the time it
                      ran, so nothing went out.
                    </p>
                  )}
                {sendAttempt.outcome.weekNumber !== null &&
                  week !== null &&
                  sendAttempt.outcome.weekNumber !== week.weekNumber && (
                    <p className={styles.reportBody}>
                      This went out as week {sendAttempt.outcome.weekNumber}
                      &apos;s nudge, not week {week.weekNumber}&apos;s — the
                      cohort rolled over between this page loading and the send.
                      The route recomputes the week itself, which is why it landed
                      on the right one.
                    </p>
                  )}
              </>
            )}

            {sendAttempt.outcome.state === "refused" && (
              /* "This attempt", not "nobody has this": an earlier attempt on the
                 same week may have gone out, and the refusal says nothing about
                 it. The marker above does. */
              <p className={styles.reportBody}>
                This attempt sent nothing — it was refused before the first
                message went out. {sendAttempt.outcome.message}
              </p>
            )}

            {sendAttempt.outcome.state === "unknown" && (
              <>
                <p className={styles.reportBody}>
                  We didn&apos;t get an answer, so we cannot tell you what
                  happened: this may have reached nobody, some of the cohort, or
                  all of it. An error here is NOT proof that nothing was sent —
                  the route sends one message at a time and a connection that dies
                  part-way through leaves no report.{" "}
                  {sendAttempt.outcome.message}
                </p>
                <p className={styles.reportBody}>
                  The record is the thing to read, not this box. Reload the
                  preview: if it then says this week&apos;s nudge has gone, the
                  send got far enough to record itself and nobody should send
                  again. If it still says nothing has gone, an admin can check the
                  send log on the Deliverability tab, which lists every message
                  that actually left.
                </p>
                <div className={styles.reportActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={preview.reload}
                    disabled={preview.loading}
                  >
                    {preview.loading ? "Checking…" : "Check the record again"}
                  </Button>
                </div>
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
                  ? testAttempt.outcome.alreadySent
                    ? "Nothing went out: the route reports this week's nudge as already sent. The cohort is unaffected either way."
                    : testAttempt.outcome.sent > 0
                      ? "Sent to your own address only. If it hasn't arrived in a minute or two, check your spam folder before sending it to the cohort."
                      : "Nothing went out — your own address was skipped. That happens when it is on the suppression list (after a bounce or a spam complaint), which an admin can clear on the Deliverability tab, or when the send itself failed."
                  : `The test didn't go through: ${testAttempt.outcome.message} Nobody on the cohort was affected either way — a test only ever goes to your own address.`}
            </p>
          </div>
        )}
      </Card>

      {/* ---- The last stop ------------------------------------------------ */}

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        ariaLabel={
          confirming === "force"
            ? `Send this week's nudge to the ${runLabel} cohort a second time`
            : `Send this week's nudge to the ${runLabel} cohort`
        }
        width="sm"
      >
        <div className={styles.confirm}>
          {confirming === "force" ? (
            <>
              <h2 className={styles.confirmTitle}>
                Send {week ? `week ${week.weekNumber}'s` : "this week's"} nudge a
                second time?
              </h2>
              <p className={styles.confirmBody}>
                {sentWhen
                  ? `This week's nudge already went out on ${sentWhen}.`
                  : "This week's nudge has already gone out."}{" "}
                Sending again emails {audiencePhrase(recipients, runLabel)} the
                same message a second time, with the subject:
              </p>
              <p className={styles.confirmSubject}>{payload.subjectPreview}</p>
              <p className={styles.confirmWarning}>
                Everyone who received the first one gets it twice, and nothing in
                the message tells them it is a duplicate. Do this only when you
                know the first send failed to reach people — the record above says
                it did reach them.
              </p>
            </>
          ) : (
            <>
              <h2 className={styles.confirmTitle}>
                Send to {people(recipients)}?
              </h2>
              <p className={styles.confirmBody}>
                This emails {audiencePhrase(recipients, runLabel)}
                {week ? ` about week ${week.weekNumber}` : ""}, with the subject:
              </p>
              <p className={styles.confirmSubject}>{payload.subjectPreview}</p>
            </>
          )}
          <p className={styles.confirmNote}>
            Email cannot be recalled once it has gone. A few people can still be
            skipped — a suppressed address, or a send that fails — and the report
            will say how many.
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const mode = confirming;
                setConfirming(null);
                if (mode) send(mode);
              }}
              disabled={
                busy ||
                !sendable ||
                (confirming === "real" ? !canSend : !showForce)
              }
            >
              {confirming === "force"
                ? "Send it again anyway"
                : `Send to ${people(recipients)}`}
            </Button>
          </div>
        </div>
      </Modal>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

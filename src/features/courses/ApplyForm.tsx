"use client";

import { useState } from "react";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import FormRenderer from "@/features/events/FormRenderer";
import { useSiteNotice } from "@/features/maintenance/useSiteNotice";
import { SurfacePausedNotice } from "@/features/maintenance/SurfacePausedNotice";
import { isSurfacePaused } from "@/lib/siteNotice";
import { validateAnswers } from "@/lib/events/validateAnswers";
import type { FormQuestion, RsvpAnswer } from "@/lib/firestore/events";
import type { CourseApplicationStatus } from "@/lib/firestore/courseApplications";
import type { ApplicationWindowState } from "@/lib/courses/window";
import { useMyApplication } from "./useMyApplication";
import styles from "./ApplyForm.module.css";

/**
 * The applicant's whole lifecycle for one course run: apply → track → edit →
 * withdraw. A client island on an otherwise server-rendered page, because all
 * four of those states are personal to the viewer.
 *
 * Every write goes to `/api/courses/runs/[runId]/apply` (POST / PATCH /
 * DELETE) — `courseApplications` is `allow write: if false`, so there is no
 * client-direct path even in principle. Nothing here is a gate: the route
 * re-checks the window, the cap, the pause flag, the cooldown and the caller's
 * role on every call. What this component owes the applicant is an honest
 * account of what happened, which is why route errors are surfaced verbatim
 * rather than flattened into "something went wrong".
 *
 * Two deliberate absences:
 *  - No facilitator picker. Applicants don't choose who teaches them;
 *    admissions records preferences later (`facilitatorPreferenceUids` is
 *    written by the review flow, never by this form).
 *  - No paid-membership anything. The tag is a badge for reviewers and is
 *    snapshotted server-side at submit; it never appears on a member surface
 *    and never branches a route.
 */

/**
 * Structural mirror of `ApplyGroupOption` in `fetchCourses.ts`. Declared here
 * rather than imported because that module is `server-only` — the call site in
 * the page type-checks the two against each other, so they cannot drift.
 */
type GroupOption = {
  id: string;
  name: string;
  /** e.g. "Tuesdays 18:00–19:30". */
  sessionLabel: string;
};

/**
 * The run's application window, computed server-side by the ONE predicate the
 * apply route also uses, with its dates already formatted in Europe/London.
 *
 * Pre-formatted on purpose: this is a client island, and formatting a
 * Nottingham deadline in the visitor's own timezone is how someone reads
 * "closes Sat 17 Oct" and applies a day late.
 */
export type ApplyWindow = {
  state: ApplicationWindowState;
  /** "Mon 21 Sep", or null when the window has no opening bound. */
  opensOn: string | null;
  /** "Sun 18 Oct, 23:59", or null when there is no deadline. */
  closesOn: string | null;
  /** "Mon 26 Oct", or null when the run has no start date authored yet. */
  startsOn: string | null;
};

type Props = {
  runId: string;
  courseId: string;
  /** The run's `applicationForm`, rendered by the shared events machinery. */
  questions: FormQuestion[];
  /** Session times to offer as availability chips; empty hides the section. */
  groups: GroupOption[];
  /** Who they're applying as, echoed back so a shared device is obvious. */
  userDisplayName: string;
  /**
   * Whether the run is taking applications. Only `open` renders the blank
   * form; every other state renders the applicant's OWN status card if they
   * hold a row, and a dated "closed" card if they don't. That split has to
   * live in this component rather than on the page, because whether a row
   * exists is a client-side own-row read the server never makes.
   */
  runWindow: ApplyWindow;
};

const STATUS_BADGE: Record<
  CourseApplicationStatus,
  { tone: "neutral" | "accent" | "success" | "danger" | "warning"; label: string }
> = {
  pending: { tone: "accent", label: "Application received" },
  accepted: { tone: "success", label: "Accepted" },
  waitlisted: { tone: "warning", label: "Waitlisted" },
  // Badge has no separate "quiet danger" tone; the copy does the softening.
  rejected: { tone: "danger", label: "Not this time" },
  withdrawn: { tone: "neutral", label: "Withdrawn" },
};

const STATUS_BLURB: Record<CourseApplicationStatus, string> = {
  pending:
    "Thanks — it's with the admissions team. They read every application, and you'll get an email when there's a decision. You can change your answers or withdraw until then.",
  accepted:
    "You're in. We'll email you your group and the first session time once places are allocated.",
  waitlisted:
    "You're on the waitlist. If a place opens up we'll email you — you don't need to do anything.",
  rejected:
    "We weren't able to offer you a place on this run. It's not a judgement on you, and you're very welcome to apply to a future run.",
  withdrawn:
    "You withdrew this application, so it's no longer being considered. If that was a mistake, email the team and they can reopen it.",
};

/** Mirrors the apply route's cap on posted availability entries. */
const MAX_AVAILABILITY_CHOICES = 20;

/** Whether a status still admits self-serve edits. Only `pending` does. */
function isEditable(status: CourseApplicationStatus): boolean {
  return status === "pending";
}

/**
 * Stringify one stored answer for the read-only summary. Member-authored text
 * — returned as a plain string and rendered as a TEXT NODE by React, never
 * `dangerouslySetInnerHTML`. That is the XSS boundary for this surface.
 */
function renderAnswer(a: RsvpAnswer | undefined): string {
  if (a === undefined || a === null) return "";
  if (typeof a === "string") return a;
  if (typeof a === "boolean") return a ? "Yes" : "No";
  if (Array.isArray(a)) return a.join(", ");
  if (typeof a === "object") {
    const obj = a as { checked?: string[]; other?: string };
    const parts: string[] = [];
    if (Array.isArray(obj.checked) && obj.checked.length > 0) parts.push(...obj.checked);
    if (obj.other) parts.push(`Other: ${obj.other}`);
    return parts.join(", ");
  }
  return "";
}

/** "3 September 2026, 18:04" — client-only render, so no SSR skew. */
function formatWhen(date: Date | null | undefined): string {
  if (!date) return "";
  return date.toLocaleString([], {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Which chips to re-tick when re-opening a submitted application. Availability
 * is stored as member-authored text (the route owns the exact encoding), so
 * this matches by containment rather than assuming a separator — a label that
 * isn't found simply starts unticked, which is recoverable; a crash is not.
 */
function preselect(stored: string, options: string[]): string[] {
  if (!stored) return [];
  return options.filter((option) => stored.includes(option));
}

/** What the route said. `conflict` and `ok` both end with a fresh read. */
type CallResult =
  | { kind: "ok" }
  | { kind: "conflict"; message: string }
  | { kind: "cooldown"; message: string }
  | { kind: "paused"; message: string }
  | { kind: "failed"; message: string };

export default function ApplyForm({
  runId,
  courseId,
  questions,
  groups,
  userDisplayName,
  runWindow,
}: Props) {
  const { application, loading, reload } = useMyApplication(runId);
  const { toast, run, dismiss } = useActionToast();
  const [answers, setAnswers] = useState<Record<string, RsvpAnswer>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pausedMessage, setPausedMessage] = useState<string | null>(null);

  // Maintenance notice: a paused `courseApplications` surface disables the
  // submit with the explanation inline, exactly as RsvpForm does for event
  // signups. This is UX, never enforcement — the route re-reads the flag and
  // 503s regardless, which is what the `pausedMessage` path below renders when
  // the server knows about a pause this client's listener hasn't caught yet.
  const siteNotice = useSiteNotice();
  const paused = isSurfacePaused(siteNotice, "courseApplications");

  // Two groups can share a slot ("Tuesdays 18:00–19:30" twice). The applicant
  // is telling us when they're FREE, not which group they want, so identical
  // times collapse to one chip. Capped so the form can never compose a payload
  // the route refuses — see MAX_AVAILABILITY_CHOICES in the apply route, which
  // is the authority; a run with more distinct slots than this doesn't exist.
  const timeOptions = Array.from(new Set(groups.map((g) => g.sessionLabel))).slice(
    0,
    MAX_AVAILABILITY_CHOICES,
  );
  const busy = toast?.phase === "saving";

  async function callRoute(
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<CallResult> {
    const res = await fetch(`/api/courses/runs/${encodeURIComponent(runId)}/apply`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { ok?: true; error?: string }
      | null;
    if (res.ok && payload?.ok) return { kind: "ok" };
    const message = payload?.error ?? `That didn't go through (${res.status}).`;
    if (res.status === 409) return { kind: "conflict", message };
    if (res.status === 429) return { kind: "cooldown", message };
    if (res.status === 503) return { kind: "paused", message };
    return { kind: "failed", message };
  }

  /**
   * One call, one toast, one settle. Every lifecycle action lands here so the
   * three failure modes the route distinguishes stay distinguishable in the
   * UI: a cooldown and a pause both leave a PERSISTENT explanation behind
   * (the toast is transient and dismissible), while anything else is just the
   * toast carrying the route's own sentence.
   */
  async function callAndSettle(
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    messages: { saving: string; success: string; fallback: string },
  ) {
    // A box, not a bare `let`: the assignment happens inside the toast's
    // callback, and reading a captured `let` back afterwards is exactly the
    // shape TypeScript's control-flow analysis gives up on.
    const outcome = {
      result: { kind: "failed", message: messages.fallback } as CallResult,
    };
    await run(
      async () => {
        outcome.result = await callRoute(method, body);
        // Throwing hands the route's own sentence to the toast, so the
        // immediate feedback and the persistent inline copy agree.
        if (outcome.result.kind !== "ok") throw new Error(outcome.result.message);
      },
      { savingMessage: messages.saving, successMessage: messages.success },
    );
    const result = outcome.result;
    if (result.kind === "cooldown") setInlineError(result.message);
    if (result.kind === "paused") setPausedMessage(result.message);
    // A 409 means a row already exists that this browser hadn't seen (a second
    // tab, or a denied own-row read) — reloading turns a dead end into the
    // status card rather than leaving them re-typing into a form.
    if (result.kind === "ok" || result.kind === "conflict") {
      setEditing(false);
      reload();
    }
  }

  async function submit(method: "POST" | "PATCH") {
    setInlineError(null);
    setPausedMessage(null);
    if (paused) {
      // Belt and braces behind the disabled submit — never a silent block.
      setInlineError(siteNotice.bannerMessage);
      return;
    }
    // Pre-flight only. The route runs this same `validateAnswers` against the
    // run's live form and is the actual boundary; doing it here saves a round
    // trip and names the offending question.
    const check = validateAnswers(questions, answers);
    if ("error" in check) {
      setInlineError(check.error);
      return;
    }
    await callAndSettle(
      method,
      // Availability always ships, empty included: on an edit, unticking every
      // chip has to mean "none of those work" rather than "leave it as it was".
      { answers, availability: selected },
      {
        saving: method === "POST" ? "Submitting…" : "Saving changes…",
        success: method === "POST" ? "Application submitted" : "Changes saved",
        fallback: "Not saved.",
      },
    );
  }

  async function withdraw() {
    if (
      !window.confirm(
        "Withdraw your application? It stops being considered, and you can't re-apply to this run from here.",
      )
    ) {
      return;
    }
    setInlineError(null);
    setPausedMessage(null);
    await callAndSettle("DELETE", undefined, {
      saving: "Withdrawing…",
      success: "Application withdrawn",
      fallback: "Not withdrawn.",
    });
  }

  function startEdit() {
    setAnswers(application?.answers ?? {});
    setSelected(preselect(application?.availability ?? "", timeOptions));
    setInlineError(null);
    setPausedMessage(null);
    setEditing(true);
  }

  function toggleTime(label: string, on: boolean) {
    setSelected((current) =>
      on ? [...current, label] : current.filter((v) => v !== label),
    );
  }

  if (loading) {
    return (
      <Card padding="lg" className={styles.card}>
        <p className={styles.muted}>Checking your application…</p>
      </Card>
    );
  }

  // ---- Submitted: the status card ----
  if (application && !editing) {
    const badge = STATUS_BADGE[application.status];
    const editable = isEditable(application.status);
    const answered = questions
      .map((q) => ({
        id: q.id,
        label: q.label,
        value: renderAnswer(application.answers[q.id]),
      }))
      .filter((row) => row.value !== "");

    return (
      <>
        <Card padding="lg" className={styles.card}>
          <div className={styles.statusHead}>
            <h2 className={styles.h2}>Your application</h2>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className={styles.blurb}>{STATUS_BLURB[application.status]}</p>
          {/* The deadline, restated on the card, because this is the surface
              someone opens in the fortnight between applying and hearing
              back. It used to be unreachable in exactly that fortnight: the
              page needed a run still in `applications-open` to render at all,
              which is the state admissions moves OFF the day they close. */}
          {editable && runWindow.state === "closed" ? (
            <p className={styles.note}>
              {runWindow.closesOn
                ? `Applications closed on ${runWindow.closesOn}.`
                : "Applications for this run have closed."}{" "}
              Yours is still in the queue, and you can keep editing it until
              the team reviews it.
            </p>
          ) : null}

          {application.createdAt ? (
            <p className={styles.timestamp}>
              Submitted {formatWhen(application.createdAt)}
              {/* Both stamps are written together at create, so "edited" only
                  shows once an actual edit has moved them apart. */}
              {application.updatedAt &&
              application.updatedAt.getTime() - application.createdAt.getTime() > 1000
                ? ` · last edited ${formatWhen(application.updatedAt)}`
                : ""}
            </p>
          ) : null}

          {answered.length > 0 || application.availability ? (
            <dl className={styles.summary}>
              {/* Answers to questions the run has since removed simply drop
                  out — there's no label left to show them under. */}
              {answered.map((row) => (
                <div key={row.id} className={styles.summaryRow}>
                  <dt className={styles.summaryLabel}>{row.label}</dt>
                  <dd className={styles.summaryValue}>{row.value}</dd>
                </div>
              ))}
              {application.availability ? (
                <div className={styles.summaryRow}>
                  <dt className={styles.summaryLabel}>Times you can make</dt>
                  <dd className={styles.summaryValue}>{application.availability}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {inlineError ? <p className={styles.error}>{inlineError}</p> : null}
          {pausedMessage ? <PausedNotice message={pausedMessage} /> : null}
          {editable && paused ? (
            <div className={styles.pausedSlot}>
              <SurfacePausedNotice notice={siteNotice} surface="courseApplications" />
            </div>
          ) : null}

          {editable ? (
            <div className={styles.actions}>
              <Button onClick={startEdit} disabled={busy || paused}>
                Edit your answers
              </Button>
              {/* Withdraw stays live through a pause, on the same reasoning
                  the RSVP cancel flow does: stranding someone trying to free
                  up a place helps nobody. If the route disagrees it 503s, and
                  its message lands inline above. */}
              <Button variant="ghost" onClick={withdraw} disabled={busy}>
                Withdraw
              </Button>
            </div>
          ) : application.status === "withdrawn" ? null : (
            // Decided states get no self-serve actions: undoing a decision is
            // admissions' call, and a button implying otherwise would be a lie.
            <p className={styles.note}>
              Decisions are handled by the admissions team — check your email, and
              reply to it if you need to talk to someone.
            </p>
          )}

          <p className={styles.note}>
            <Link href={`/courses/${courseId}`} className={styles.inlineLink}>
              Read the curriculum again
            </Link>
          </p>
        </Card>
        <ActionToast toast={toast} onDismiss={dismiss} />
      </>
    );
  }

  // ---- No application, and the window isn't open: the dated card ----
  //
  // Reached only AFTER the own-row read has settled, which is the whole
  // point: someone who already applied gets their status card above, in every
  // window state. Only a visitor with no row lands here.
  if (!application && runWindow.state !== "open") {
    const notYet = runWindow.state === "not-yet";
    return (
      <Card padding="lg" className={styles.card}>
        <h2 className={styles.h2}>
          {notYet ? "Applications aren't open yet" : "Applications have closed"}
        </h2>
        <p className={styles.blurb}>
          {notYet
            ? runWindow.opensOn
              ? `Applications open on ${runWindow.opensOn}. The curriculum is up already, so you can read the whole thing before you decide.`
              : "Applications open shortly. The curriculum is up already, so you can read the whole thing before you decide."
            : runWindow.closesOn
              ? `Applications closed on ${runWindow.closesOn}, so this run is no longer taking them.`
              : "This run is no longer taking applications."}
          {runWindow.startsOn ? ` The programme starts ${runWindow.startsOn}.` : ""}
        </p>
        <p className={styles.note}>
          <Link href={`/courses/${courseId}`} className={styles.inlineLink}>
            Read the curriculum
          </Link>
        </p>
        <p className={styles.note}>
          <Link href="/#stay-in-touch" className={styles.inlineLink}>
            Get told when the next run opens
          </Link>
        </p>
      </Card>
    );
  }

  // ---- The form: first application, or editing a pending one ----
  return (
    <>
      <Card padding="lg" className={styles.card}>
        <h2 className={styles.h2}>{editing ? "Edit your application" : "Your application"}</h2>
        <p className={styles.blurb}>
          {editing
            ? "Change anything you like and save — the admissions team sees the latest version."
            : "There are no wrong answers here. Write like you'd talk; we're reading for genuine interest, not polish."}
        </p>
        {userDisplayName ? (
          <p className={styles.identity}>
            Applying as <strong>{userDisplayName}</strong>. Sign out and back in to
            apply from a different account.
          </p>
        ) : null}

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(editing ? "PATCH" : "POST");
          }}
        >
          {questions.length > 0 ? (
            <FormRenderer
              questions={questions}
              answers={answers}
              onChange={setAnswers}
              disabled={busy}
            />
          ) : (
            <p className={styles.muted}>
              This run doesn&apos;t ask any questions — submitting registers your
              interest.
            </p>
          )}

          {timeOptions.length > 0 ? (
            <fieldset className={styles.availability} disabled={busy}>
              <legend className={styles.legend}>
                Which session times could you make?
              </legend>
              <p className={styles.hint}>
                Used when we place people into groups. Tick everything that works —
                it isn&apos;t a commitment, and it doesn&apos;t affect whether you
                get a place.
              </p>
              <div className={styles.chips}>
                {timeOptions.map((label) => {
                  const checked = selected.includes(label);
                  return (
                    <label key={label} className={styles.chip}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleTime(label, e.target.checked)}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {inlineError ? <p className={styles.error}>{inlineError}</p> : null}
          {pausedMessage ? <PausedNotice message={pausedMessage} /> : null}
          {paused ? (
            <SurfacePausedNotice notice={siteNotice} surface="courseApplications" />
          ) : null}

          <div className={styles.actions}>
            <Button type="submit" disabled={busy || paused}>
              {editing ? "Save changes" : "Submit application"}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setInlineError(null);
                  setPausedMessage(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

/**
 * The 503 the ROUTE returned, shown in place. Deliberately distinct from the
 * shared `SurfacePausedNotice` above it, which explains a pause this client
 * already knows about from its own listener: this one covers the gap where the
 * server knows and the client doesn't — a flag flipped mid-submit, or a notice
 * listener that failed open (offline, permission error). In that window the
 * route's own sentence is the only true account of why nothing happened, so it
 * is rendered verbatim rather than replaced with generic copy.
 */
function PausedNotice({ message }: { message: string }) {
  return (
    <div className={styles.paused} role="status">
      <p className={styles.pausedLead}>{message}</p>
      <p className={styles.pausedDetail}>
        See the <Link href="/status#log">maintenance log</Link> for details.
        Anything you&apos;ve typed stays on this page — it just can&apos;t be sent
        until the pause lifts.
      </p>
    </div>
  );
}

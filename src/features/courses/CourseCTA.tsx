"use client";

import Link from "next/link";
import { useAuth } from "@/auth/AuthProvider";
import type { ApplicationWindowState } from "@/lib/courses/window";
import type { CourseEnrolMode } from "@/lib/firestore/courses";
import type { GroupPickerOption } from "./fetchGroupPicker";
import GroupPicker, { type GroupPickerStream } from "./GroupPicker";
import styles from "./CourseCTA.module.css";

/**
 * The run this CTA describes, flattened by the server component that renders
 * it. Dates arrive PRE-FORMATTED (Europe/London, via `lib/courses/window.ts`)
 * rather than as `Date`s: this is a client island, and formatting here would
 * hand the applicant a deadline shifted into whatever timezone their laptop
 * is set to, which for a Nottingham deadline is a way to be a day late.
 */
export type CourseCTARun = {
  id: string;
  /**
   * THE STRUCTURED COHORT, e.g. "Autumn 2026, cohort 2", produced by
   * `cohortLabel(run)` on the server. Empty string for a pre-V3 run that has
   * no cohort stored, and the chip is then omitted entirely.
   *
   * NOT `run.label`. That field is the admin-facing handle somebody typed
   * ("wd", while testing), it survives on the document for admin lists, and
   * V3 stopped showing it to visitors. The empty string is not a licence to
   * fall back to it: a run with no cohort gets no chip.
   */
  cohortLabel: string;
  state: ApplicationWindowState;
  /** "Mon 21 Sep", or null when the window has no opening bound. */
  opensOn: string | null;
  /** "Sun 18 Oct, 23:59", or null when there is no deadline. */
  closesOn: string | null;
  /** "Mon 26 Oct", or null when the run has no start date authored yet. */
  startsOn: string | null;
  /**
   * How people get onto this run. `open` swaps the apply link for the session
   * picker, and `state` is then the ENROLMENT window
   * (`lib/courses/enrolWindow.ts`) rather than the application one. The server
   * resolves which predicate produced it; this component only branches on the
   * mode.
   */
  enrolMode: CourseEnrolMode;
  /** The run's strands. Empty on a run with no streams. Open mode only. */
  streams: GroupPickerStream[];
};

/**
 * The ADMISSION ROUND this course's applications go through, flattened by the
 * server component the same way the run is, with every date pre-formatted in
 * Europe/London.
 *
 * When a round is present it REPLACES the run as the thing the CTA describes:
 * the round is the object an applicant applies to, the apply link points at
 * `/apply/[roundId]` rather than at the run's form, and the dates come from
 * the round. The run's own `applicationsOpenAt` / `applicationsCloseAt` stay
 * the mechanism for OPEN-ENROLMENT runs, which have no round and never will.
 *
 * Never `inactive`: the fetcher drops draft and archived rounds, so a round
 * that reaches this component is one a visitor may be told about.
 */
export type CourseCTARound = {
  id: string;
  state: Exclude<ApplicationWindowState, "inactive">;
  /** "Mon 21 Sep", or null when the round has no opening bound. */
  opensOn: string | null;
  /** "Sun 18 Oct, 23:59", or null when there is no deadline. */
  closesOn: string | null;
  /** "Fri 23 Oct", the day decisions are promised by, or null. */
  decisionsOn: string | null;
  /**
   * THE COHORT OF THE RUN THIS ROUND PLACES PEOPLE ONTO, e.g. "Autumn 2026,
   * cohort 2". Empty when the round names no run of this course, and the chip
   * is then omitted entirely.
   *
   * The round carries these two run-derived rows rather than letting the CTA
   * read them off `run`, because `run` is the FEATURED run: the one whose own
   * window is live. An open round's target run is normally still `draft`, so
   * the featured run is by construction a DIFFERENT intake, and taking the
   * chip from it captions this round's deadline with last term's cohort.
   *
   * Empty is not a licence to fall back to `run.cohortLabel`. No chip is the
   * honest answer.
   */
  cohortLabel: string;
  /** "Mon 26 Oct" for that same run, or null when none resolves. */
  startsOn: string | null;
};

type Props = {
  courseId: string;
  /** Used in the sentence in place of the run label. See the note below. */
  courseTitle: string;
  /** The run to describe, or null when the course has no public run. */
  run: CourseCTARun | null;
  /**
   * The admission round the course's applications go through, ALREADY
   * PRECEDENCE-RESOLVED by the server: it is non-null exactly when
   * `roundOwnsDates` (fetchCourses.ts) says the round speaks for this course,
   * and null when the run's own window does. Passing it means "the round owns
   * the dates and the apply link"; see `CourseCTARound`.
   */
  round?: CourseCTARound | null;
  /**
   * `hero` sits under the course title and stays compact; `foot` closes the
   * page and gets the fuller framing line.
   */
  placement?: "hero" | "foot";
  /**
   * Session slots for an OPEN-mode run, projected server-side
   * (`fetchGroupPicker.ts`). Empty for an admissions run, and for an open one
   * whose groups have no times yet.
   */
  groups?: GroupPickerOption[];
};

/**
 * The apply call-to-action on a public course page. A client island purely
 * because it branches on whether the visitor is signed in; everything around
 * it stays a server component.
 *
 * Three things this file is careful about:
 *
 * 1. **It branches on the WINDOW, not the status.** The run's window state is
 *    computed server-side by the one predicate the apply route also uses
 *    (`lib/courses/window.ts`), so this can no longer offer an Apply button
 *    for a run whose deadline has passed. That mismatch was the blocker: the
 *    button worked, the form rendered, and the POST refused it.
 * 2. **The run LABEL never appears inside a sentence.** It is an internal
 *    handle an admin typed ("Autumn 2026", or "wd" while someone was
 *    testing), and "Applications open for wd" shipped to dev reading exactly
 *    like that. Sentences use the course title and real dates; the label gets
 *    a chip, where a short scrappy string is fine.
 * 3. **It does NOT branch on role.** `/courses/[courseId]/apply` lives in the
 *    PUBLIC route group precisely so a `pending` account can reach it. Every
 *    signed-in visitor gets the same link, and the apply page itself is the
 *    one place that says no. Branching here would need `role`, which lands a
 *    beat after `user` and would flicker the button for everyone.
 * 4. **Two ways onto a run, one component.** An `admissions` run sends people
 *    to the application form; an `open` one (the pre-course) puts the session
 *    picker right here, because there is nothing to review and no decision to
 *    wait for. The copy differs throughout: an open run is not "taking
 *    applications", it is taking sign-ups, and telling a fresher they have
 *    applied to something that admits everyone is a promise of a wait that
 *    will never come.
 */
export default function CourseCTA({
  courseId,
  courseTitle,
  run,
  round = null,
  placement = "hero",
  groups = [],
}: Props) {
  const { user, loading } = useAuth();
  const coursePath = `/courses/${encodeURIComponent(courseId)}`;
  const title = courseTitle || "this course";
  const open = run?.enrolMode === "open";
  // PRECEDENCE IS THE SERVER'S. `roundOwnsDates` in `fetchCourses.ts` is the
  // one rule for whether the round or the run's own window speaks for a
  // course, and the page passes `round` only when the round is the answer
  // (never for an open-enrolment run, which no round places anybody onto). A
  // second copy of that condition here is how the catalogue and this page came
  // to disagree about it in the first place.
  const viaRound = round !== null;
  const applyHref = viaRound
    ? `/apply/${encodeURIComponent(round.id)}`
    : `/courses/${encodeURIComponent(courseId)}/apply`;

  const wrap = [styles.cta, placement === "foot" ? styles.foot : styles.hero]
    .filter(Boolean)
    .join(" ");

  // No run at all, or one that is not public (draft / archived, both of which
  // the fetcher drops before this component ever sees them).
  //
  // MODE-NEUTRAL COPY, deliberately: there is no run here to have a mode, so
  // the branch covers an admissions course between intakes and a pre-course
  // that has not been scheduled yet with one sentence. Naming either way in
  // (applying, signing up) would be wrong for half the courses it renders on.
  //
  // A ROUND with no public run is a real and important state, not an edge
  // case: an autumn intake is authored and opened while the runs it will
  // place people onto are still `draft`, which is exactly the fortnight the
  // page most needs to say "applications are open". So the round is checked
  // first and the run's absence only decides the copy when there is no round.
  if (!round && (!run || run.state === "inactive")) {
    return (
      <div className={wrap}>
        <p className={styles.line}>
          This course isn&apos;t taking new people right now.{" "}
          <Link href="/#stay-in-touch" className={styles.inlineLink}>
            Subscribe for updates
          </Link>{" "}
          and we&apos;ll tell you when the next run opens.
        </p>
      </div>
    );
  }

  // ONE state and ONE set of dates for the whole component, resolved here so
  // no branch below can read the round's deadline beside the run's state. The
  // COHORT and the START DATE are in that set: when the round is speaking they
  // describe the run it will place people onto, not the featured run, and they
  // are empty rather than borrowed when no such run resolves.
  const state = viaRound ? round.state : (run?.state ?? "closed");
  const opensOn = viaRound ? round.opensOn : (run?.opensOn ?? null);
  const closesOn = viaRound ? round.closesOn : (run?.closesOn ?? null);
  const chip = viaRound ? round.cohortLabel : (run?.cohortLabel ?? "");
  const startsOn = viaRound ? round.startsOn : (run?.startsOn ?? null);

  const dates = [
    state !== "closed" && closesOn
      ? `${open ? "Sign-ups close" : "Applications close"} ${closesOn}`
      : null,
    viaRound && round.decisionsOn ? `Decisions by ${round.decisionsOn}` : null,
    startsOn ? `Starts ${startsOn}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className={wrap}>
      {/* The chip is the structured cohort, never the run's admin label, and
          it is omitted rather than guessed at when there is no cohort to
          show. */}
      {chip ? (
        <p className={styles.chipRow}>
          <span className={styles.chip}>{chip}</span>
        </p>
      ) : null}

      {state === "open" ? (
        <p className={styles.line}>
          <span className={styles.open}>
            {open ? "Sign-ups are open" : "Applications are open"}
          </span>{" "}
          for {title}.
          {open ? " Everyone who signs up gets a place." : ""}
        </p>
      ) : state === "not-yet" ? (
        <p className={styles.line}>
          {open
            ? opensOn
              ? `Sign-ups for ${title} open on ${opensOn}.`
              : `Sign-ups for ${title} open soon.`
            : opensOn
              ? `Applications for ${title} open on ${opensOn}.`
              : `Applications for ${title} open soon.`}
        </p>
      ) : (
        <p className={styles.line}>
          {open
            ? closesOn
              ? `Sign-ups for ${title} closed on ${closesOn}.`
              : `Sign-ups for ${title} have closed.`
            : closesOn
              ? `Applications for ${title} closed on ${closesOn}.`
              : `Applications for ${title} have closed.`}
        </p>
      )}

      {dates.length > 0 ? (
        <p className={styles.dates}>
          {dates.map((bit, i) => (
            <span key={bit}>
              {i > 0 ? (
                <span aria-hidden="true" className={styles.dot}>
                  ·
                </span>
              ) : null}
              {bit}
            </span>
          ))}
        </p>
      ) : null}

      {/* While auth resolves, show the state lines alone. Rendering the
          signed-out button first would flash "Sign in to apply" at members
          who are already signed in. */}
      {/* OPEN MODE: the picker IS the call to action, and it handles the
          signed-out case itself (a sign-in link carrying `next`), so it is
          rendered whether or not auth has resolved. Gating it on `loading`
          would blank the timetable on every first paint.

          It is rendered on a CLOSED open-mode run too, and renders nothing
          there unless the visitor is on the course: this page is the only
          surface an open-enrolment member has, so the deadline passing must
          not take away the place they can see or the way out of it. */}
      {open && run ? (
        <GroupPicker
          runId={run.id}
          courseTitle={courseTitle}
          groups={groups}
          streams={run.streams}
          enrolOpen={run.state === "open"}
          nextPath={coursePath}
        />
      ) : loading ? null : state === "open" ? (
        user ? (
          <Link href={applyHref} className={styles.button}>
            Start your application
          </Link>
        ) : (
          // `next` carries them to the form itself, not back to this page, so
          // signing in doesn't cost them a second click. The apply page and
          // the register form both keep it, so a brand-new account lands back
          // on the form it left.
          <Link
            href={`/login?next=${encodeURIComponent(applyHref)}`}
            className={styles.button}
          >
            Sign in to apply
          </Link>
        )
      ) : (
        <>
          <p className={styles.line}>
            <Link href="/#stay-in-touch" className={styles.inlineLink}>
              Subscribe for updates
            </Link>{" "}
            and we&apos;ll tell you when the next run opens.
          </p>
          {/* The apply page is the ONLY surface that shows an applicant their
              own application, and it stays reachable once the window shuts.
              Signed-out visitors get no such link: there is nothing behind it
              for them. */}
          {user && !open ? (
            <p className={styles.line}>
              Already applied?{" "}
              <Link href={applyHref} className={styles.inlineLink}>
                Check your application
              </Link>
              .
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

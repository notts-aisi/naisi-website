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
  /** e.g. "Autumn 2026". Rendered as a CHIP, never inside a sentence. */
  label: string;
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

type Props = {
  courseId: string;
  /** Used in the sentence in place of the run label. See the note below. */
  courseTitle: string;
  /** The run to describe, or null when the course has no public run. */
  run: CourseCTARun | null;
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
  placement = "hero",
  groups = [],
}: Props) {
  const { user, loading } = useAuth();
  const applyHref = `/courses/${encodeURIComponent(courseId)}/apply`;
  const coursePath = `/courses/${encodeURIComponent(courseId)}`;
  const title = courseTitle || "this course";
  const open = run?.enrolMode === "open";

  const wrap = [styles.cta, placement === "foot" ? styles.foot : styles.hero]
    .filter(Boolean)
    .join(" ");

  // No run at all, or one that is not public (draft / archived, both of which
  // the fetcher drops before this component ever sees them).
  if (!run || run.state === "inactive") {
    return (
      <div className={wrap}>
        <p className={styles.line}>
          Sign-ups aren&apos;t open right now.{" "}
          <Link href="/#stay-in-touch" className={styles.inlineLink}>
            Subscribe for updates
          </Link>{" "}
          and we&apos;ll tell you when the next run opens.
        </p>
      </div>
    );
  }

  const dates = [
    run.state !== "closed" && run.closesOn
      ? `${open ? "Sign-ups close" : "Applications close"} ${run.closesOn}`
      : null,
    run.startsOn ? `Starts ${run.startsOn}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className={wrap}>
      <p className={styles.chipRow}>
        <span className={styles.chip}>{run.label}</span>
      </p>

      {run.state === "open" ? (
        <p className={styles.line}>
          <span className={styles.open}>
            {open ? "Sign-ups are open" : "Applications are open"}
          </span>{" "}
          for {title}.
          {open ? " Everyone who signs up gets a place." : ""}
        </p>
      ) : run.state === "not-yet" ? (
        <p className={styles.line}>
          {open
            ? run.opensOn
              ? `Sign-ups for ${title} open on ${run.opensOn}.`
              : `Sign-ups for ${title} open soon.`
            : run.opensOn
              ? `Applications for ${title} open on ${run.opensOn}.`
              : `Applications for ${title} open soon.`}
        </p>
      ) : (
        <p className={styles.line}>
          {open
            ? run.closesOn
              ? `Sign-ups for ${title} closed on ${run.closesOn}.`
              : `Sign-ups for ${title} have closed.`
            : run.closesOn
              ? `Applications for ${title} closed on ${run.closesOn}.`
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
      {open ? (
        <GroupPicker
          runId={run.id}
          courseTitle={courseTitle}
          groups={groups}
          streams={run.streams}
          enrolOpen={run.state === "open"}
          nextPath={coursePath}
        />
      ) : loading ? null : run.state === "open" ? (
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

"use client";

import Link from "next/link";
import { useAuth } from "@/auth/AuthProvider";
import styles from "./CourseCTA.module.css";

type Props = {
  courseId: string;
  /** The run currently accepting applications, or null when none is open. */
  openRun: { id: string; label: string } | null;
  /**
   * `hero` sits under the course title and stays compact; `foot` closes the
   * page and gets the fuller framing line.
   */
  placement?: "hero" | "foot";
};

/**
 * The apply call-to-action on a public course page. A client island purely
 * because it branches on whether the visitor is signed in — everything around
 * it stays a server component.
 *
 * Both branches point at the same place: `/courses/[courseId]/apply` lives in
 * the PUBLIC route group precisely so a `pending` account can reach it (the
 * authed layout would bounce them). So this deliberately does NOT branch on
 * role — every signed-in visitor gets the same button, and the apply page
 * itself is the one place that says no (to rejected accounts, a closed window,
 * or a full cohort). Branching here would need `role`, which lands a beat
 * after `user` and would flicker the button for everyone.
 */
export default function CourseCTA({ courseId, openRun, placement = "hero" }: Props) {
  const { user, loading } = useAuth();
  const applyHref = `/courses/${encodeURIComponent(courseId)}/apply`;

  const wrap = [styles.cta, placement === "foot" ? styles.foot : styles.hero]
    .filter(Boolean)
    .join(" ");

  if (!openRun) {
    return (
      <div className={wrap}>
        <p className={styles.line}>
          Applications aren&apos;t open right now.{" "}
          <Link href="/#stay-in-touch" className={styles.inlineLink}>
            Subscribe for updates
          </Link>{" "}
          and we&apos;ll tell you when the next run opens.
        </p>
      </div>
    );
  }

  return (
    <div className={wrap}>
      <p className={styles.line}>
        <span className={styles.open}>Applications open</span> for {openRun.label}.
      </p>
      {/* While auth resolves, show the state line alone. Rendering the
          signed-out button first would flash "Sign in to apply" at members
          who are already signed in. */}
      {loading ? null : user ? (
        <Link href={applyHref} className={styles.button}>
          Apply for {openRun.label}
        </Link>
      ) : (
        // `next` carries them to the form itself, not back to this page, so
        // signing in doesn't cost them a second click.
        <Link
          href={`/login?next=${encodeURIComponent(applyHref)}`}
          className={styles.button}
        >
          Sign in to apply
        </Link>
      )}
    </div>
  );
}

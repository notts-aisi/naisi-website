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
 * Copy discipline: the application FORM lands in a later PR, so a signed-in
 * visitor is told the truth ("open, form arrives here soon") rather than shown
 * a button that goes nowhere. When the form ships, only the signed-in branch
 * changes.
 */
export default function CourseCTA({ courseId, openRun, placement = "hero" }: Props) {
  const { user, loading } = useAuth();

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
        <p className={styles.note}>
          The application form arrives here shortly — check back soon, or{" "}
          <Link href="/#stay-in-touch" className={styles.inlineLink}>
            subscribe for updates
          </Link>
          .
        </p>
      ) : (
        <Link
          href={`/login?next=${encodeURIComponent(`/courses/${courseId}`)}`}
          className={styles.button}
        >
          Sign in to apply
        </Link>
      )}
    </div>
  );
}

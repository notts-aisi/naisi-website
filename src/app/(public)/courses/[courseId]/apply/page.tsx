import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  getApplyContext,
  getPublishedCourse,
} from "@/features/courses/fetchCourses";
import ApplyForm from "@/features/courses/ApplyForm";
import Reveal from "../../../Reveal";
import styles from "./apply.module.css";

/**
 * `/courses/[courseId]/apply` — and note WHERE it lives.
 *
 * This page is in `(public)`, not `(app)`, on purpose: applying is open to any
 * signed-in account INCLUDING role `pending`, and `(app)/layout.tsx` redirects
 * pending users to `/pending-approval`. Putting the apply page behind that
 * layout would lock out precisely the people it exists for — the ones who
 * signed up this week and want to join a reading group.
 *
 * So the gate here is deliberately shallow: the page reads the session to
 * decide which card to render, and the API route behind the form does the real
 * enforcement (signed-in, not rejected, window open, cap, cooldown, pause).
 * Nothing on this page is load-bearing for access control.
 */

// Run status, the application window and the group slots all change without a
// deploy, and the page renders per-viewer state on top of them.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ courseId: string }>;
}): Promise<Metadata> {
  const { courseId } = await params;
  const context = await getApplyContext(courseId);
  if (!context) return { title: "Applications closed" };
  return {
    title: `Apply — ${context.course.title || "Course"}`,
    description: `Apply for ${context.run.label} of ${context.course.title}. Open to anyone with a NAISI account, including brand-new ones.`,
    // A personal form is no use in search results, and the page renders
    // per-viewer state; the course page is the canonical public surface.
    robots: { index: false, follow: true },
  };
}

export default async function CourseApplyPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const [user, context] = await Promise.all([
    getCurrentUser(),
    getApplyContext(courseId),
  ]);

  // No open run (or no such published course). One honest card rather than a
  // 404: people reach this URL from an old email or a bookmarked link, and
  // "closed" is the useful answer, not "does not exist".
  if (!context) {
    const found = await getPublishedCourse(courseId);
    return (
      <section className={styles.page}>
        <div className="container">
          {found ? <Breadcrumb courseId={courseId} title={found.course.title} /> : null}
          <Card padding="lg" className={styles.closedCard}>
            <h1 className={styles.closedTitle}>Applications aren&apos;t open right now</h1>
            <p className={styles.closedBody}>
              {found
                ? `There's no run of ${found.course.title || "this course"} taking applications at the moment. The curriculum stays up in the meantime — and applications for the next run open a few weeks before it starts.`
                : "There's no course taking applications at this address. It may have finished its run, or the link may be out of date."}
            </p>
            <p className={styles.closedLinks}>
              {found ? (
                <Link href={`/courses/${courseId}`} className={styles.link}>
                  Read the curriculum
                </Link>
              ) : null}
              <Link href="/courses" className={styles.link}>
                Browse all courses
              </Link>
              <Link href="/#stay-in-touch" className={styles.link}>
                Get told when the next run opens
              </Link>
            </p>
          </Card>
        </div>
      </section>
    );
  }

  const { course, run, groups } = context;
  const nextParam = encodeURIComponent(`/courses/${courseId}/apply`);

  return (
    <section className={styles.page}>
      <div className="container">
        <Breadcrumb courseId={courseId} title={course.title} />

        <header className={styles.hero}>
          <Badge tone="accent">{run.label}</Badge>
          <Reveal variant="mask-wipe" as="h1" className={styles.title}>
            Apply — {course.title || "Course"}
          </Reveal>
          <p className={styles.lede}>
            A short form, read by people rather than a filter. We&apos;re looking
            for why this matters to you and whether the weekly commitment is
            realistic right now — not for the right vocabulary. Take ten minutes
            over it; you can edit your answers until the team reviews them.
          </p>
        </header>

        {!user ? (
          <Card padding="lg" className={styles.gateCard}>
            <h2 className={styles.gateTitle}>Sign in to apply</h2>
            <p className={styles.gateBody}>
              Applications are tied to a NAISI account so you can come back, edit
              your answers, and hear the outcome. <strong>Any account can
              apply</strong> — including one you make in the next minute, and one
              that&apos;s still waiting on committee approval.
            </p>
            {/*
              An anchor styled as the primary action: <Button> renders a real
              <button> and takes no href, so navigation targets get the styling
              rather than the component (the CourseCTA / landing-page call).
            */}
            <Link href={`/login?next=${nextParam}`} className={styles.button}>
              Sign in to apply
            </Link>
            <p className={styles.gateNote}>
              We&apos;ll bring you straight back to this form.
            </p>
          </Card>
        ) : user.role === "rejected" ? (
          <Card padding="lg" className={styles.gateCard}>
            <h2 className={styles.gateTitle}>This account can&apos;t apply</h2>
            <p className={styles.gateBody}>
              Your NAISI account isn&apos;t able to submit course applications. If
              you think that&apos;s a mistake, reply to any email from us and
              we&apos;ll take a look.
            </p>
          </Card>
        ) : (
          <>
            {user.role === "pending" ? (
              <p className={styles.pendingNote}>
                Your membership is still with the committee — that&apos;s fine.
                Course applications are open to new accounts, and the two are
                reviewed separately.
              </p>
            ) : null}
            <ApplyForm
              runId={run.id}
              courseId={course.id}
              questions={run.applicationForm}
              groups={groups}
              userDisplayName={user.displayName ?? ""}
            />
          </>
        )}
      </div>
    </section>
  );
}

function Breadcrumb({ courseId, title }: { courseId: string; title: string }) {
  return (
    <p className={styles.breadcrumb}>
      <Link href={`/courses/${courseId}`} className={styles.breadcrumbLink}>
        <span aria-hidden="true" className={styles.backArrow}>
          ←
        </span>
        {title || "Back to the course"}
      </Link>
    </p>
  );
}

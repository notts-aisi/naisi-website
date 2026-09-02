import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  getApplyContext,
  getPublishedCourse,
} from "@/features/courses/fetchCourses";
import ApplyForm, { type ApplyWindow } from "@/features/courses/ApplyForm";
import {
  formatPastWindowDate,
  formatRunStartShort,
  formatWindowDate,
  formatWindowDeadline,
  type ApplicationWindow,
} from "@/lib/courses/window";
import type { CourseRunDoc } from "@/lib/firestore/courses";
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
  const open = context.window.state === "open";
  return {
    title: `${open ? "Apply" : "Your application"}: ${context.course.title || "Course"}`,
    description: open
      ? `Apply for ${context.course.title}. Open to anyone with a NAISI account, including brand-new ones.`
      : `Applications for ${context.course.title} aren't open right now. Sign in to check an application you've already sent.`,
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

  const { course, run, groups, window } = context;
  const applyPath = `/courses/${courseId}/apply`;
  const nextParam = encodeURIComponent(applyPath);
  // Formatted HERE, on the server, in Europe/London. See `lib/courses/window.ts`.
  const runWindow = toApplyWindow(run, window);
  const open = window.state === "open";
  const dates = [
    open && runWindow.closesOn ? `Applications close ${runWindow.closesOn}` : null,
    runWindow.startsOn ? `Starts ${runWindow.startsOn}` : null,
  ].filter(Boolean) as string[];

  return (
    <section className={styles.page}>
      <div className="container">
        <Breadcrumb courseId={courseId} title={course.title} />

        <header className={styles.hero}>
          {/* The run label is a CHIP and nowhere else. It is an internal handle
              an admin typed, so it must never land inside a sentence. */}
          <Badge tone="accent">{run.label}</Badge>
          <Reveal variant="mask-wipe" as="h1" className={styles.title}>
            {open ? "Apply" : "Your application"}: {course.title || "Course"}
          </Reveal>
          {dates.length > 0 ? (
            <p className={styles.dates}>{dates.join(" · ")}</p>
          ) : null}
          <p className={styles.lede}>
            {open
              ? "A short form, read by people rather than a filter. We're looking for why this matters to you and whether the weekly commitment is realistic right now, not for the right vocabulary. Take ten minutes over it; you can edit your answers until the team reviews them."
              : "Applications for this run aren't open. If you've already sent one, it's below."}
          </p>
        </header>

        {!user ? (
          <Card padding="lg" className={styles.gateCard}>
            <h2 className={styles.gateTitle}>
              {open ? "Sign in to apply" : "Sign in to check your application"}
            </h2>
            <p className={styles.gateBody}>
              {open ? (
                <>
                  Applications are tied to a NAISI account so you can come back,
                  edit your answers, and hear the outcome.{" "}
                  <strong>Any account can apply</strong>, including one you make
                  in the next minute, and one that&apos;s still waiting on
                  committee approval.
                </>
              ) : (
                <>
                  {closedLine(runWindow)} If you applied to this run, sign in and
                  your application will be here.
                </>
              )}
            </p>
            {/*
              An anchor styled as the primary action: <Button> renders a real
              <button> and takes no href, so navigation targets get the styling
              rather than the component (the CourseCTA / landing-page call).

              `next` rides through sign-in AND through registration, so a
              brand-new account made in the next minute lands back on this
              form rather than on /pending-approval. See the register page.
            */}
            <Link href={`/login?next=${nextParam}`} className={styles.button}>
              {open ? "Sign in to apply" : "Sign in"}
            </Link>
            {/* Offered only while the window is open: telling someone to make
                an account for a run they can no longer apply to would be a
                wasted five minutes. */}
            {open ? (
              <p className={styles.gateNote}>
                No account yet?{" "}
                <Link href={`/register?next=${nextParam}`} className={styles.gateLink}>
                  Create one
                </Link>{" "}
                and we&apos;ll bring you straight back to this form.
              </p>
            ) : (
              <p className={styles.gateNote}>
                No application here without an account, so if you never made one
                you never applied.
              </p>
            )}
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
            {user.role === "pending" && open ? (
              <p className={styles.pendingNote}>
                Your membership is still with the committee, which is fine.
                Course applications are open to new accounts, and the two are
                reviewed separately.
              </p>
            ) : null}
            {/* ApplyForm, not a branch here: whether this person already holds
                an application is a client-side own-row read, so the component
                is the only place that can choose between the status card, the
                blank form, and the dated closed card. */}
            <ApplyForm
              runId={run.id}
              courseId={course.id}
              questions={run.applicationForm}
              groups={groups}
              userDisplayName={user.displayName ?? ""}
              runWindow={runWindow}
            />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Flatten a run plus its window into the pre-formatted shape the client
 * components take. Every date is rendered here, on the server, in
 * Europe/London: formatting a Nottingham deadline in the visitor's own
 * timezone is how someone reads "closes Sat 17 Oct" and applies a day late.
 *
 * A LIVE deadline carries its TIME and a PASSED one carries its year instead,
 * for the reasons set out on the course page's twin of this function. A start
 * date needs neither: its time is a group's session slot, told to them at
 * allocation.
 */
function toApplyWindow(run: CourseRunDoc, window: ApplicationWindow): ApplyWindow {
  const past = window.state === "closed";
  return {
    state: window.state,
    opensOn: window.opensAt ? formatWindowDate(window.opensAt) : null,
    closesOn: window.closesAt
      ? past
        ? formatPastWindowDate(window.closesAt)
        : formatWindowDeadline(window.closesAt)
      : null,
    startsOn: formatRunStartShort(run.startDate) ?? null,
  };
}

/** One sentence naming why the window is shut, with the date it happened. */
function closedLine(runWindow: ApplyWindow): string {
  if (runWindow.state === "not-yet") {
    return runWindow.opensOn
      ? `Applications open on ${runWindow.opensOn}.`
      : "Applications open shortly.";
  }
  return runWindow.closesOn
    ? `Applications closed on ${runWindow.closesOn}.`
    : "Applications for this run have closed.";
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

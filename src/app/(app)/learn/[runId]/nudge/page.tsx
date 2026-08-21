import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import NudgePanel from "@/features/courses/NudgePanel";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";

/**
 * Server shell for THIS WEEK'S NUDGE — the prepared reminder a cohort gets
 * about the week it is on.
 *
 * ── THE NUDGE IS SENT BY A PERSON ───────────────────────────────────────────
 * There is no scheduler in this app (App Hosting, 60s request timeout), so
 * nothing here fires on a timer. The nudge is a PREPARED MESSAGE with a button:
 * the route composes it from the admin-edited `course-week-nudge` template, the
 * panel shows exactly what would go out and to how many people, and a
 * facilitator presses send. The send route is idempotent per (run, week) so an
 * external scheduler could later be pointed at it unchanged; that future is
 * designed for and deliberately not built. `NudgePanel`'s header carries the
 * full write-up.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * A RUN facilitator (named on `runFacilitatorUids`), a TRACK LEAD, or an admin
 * — byte-for-byte the predicate the nudge route enforces and the one the cohort
 * email shell beside it uses, for the same two reasons:
 *
 *   A GROUP FACILITATOR gets nothing here. The nudge addresses the whole
 *   cohort, and facilitating one room of a run is not the same as speaking for
 *   all of it. That facilitator mails their own group through the group lane,
 *   which is operational and which nobody can unsubscribe from.
 *
 *   AN ADMISSIONS REVIEWER gets nothing here either. Admissions is a separate
 *   lane from the cohort (locked decision) and reading applications has never
 *   granted the ability to mail the people who were admitted.
 *
 * A UI gate looser than the route's would show a door that opens onto a 403,
 * and one tighter would hide a lane someone is entitled to; the route re-derives
 * it from the same documents and remains the real boundary.
 *
 * Redirects, never 403s: someone guessing run ids learns nothing about which
 * ones exist.
 *
 * ── NOTHING IS COUNTED HERE ─────────────────────────────────────────────────
 * Unlike the cohort-email shell, which has to hand its composer a subscriber
 * count before a word is typed, this page passes only the run's label and the
 * caller's admin flag. Everything else — the week, the recipient count, the
 * rendered subject and body, the session line, and whether this week's nudge
 * has already gone — comes from ONE authenticated GET the panel makes, so the
 * numbers on screen and the numbers the send route will use are read from the
 * same place at the same moment.
 */

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

/** Inline, like the two email shells beside it — see the group email page. */
const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-6)",
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--color-text-muted)",
};

const subStyle: CSSProperties = {
  margin: "var(--space-2) 0 0",
  maxWidth: "62ch",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
  color: "var(--color-text-muted)",
};

const linkStyle: CSSProperties = { color: "var(--color-accent)" };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function RunNudgePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    // Null is "no session" OR "no such run" — deliberately fused in
    // `getRunAccess`. `getSessionUser` is memoised by now, so telling the two
    // apart costs nothing and leaks nothing.
    const user = await getSessionUser();
    redirect(user ? "/learn" : "/login");
  }

  const runHome = `/learn/${encodeURIComponent(runId)}`;

  // `access.isFacilitator` is deliberately NOT consulted: it is true for
  // someone who merely holds a group of this run. See the gate note above.
  const staffsRun =
    access.run.runFacilitatorUids.includes(access.user.uid) || access.isTrackLead;
  if (!access.isAdmin && !staffsRun) {
    redirect(runHome);
  }

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");
  const runLabel = access.run.label || access.run.courseTitle || "this cohort";

  return (
    <div style={pageStyle}>
      <div>
        {eyebrow && <p style={eyebrowStyle}>{eyebrow}</p>}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>This week&apos;s nudge</h1>
        <p style={subStyle}>
          A short reminder of what the cohort is on this week and when their
          session is, written once as a template and sent from here. It goes to
          everyone on the cohort channel who hasn&apos;t opted out, one message
          each, and only one nudge is kept per week — so a second press sends
          nothing rather than a second copy.{" "}
          <Link href={runHome} style={linkStyle}>
            Back to the course
          </Link>
        </p>
      </div>

      <NudgePanel runId={runId} runLabel={runLabel} isAdmin={access.isAdmin} />
    </div>
  );
}

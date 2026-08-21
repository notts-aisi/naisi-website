import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import StaffEmailComposer from "@/features/courses/StaffEmailComposer";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { getAdminDb } from "@/lib/firebase/admin";
import { courseRunChannel } from "@/lib/firestore/courses";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";

/**
 * Server shell for the cohort announcement composer — the ANNOUNCEMENT lane.
 * Its twin is `/learn/[runId]/group/[groupId]/email`, the operational one, and
 * the same component serves both with a different audience.
 *
 * ── THE GATE IS NARROWER THAN THE LAYOUT'S, AND NARROWER THAN THE GROUP
 *    PAGE'S ────────────────────────────────────────────────────────────────
 * A RUN facilitator (named on `runFacilitatorUids`), a TRACK LEAD, or an
 * admin. Nobody else — and the two exclusions are deliberate, not oversights:
 *
 *   A GROUP FACILITATOR gets nothing here. Facilitating one room of a run does
 *   not make you the person who addresses all of it; that facilitator mails
 *   their own group through the group lane, which is operational and which
 *   nobody can unsubscribe from.
 *
 *   AN ADMISSIONS REVIEWER gets nothing here either. Admissions is a separate
 *   lane from the cohort (locked decision) and reading applications has never
 *   granted the ability to mail the people who were admitted.
 *
 * This is BYTE-FOR-BYTE the predicate the send route enforces — `isAdmin ||
 * runFacilitatorUids ∪ trackLeadUids` — and it has to stay that way: a UI gate
 * looser than the route's would show a door that opens onto a 403, and one
 * tighter would hide a lane someone is entitled to. The route re-derives it
 * from the same documents and remains the real boundary.
 *
 * Redirects, never 403s: someone guessing run ids learns nothing about which
 * ones exist.
 *
 * ── WHY THE COUNT IS TAKEN HERE ─────────────────────────────────────────────
 * The composer will not let a real send through without a number it can put in
 * front of the author, and there is no client-readable source for this one:
 * `subscriptions` is server-only, and the cohort's audience is the
 * `cohort:<runId>` channel rather than the enrolment list (an unsubscribe has
 * to actually take effect). So the shell counts the rows with the SAME helper
 * the send route resolves its recipients with — one source of truth for who is
 * on the channel — and passes a bare number across. No address reaches the
 * client.
 *
 * The number is an UPPER BOUND, and the composer says "up to" for that reason:
 * the route dedupes, drops anyone who has turned course announcements off, and
 * drops suppressed addresses, all after this count is taken. Counting rows
 * cannot over-report by any other route, so "up to N" is the honest claim.
 * A failed count passes `null`, which BLOCKS the real send rather than
 * guessing — the same thing an unloadable roster does on the group lane.
 */

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

/** Inline, like the group email shell beside it — see the group page's note. */
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

export default async function RunEmailPage({
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

  /**
   * Rows on the cohort channel. Wrapped because a failed count must not 500 a
   * page whose composer already knows how to say "we can't tell you how many
   * people this would reach, so sending is off" — and `redirect()` signals by
   * throwing, so nothing that could redirect may sit inside this try.
   */
  let subscriberCount: number | null = null;
  const db = getAdminDb();
  if (db) {
    try {
      const rows = await findRecipientsForChannel(db, courseRunChannel(runId));
      subscriberCount = rows.length;
    } catch (err) {
      console.error("[courses run email page] channel count failed", runId, err);
    }
  }

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");
  const runLabel = access.run.label || access.run.courseTitle || "this cohort";

  return (
    <div style={pageStyle}>
      <div>
        {eyebrow && <p style={eyebrowStyle}>{eyebrow}</p>}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Email the cohort</h1>
        <p style={subStyle}>
          For things everyone on the run needs to know: applications opening, a
          change to the reading, a whole-cohort session. It reaches everyone
          subscribed to this cohort&apos;s channel and nobody else, you never see
          their addresses, and every message carries an unsubscribe link — so
          keep it to announcements, and send anything one group needs from that
          group&apos;s own page.{" "}
          <Link href={runHome} style={linkStyle}>
            Back to the course
          </Link>
        </p>
      </div>

      <StaffEmailComposer
        runId={runId}
        audience={{ kind: "run", runLabel, subscriberCount }}
      />
    </div>
  );
}

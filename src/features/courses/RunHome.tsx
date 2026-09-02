"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import InitialsChip from "@/components/ui/InitialsChip";
import MemberName from "@/components/ui/MemberName";
import Skeleton from "@/components/ui/Skeleton";
import DigitRoll from "@/components/motion/DigitRoll";
import PageEnter from "@/components/motion/PageEnter";
import { useMagneticPull } from "@/hooks/useMagneticPull";
import SessionCard from "./SessionCard";
import WeekRail from "./WeekRail";
import { useGroupRoster } from "./useGroupRoster";
import { useRunOverview } from "./useRunOverview";
import { useSyncTasks } from "./useSyncTasks";
import { weekDocId } from "@/lib/firestore/courses";
import type {
  OverviewGroup,
  OverviewPayload,
} from "@/app/api/courses/runs/[runId]/overview/route";
import type { WeekPlanEntry } from "@/lib/courses/weekPlan";
import styles from "./RunHome.module.css";

/**
 * The run home: where am I, what do I do next, who am I doing it with.
 *
 * One data source — `/api/courses/runs/[runId]/overview` — drives the whole
 * page, and it is the only fetch here on the common path (the facilitator
 * roster is a second, conditional one). Nothing on this page is live: the run's
 * shape, the cohort's week and the group's slot don't move while someone reads
 * them. The thing that DOES move under the reader — the member's own check-offs
 * — lives one route deeper, on the week page, where `useRunProgress` listens.
 *
 * ── THE 3-STATE RULE ────────────────────────────────────────────────────────
 * Layout-matched Skeleton → EmptyState → PageEnter-wrapped content, mounted on
 * the FIRST render with data (the rule PageEnter's header states). It matters
 * more here than anywhere else in the learning space: the WeekRail's draw is a
 * mount-time animation, so a rail rendered against half-arrived data would
 * spend its one signature moment animating a placeholder.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Motion budget: the rail draw is the moment and everything else stays quiet —
 * a page entrance, a modest card stagger, one magnetic CTA. The plan's line for
 * this route is that boldness lives one route deeper and ends here.
 */

type Props = {
  runId: string;
  /**
   * From the server gate, not from the payload's `access` mirror. Used for one
   * thing: whether the admissions panel renders.
   */
  isAdmin: boolean;
  /**
   * Whether this member may address the WHOLE cohort — a run facilitator, a
   * track lead, or an admin. From the server gate for the same reason
   * `isAdmin` is: the payload's `access.isFacilitator` is true for someone who
   * merely holds one GROUP of the run, and a group facilitator is exactly who
   * this lane excludes. Purely a link gate; `/learn/[runId]/email` re-derives
   * it and the send route is the boundary.
   */
  canEmailCohort: boolean;
};

// ---------------------------------------------------------------------------
// Constants + small helpers
// ---------------------------------------------------------------------------

/** Session-scoped, per-run: the rail draws once per run per browser session. */
const RAIL_DRAWN_KEY_PREFIX = "naisi:rail-drawn:";

/**
 * TODO(P8): real completed-week marks on the rail.
 *
 * A week is complete when every check-offable item in it is done, and the
 * denominator — the item count per week — is not in the overview payload
 * (`weeks` carries id/number/title/published/estimatedMinutes only). Deriving
 * it client-side means pulling every week doc, guide blocks and all, on the
 * page members open daily, to decorate a rail. That trade is wrong, and a
 * count guessed from progress rows alone would mark a week complete the moment
 * someone ticked one material — honest empty beats fake state.
 *
 * The fix is a field, not a fetch: P8 adds a per-week item count to the
 * overview payload's `weeks` entries, at which point this becomes a one-line
 * derivation over `useRunProgress`'s rows grouped by `weekNumber`.
 *
 * Shared empty array — read-only by contract, never mutated.
 */
const NO_COMPLETED_WEEKS: number[] = [];

function weekHref(runId: string, weekNumber: number): string {
  return `/learn/${encodeURIComponent(runId)}/weeks/${weekNumber}`;
}

/**
 * `timeZone: "UTC"` because a run's `startDate` is a civil date parsed at UTC
 * midnight — a date, not an instant, and re-zoning it can only move it. Module
 * scoped: constructing an `Intl.DateTimeFormat` is expensive relative to using
 * one (the `weekPlan.ts` precedent).
 */
const START_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
});

function startDateLabel(startDate: string): string | null {
  if (!startDate) return null;
  const parsed = new Date(`${startDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : START_DATE_FORMAT.format(parsed);
}

/**
 * The week the Continue CTA points at: the cohort's current week, the anchor
 * during a break or after the run, week 1 before it starts. `published` is read
 * from the run's own week index — an unauthored week has no doc at all, which
 * counts as not published.
 */
type WeekTarget = { weekNumber: number; published: boolean; title: string };

function weekTargetFor(overview: OverviewPayload): WeekTarget | null {
  const current = overview.currentWeek;
  if (!current) return null;
  const number =
    current.phase === "before"
      ? 1
      : (current.weekNumber ??
        (current.anchorWeekNumber > 0 ? current.anchorWeekNumber : null));
  if (number === null || number < 1) return null;
  const doc = overview.weeks.find((w) => w.weekNumber === number);
  return {
    weekNumber: number,
    published: doc?.published === true,
    title: doc?.title ?? "",
  };
}

/** The hero's big line: a rolling week counter, or a sentence. */
type Headline =
  | { kind: "week"; weekNumber: number; totalWeeks: number }
  | { kind: "text"; text: string };

function heroCopy(
  overview: OverviewPayload,
  target: WeekTarget | null,
): { headline: Headline; sub: string } {
  const { run, currentWeek } = overview;

  // A run with no usable start date is a legitimate half-authored state, not an
  // error — say so rather than inventing a week.
  if (!currentWeek) {
    return {
      headline: { kind: "text", text: "Not scheduled yet" },
      sub: "This run doesn't have a start date yet. It'll show up here the moment it's timetabled.",
    };
  }

  if (currentWeek.phase === "before") {
    const when = startDateLabel(run.startDate);
    const parts: string[] = [];
    if (run.totalWeeks > 0) parts.push(`${run.totalWeeks} weeks.`);
    parts.push(
      target?.published
        ? "Week 1 is already open, if you want to read ahead."
        : "Week 1 opens when the cohort starts.",
    );
    return {
      headline: { kind: "text", text: when ? `Starts ${when}` : "Starts soon" },
      sub: parts.join(" "),
    };
  }

  if (currentWeek.phase === "after") {
    return {
      headline: { kind: "text", text: "Course complete" },
      sub: "The cohort has finished. Every week stays open — revisit whatever you like.",
    };
  }

  // Running. A break slot names itself and has no week number of its own, so it
  // reads as the break and points back at the week it follows.
  if (currentWeek.breakLabel) {
    return {
      headline: { kind: "text", text: currentWeek.breakLabel },
      sub:
        currentWeek.anchorWeekNumber > 0
          ? `No new material this week. Week ${currentWeek.anchorWeekNumber} is still open if you're catching up.`
          : "No new material this week.",
    };
  }

  return {
    headline: {
      kind: "week",
      weekNumber: currentWeek.weekNumber ?? currentWeek.anchorWeekNumber,
      totalWeeks: run.totalWeeks,
    },
    // The week's own title is the best sub-line there is; without one the hero
    // simply says less rather than repeating the headline in longer words.
    sub: target?.title ?? "",
  };
}

// ---------------------------------------------------------------------------
// The rail (the signature draw)
// ---------------------------------------------------------------------------

/**
 * The once-per-session draw verdict for one run.
 *
 * Caller-owned by WeekRail's contract: the rail seeds its `drawing` state from
 * `animate` at mount and never re-reads it, so the verdict has to be settled
 * before the rail exists. Hence the split below.
 *
 * The READ is a lazy state initialiser, not an effect: an effect runs after
 * paint, which would leave the rail rendered final-state for a frame and then
 * unable to start (the prop flip lands too late). Reading storage in an
 * initialiser is safe here precisely because this hook lives in a component
 * that only ever mounts on the first render WITH data — never during SSR, so
 * there is no hydration mismatch to create.
 *
 * The WRITE is an effect, deliberately: React double-invokes initialisers in
 * dev StrictMode, and claiming the flag inside one would consume the one-shot
 * against itself so the draw never played locally. `setItem` is idempotent, so
 * the same double-invocation is harmless in the effect. The claim lands within
 * a frame of the draw starting — orders of magnitude faster than a navigation
 * away and back, which is the only thing it is racing.
 *
 * Mirrors the `naisi:from-signin` idiom in AppShell: sessionStorage, one key,
 * consumed on read, wrapped in try/catch because storage throws outright in
 * some embedded contexts.
 */
function useRailDrawOnce(runId: string): boolean {
  const [animate] = useState(() => {
    try {
      return sessionStorage.getItem(`${RAIL_DRAWN_KEY_PREFIX}${runId}`) !== "1";
    } catch {
      // Storage unavailable: render final-state. A draw on every single visit
      // is worse than no draw at all.
      return false;
    }
  });

  useEffect(() => {
    if (!animate) return;
    try {
      sessionStorage.setItem(`${RAIL_DRAWN_KEY_PREFIX}${runId}`, "1");
    } catch {
      // Nothing to do — the read above already failed closed.
    }
  }, [animate, runId]);

  return animate;
}

type RailProps = {
  runId: string;
  plan: WeekPlanEntry[];
  phase: "before" | "running" | "after";
  anchorWeekNumber: number;
  currentWeekNumber: number | null;
};

/**
 * Its own component so `useRailDrawOnce`'s initialiser runs at the rail's
 * mount rather than the page's, and so the callsite can `key` it by run: two
 * run ids share this route pattern, and a soft navigation between them
 * reconciles the same component instead of remounting it — without the key the
 * second run would inherit the first run's spent verdict.
 */
function RunRail({
  runId,
  plan,
  phase,
  anchorWeekNumber,
  currentWeekNumber,
}: RailProps) {
  const animate = useRailDrawOnce(runId);

  return (
    <WeekRail
      plan={plan}
      anchorWeekNumber={anchorWeekNumber}
      phase={phase}
      currentWeekNumber={currentWeekNumber}
      completedWeekNumbers={NO_COMPLETED_WEEKS}
      hrefForWeek={(weekNumber) => weekHref(runId, weekNumber)}
      variant="full"
      animate={animate}
    />
  );
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

/**
 * Layout-matched to the real page: eyebrow, headline, sub-line, CTA, the rail's
 * band, two cards. The rail block's numbers mirror WeekRail.module.css's
 * `.full .canvas` padding (2.25rem / 1.75rem) around `--rail-row` (2.75rem), so
 * arrival costs no reflow — which is the shift a skeleton exists to prevent.
 *
 * One announcement, not one per bar: `Skeleton`'s wrapper is its own live
 * region, so only the first carries a label and the rest pass an empty one.
 */
function RunHomeSkeleton() {
  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <Skeleton width="16rem" height="0.875rem" ariaLabel="Loading this course…" />
        <Skeleton width="20rem" height="2.5rem" ariaLabel="" />
        <Skeleton width="26rem" height="1.25rem" ariaLabel="" />
        <Skeleton width="12rem" height="2.75rem" ariaLabel="" />
      </div>
      <div className={styles.railSkeleton}>
        <Skeleton width="100%" height="2.75rem" radius="var(--radius-pill)" ariaLabel="" />
      </div>
      <div className={styles.stack}>
        <Skeleton width="100%" height="9rem" radius="var(--radius-lg)" ariaLabel="" />
        <Skeleton width="100%" height="6rem" radius="var(--radius-lg)" ariaLabel="" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FacilitatorGroupPanel
// ---------------------------------------------------------------------------

/**
 * One facilitated group's tools: its roster, its register, its review queue
 * and its own email lane.
 *
 * A COMPONENT rather than inline JSX because each card needs its own roster
 * fetch, and a hook cannot be called in a loop. That is the whole reason it
 * exists: the page previously drew at most one of these, so the hook could sit
 * at the top of `RunHome` and a facilitator holding two groups got nothing at
 * all.
 *
 * The cohort-wide links (announcements, the weekly nudge) are passed in rather
 * than derived here, and only the first card is asked to draw them: they
 * address the RUN, and repeating them under every group would read as three
 * separate lanes.
 */
function FacilitatorGroupPanel({
  runId,
  group,
  targetWeekNumber,
  showCohortLinks,
}: {
  runId: string;
  group: OverviewGroup;
  /** The published week to link materials for, or null when there isn't one. */
  targetWeekNumber: number | null;
  showCohortLinks: boolean;
}) {
  /*
    The shared hook, the same one the facilitator group page and the email
    composer read from. It carries a manual refresh and a null-vs-zero member
    count that this page uses neither of; what it removes is the second copy of
    the fetch, the stale-response guard and the error copy.
  */
  const roster = useGroupRoster(group.id);
  const groupHref = `/learn/${encodeURIComponent(runId)}/group/${encodeURIComponent(group.id)}`;

  return (
    <Card as="section" padding="md" className={styles.panel}>
      <h3 className={styles.panelTitle}>You facilitate {group.name}</h3>

      {roster.loading && (
        <Skeleton lines={2} height="1.25rem" ariaLabel="Loading the roster…" />
      )}
      {roster.error && <p className={styles.panelNote}>{roster.error.message}</p>}
      {roster.group &&
        (roster.members.length === 0 ? (
          <p className={styles.panelNote}>No one is placed in this group yet.</p>
        ) : (
          /* Names only, because the roster route sends nothing else, and this is a
             cohort surface. InitialsChip is decorative and aria-hidden, so the
             name always renders beside it. */
          <ul className={styles.roster}>
            {roster.members.map((member) => (
              <li key={member.uid} className={styles.rosterItem}>
                <InitialsChip name={member.displayName} uid={member.uid} size="sm" />
                <span>
                  <MemberName name={member.displayName} />
                </span>
              </li>
            ))}
          </ul>
        ))}

      {/* Unconditional, unlike the materials link below: the review queue is
          where a facilitator's own work is, and it stays reachable even in a
          week nobody has published yet. */}
      <Link className={styles.panelLink} href={`${groupHref}/review`}>
        Review exercises
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      {/* Unconditional for the same reason as the review link above: the
          register and the roster are a facilitator's own tools, and they stay
          reachable in a week nobody has published yet. */}
      <Link className={styles.panelLink} href={groupHref}>
        Roster and attendance
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      <Link className={styles.panelLink} href={`${groupHref}/email`}>
        Email the group
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      {/* Only for someone who staffs the RUN (see the `canEmailCohort` prop
          on RunHome). A group facilitator has the link above and not this one:
          their room is theirs, the cohort is not. */}
      {showCohortLinks && (
        <Link
          className={styles.panelLink}
          href={`/learn/${encodeURIComponent(runId)}/email`}
        >
          Email the whole cohort
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}

      {/* Same gate as the cohort link above, and for the same reason: the
          nudge addresses the whole run. Nothing sends it on a schedule, since
          this app has no scheduler, so the link has to exist for it to go out
          at all. */}
      {showCohortLinks && (
        <Link
          className={styles.panelLink}
          href={`/learn/${encodeURIComponent(runId)}/nudge`}
        >
          Send this week&apos;s nudge
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}

      {targetWeekNumber !== null && (
        <Link className={styles.panelLink} href={weekHref(runId, targetWeekNumber)}>
          Open week {targetWeekNumber} materials
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RunHome
// ---------------------------------------------------------------------------

export default function RunHome({ runId, isAdmin, canEmailCohort }: Props) {
  const { data, error, reload } = useRunOverview(runId);

  /*
    THE one magnetic instance in the authed app. `useMagneticPull` is a
    per-instance window mousemove listener plus a layout read per frame, so the
    plan budgets exactly one across the whole learning space and spends it here:
    the Continue CTA is the single action this page exists to get people to.
    Constants are the plan's ({ radius: 90, strength: 0.14, cap: 6 }) — a
    shorter reach and a gentler pull than the landing page's, because this is a
    tool people use daily rather than a page they visit once. The hook opts
    itself out under reduced motion and on coarse pointers.
  */
  const ctaRef = useMagneticPull<HTMLAnchorElement>({
    radius: 90,
    strength: 0.14,
    cap: 6,
  });

  /*
    The groups the caller FACILITATES, not merely the group on the payload.

    The overview sends EVERY group this caller holds: their learner placement
    first (if they have one), then each group they facilitate. Their placement
    is their seat, not their post, so it is subtracted here, because otherwise
    somebody who facilitates the run while sitting in group A would be told
    "you facilitate A".

    A LIST rather than the old single id, and that is the fix: someone running
    two sessions is ordinary here, the payload used to send no group at all in
    that case, and they were left with no link to any roster, register, review
    queue or group email. One card each now.
  */
  const placementGroupId = data?.enrolment?.groupId ?? null;
  const facilitatedGroups = data?.access.isFacilitator
    ? data.groups.filter((g) => g.id !== placementGroupId)
    : [];

  /*
    P10 — the primary mirror trigger. This page is the one a member opens when
    they mean "my course", so it is where the anchor week most often first
    lands on their My Work board. Fire-and-forget: no state, no spinner, no
    error surface (see useSyncTasks' header).

    The gate is an ACTIVE ENROLMENT, which is byte-for-byte the sync-tasks
    route's own: learner or facilitator, and nothing else. Anything looser
    would ask a question the route answers with 403 (an admin or a reviewer
    reading over the cohort's shoulder has no enrolment to mirror), and
    anything tighter would silently deny a facilitator the week's prep task
    the route is willing to give them.

    `access.isEnrolled` is deliberately NOT the gate: it stays true for a
    `completed` enrolment, which has no live week, and it is a mirror of the
    server's decision rather than the enrolment itself.

    The anchor week is dedupe key material only (see useSyncTasks): it is never
    sent, the route always recomputes the week server-side, and passing it is
    what lets a tab left open across a week rollover notice the new week
    instead of resting on a session-wide "already synced this run".
  */
  useSyncTasks(
    runId,
    data?.enrolment?.status === "active",
    data?.currentWeek?.anchorWeekNumber ?? null,
  );

  if (!data) {
    if (error) {
      return (
        <div className={styles.page}>
          <EmptyState
            title="Couldn't load this course"
            body={error.message}
            action={<Button onClick={reload}>Try again</Button>}
          />
        </div>
      );
    }
    return <RunHomeSkeleton />;
  }

  const { run, currentWeek, group, access } = data;
  // The card below is dated to the CURRENT slot, so it is told the CURRENT
  // week's mode — the same `weekDocId(number)` doctrine, and the same
  // fall-back-to-the-anchor rule the overview route resolves the slot fields
  // with, so the room, the link and the "Online this week" chip on this card
  // all describe one session. (`WeekView` asks the same map for the week the
  // reader is actually on; one mode resolved server-side for everybody is the
  // bug that made this a map.)
  const cardWeekNumber = currentWeek
    ? (currentWeek.weekNumber ?? currentWeek.anchorWeekNumber)
    : 0;
  const cardSessionMode =
    cardWeekNumber >= 1 ? (group?.sessionModes[weekDocId(cardWeekNumber)] ?? null) : null;
  const target = weekTargetFor(data);
  const { headline, sub } = heroCopy(data, target);

  const eyebrow = [run.courseTitle, run.label].filter(Boolean).join(" · ");

  const ctaLabel = !target
    ? ""
    : currentWeek?.phase === "before"
      ? "Preview week 1"
      : currentWeek?.phase === "after" || currentWeek?.breakLabel
        ? `Revisit week ${target.weekNumber}`
        : `Continue week ${target.weekNumber}`;

  const showAdmissions = access.isReviewer || access.isTrackLead || isAdmin;

  return (
    <PageEnter className={styles.page}>
      <header className={styles.hero}>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}

        {headline.kind === "week" ? (
          <h1 className={styles.title}>
            Week{" "}
            {/* DigitRoll rolls the leading number and renders any suffix
                static, so "3 of 8" animates the 3 and leaves "of 8" still —
                the counter, not the sentence. */}
            <DigitRoll
              value={
                headline.totalWeeks > 0
                  ? `${headline.weekNumber} of ${headline.totalWeeks}`
                  : String(headline.weekNumber)
              }
            />
          </h1>
        ) : (
          <h1 className={styles.title}>{headline.text}</h1>
        )}

        {sub && <p className={styles.sub}>{sub}</p>}

        {target && (
          <div className={styles.actions}>
            {target.published ? (
              // <Button> renders a real <button> and takes no href, so the
              // navigation target gets the styling rather than the component
              // (the CourseCTA / SessionCard call).
              <Link
                ref={ctaRef}
                className={styles.cta}
                href={weekHref(runId, target.weekNumber)}
              >
                {ctaLabel}
              </Link>
            ) : (
              <>
                {/* A disabled control with no stated reason is a dead end, so
                    the note carries the why. An anchor cannot be disabled;
                    this is the one place the real Button belongs. */}
                <Button disabled>{ctaLabel}</Button>
                <p className={styles.ctaNote}>
                  Week {target.weekNumber} isn&apos;t published yet.
                </p>
              </>
            )}
          </div>
        )}
      </header>

      {run.weekPlan.length > 0 && (
        <RunRail
          key={runId}
          runId={runId}
          plan={run.weekPlan}
          phase={currentWeek?.phase ?? "before"}
          anchorWeekNumber={currentWeek?.anchorWeekNumber ?? 0}
          currentWeekNumber={currentWeek?.weekNumber ?? null}
        />
      )}

      {/* Below the fold: quiet cards, a modest stagger, no second moment.
          Headings here are h3 to match SessionCard's own — one consistent tier
          under the page's h1, rather than a mix this page would have to invent
          an h2 to justify. */}
      <div className={`${styles.stack} ${styles.staggered}`}>
        {group && (
          <SessionCard
            group={group}
            slotStartKey={currentWeek?.slotStartKey ?? null}
            mode={cardSessionMode}
            title={currentWeek?.phase === "before" ? "Your first session" : undefined}
          />
        )}

        {/* One card per group they hold. A single card renders exactly as it
            always did; two or three simply stack, because this column already
            stacks everything else on the page. The cohort-wide links ride on
            the FIRST card only, because they address the run and not a room, so
            repeating them per group would be three copies of one lane. */}
        {facilitatedGroups.map((facilitated, index) => (
          <FacilitatorGroupPanel
            key={facilitated.id}
            runId={runId}
            group={facilitated}
            targetWeekNumber={target?.published ? target.weekNumber : null}
            showCohortLinks={canEmailCohort && index === 0}
          />
        ))}

        {canEmailCohort && facilitatedGroups.length === 0 && (
          /* The same link as in the facilitator panel above, for the people
             that panel never renders for — a run facilitator, track lead or
             admin who holds no group of their own. Without it the announcement
             lane would be reachable only by typing the URL, which is how the
             lane shipped dark in the first place. */
          <Card as="section" padding="md" className={styles.panel}>
            <h3 className={styles.panelTitle}>Cohort announcements</h3>
            <p className={styles.panelNote}>
              One message to everyone subscribed to this run&apos;s channel.
              Announcements only — anything a single group needs goes out from
              that group&apos;s own page instead.
            </p>
            <Link
              className={styles.panelLink}
              href={`/learn/${encodeURIComponent(runId)}/email`}
            >
              Email the whole cohort
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>

            {/* The weekly nudge lives in the same lane and behind the same
                gate. It is prepared for you and sent by you: there is no
                scheduler here, so nothing goes out until someone presses the
                button on that page. */}
            <Link
              className={styles.panelLink}
              href={`/learn/${encodeURIComponent(runId)}/nudge`}
            >
              Send this week&apos;s nudge
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
          </Card>
        )}

        {showAdmissions && (
          /* Reviewers, track leads and admins only. A plain learner must never
             see a route into the applications of the run they are sitting in. */
          <Card as="section" padding="md" className={styles.panel}>
            <h3 className={styles.panelTitle}>Admissions</h3>
            <p className={styles.panelNote}>
              Applications to this run are reviewed in their own queue, separate
              from the cohort.
            </p>
            <Link
              className={styles.panelLink}
              href={`/learn/${encodeURIComponent(runId)}/admissions`}
            >
              Open the admissions queue
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
          </Card>
        )}
      </div>
    </PageEnter>
  );
}

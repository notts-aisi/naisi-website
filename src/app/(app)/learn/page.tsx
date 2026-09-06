"use client";

import { useMemo, type CSSProperties } from "react";
import Link from "next/link";
import PageEnter from "@/components/motion/PageEnter";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Skeleton from "@/components/ui/Skeleton";
import RunCard from "@/features/courses/RunCard";
import { useMyRuns } from "@/features/courses/useMyRuns";
import styles from "./page.module.css";

/**
 * The learning-space hub: every run the member touches, in any role.
 *
 * A client page because `useMyRuns` is a fetch against `/api/courses/me` —
 * the route is the one place the four collections behind a hub row join, and
 * three of them are unreadable from the client by design.
 *
 * Three states, in the order the plan's entrance pattern requires: a
 * layout-matched skeleton grid while loading, then EITHER an empty state or
 * PageEnter-wrapped content. PageEnter mounts on the first render WITH data —
 * never on the loading render with an `animation-delay` standing in for the
 * wait, which animates a guess rather than an arrival.
 *
 * ── ARCHIVED RUNS SIT BELOW, NOT AMONG ──────────────────────────────────────
 * `courseRuns.archived` is the deletion protocol's reversible path, and what
 * it promises is precisely this: the run leaves the live surfaces while the
 * member keeps their history. Dropping the card would break the second half,
 * and leaving it in the main grid would break the first — an archived cohort
 * would keep sitting next to the one somebody is actually on. So it moves to
 * its own section under its own heading, which is also where a run being
 * DESTROYED goes (the cascade sets the same flag before it deletes anything),
 * and the card keeps working as history right up until its rows are gone.
 */

/** Enough cards to fill the fold at the widest main column (64rem cap). */
const SKELETON_COUNT = 3;

export default function LearnPage() {
  const { runs, loading, error } = useMyRuns();

  // The route already sorts archived rows last, so this is a partition of an
  // ordered list rather than a re-sort.
  const { live, archived } = useMemo(
    () => ({
      live: runs.filter((entry) => !entry.archived),
      archived: runs.filter((entry) => entry.archived),
    }),
    [runs],
  );

  return (
    <div>
      <div className={styles.header}>
        <Badge tone="accent">Courses</Badge>
        <h1 className={styles.title}>Your courses</h1>
        <p className={styles.lede}>
          Every fellowship and reading group you&apos;re on: the week your cohort is
          on, the materials for it, and the exercises you owe. A place you&apos;ve
          been offered shows here too, until your group is confirmed.
        </p>
      </div>

      {loading ? (
        <ul className={styles.grid}>
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <li key={i}>
              {/* Only the first placeholder carries a label. Skeleton's
                  wrapper is a live region, and three of them would announce
                  "Loading…" three times for one wait. */}
              <Skeleton
                height="10rem"
                ariaLabel={i === 0 ? "Loading your courses…" : ""}
              />
            </li>
          ))}
        </ul>
      ) : error ? (
        <Card padding="lg">
          {/* The hook preserves the route's own sentence — a member whose
              account is still pending needs to read why, not "failed". */}
          <p className={styles.error}>{error.message}</p>
        </Card>
      ) : runs.length === 0 ? (
        <EmptyState
          title="You're not on a course yet"
          body="NAISI runs fellowships and reading groups each term. The catalogue lists what's open and what's coming."
          action={
            <Link href="/courses" className={styles.browse}>
              Browse courses
            </Link>
          }
        />
      ) : (
        <PageEnter>
          {live.length > 0 && (
            <ul className={styles.grid}>
              {live.map((entry, i) => (
                <li
                  key={entry.runId}
                  className={styles.cell}
                  // The stagger STEP is the --stagger-card token; only the index
                  // comes from JS. Clamped at Reveal's `staggerMax` default so a
                  // long list arrives as a group past the cap rather than
                  // tailing off for seconds.
                  style={{ "--card-index": Math.min(i, 7) } as CSSProperties}
                >
                  <RunCard entry={entry} />
                </li>
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <section className={styles.archivedSection}>
              <div className={styles.header}>
                <h2 className={styles.title}>Archived</h2>
                <p className={styles.lede}>
                  Runs that have been taken out of the way. Nothing was
                  deleted — your progress, your answers and your group are
                  exactly as you left them.
                </p>
              </div>
              <ul className={styles.grid}>
                {archived.map((entry, i) => (
                  <li
                    key={entry.runId}
                    className={styles.cell}
                    style={{ "--card-index": Math.min(i, 7) } as CSSProperties}
                  >
                    <RunCard entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </PageEnter>
      )}
    </div>
  );
}

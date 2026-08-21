"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { collection, getDocs } from "firebase/firestore";
import PageEnter from "@/components/motion/PageEnter";
import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import EmptyState from "@/components/ui/EmptyState";
import ProgressBar from "@/components/ui/ProgressBar";
import Skeleton from "@/components/ui/Skeleton";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCourseWeek } from "@/lib/firestore/courses";
import useRunOverview from "@/features/courses/useRunOverview";
import useRunProgress from "@/features/courses/useRunProgress";
import styles from "./ProgressBody.module.css";

/**
 * The data half of `/learn/[runId]/progress`. Split from `page.tsx` only
 * because the gate is server-side and the data is client-side — a module is
 * either "use client" or it is not, so the two cannot share a file.
 *
 * ── WHERE THE DENOMINATOR COMES FROM ────────────────────────────────────────
 * The overview payload's week INDEX carries titles and publish flags but no
 * item counts, so a bar built from it alone would have a numerator and no
 * denominator — which is not progress, it is a tally. The week docs
 * themselves (`courseRuns/{runId}/weeks`) are `allow read: if isSignedIn()`
 * in the rules, so this reads them directly: one `getDocs`, no route needed,
 * and the counts are the real ones.
 *
 * Completion is counted against the CURRENT item list rather than by grouping
 * progress rows on `weekNumber`: a row left behind by a material the author
 * has since deleted would otherwise push a week past 100%.
 *
 * Optional materials are excluded from every denominator — that is the
 * meaning of the flag (see `Material.optional`), not a choice made here.
 * ────────────────────────────────────────────────────────────────────────────
 */

type Props = { runId: string };

/** Shared empty result. Read-only by contract — nothing here mutates it. */
const EMPTY_ITEMS: Map<number, string[]> = new Map();

type WeekItems = {
  /** Check-offable item ids per week number (materials + checklist). */
  byWeek: Map<number, string[]>;
  loading: boolean;
  error: Error | null;
};

/**
 * The run's check-offable item ids, one shot. Local to this file on purpose:
 * it exists to supply a denominator on one page, and a week page that needs
 * the full week document wants the document, not this projection of it.
 *
 * Key-tagged state (the `useRunProgress` idiom) so `loading` derives on a run
 * switch instead of being reset by a setState in the effect body.
 */
function useRunWeekItems(runId: string): WeekItems {
  const [state, setState] = useState<{
    key: string;
    byWeek: Map<number, string[]>;
    error: Error | null;
  }>({ key: "", byWeek: EMPTY_ITEMS, error: null });

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getDocs(collection(getClientDb(), "courseRuns", runId, "weeks"))
      .then((snap) => {
        if (cancelled) return;
        const byWeek = new Map<number, string[]>();
        for (const doc of snap.docs) {
          const week = normalizeCourseWeek(doc.id, doc.data());
          byWeek.set(week.weekNumber, [
            ...week.materials.filter((m) => !m.optional).map((m) => m.id),
            ...week.checklist.map((c) => c.id),
          ]);
        }
        setState({ key: runId, byWeek, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          key: runId,
          byWeek: EMPTY_ITEMS,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const fresh = state.key === runId;
  if (!runId) return { byWeek: EMPTY_ITEMS, loading: false, error: null };
  if (!fresh) return { byWeek: EMPTY_ITEMS, loading: true, error: null };
  return { byWeek: state.byWeek, loading: false, error: state.error };
}

type WeekRow = {
  weekNumber: number;
  title: string;
  total: number;
  completed: number;
  /** False for weeks that predate the member's join — see the note below. */
  counted: boolean;
  isCurrent: boolean;
};

const SKELETON_ROWS = 4;

export default function ProgressBody({ runId }: Props) {
  const overview = useRunOverview(runId);
  const progress = useRunProgress(runId);
  const weekItems = useRunWeekItems(runId);

  const loading = overview.loading || progress.loading || weekItems.loading;
  // The overview's message is the most specific one available (it carries the
  // route's own sentence), so it wins when several failed at once.
  const error = overview.error ?? weekItems.error ?? progress.error;

  const data = overview.data;
  const byItemId = progress.byItemId;
  const byWeek = weekItems.byWeek;

  /**
   * Weeks BEFORE `joinedWeekNumber` are shown but not counted: a mid-run
   * joiner never had those weeks, and scoring them as 0% would describe a
   * member who is exactly on track as three weeks behind. Facilitators and
   * admins read with no enrolment at all, which is week 1 — nothing excluded.
   */
  const joinedWeek = data?.enrolment?.joinedWeekNumber ?? 1;

  const rows: WeekRow[] = useMemo(() => {
    if (!data) return [];
    const currentWeekNumber = data.currentWeek?.weekNumber ?? null;
    return data.weeks
      .filter((week) => week.published)
      .map((week) => {
        const items = byWeek.get(week.weekNumber) ?? [];
        let completed = 0;
        for (const itemId of items) {
          if (byItemId.get(itemId)?.completed) completed += 1;
        }
        return {
          weekNumber: week.weekNumber,
          title: week.title,
          total: items.length,
          completed,
          counted: week.weekNumber >= joinedWeek,
          isCurrent: week.weekNumber === currentWeekNumber,
        };
      });
  }, [data, byWeek, byItemId, joinedWeek]);

  const totals = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const row of rows) {
      if (!row.counted) continue;
      done += row.completed;
      total += row.total;
    }
    return { done, total };
  }, [rows]);

  if (loading) {
    return (
      <div className={styles.rows}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          // One labelled live region for the whole wait — see the hub page.
          <Skeleton
            key={i}
            height="4.5rem"
            ariaLabel={i === 0 ? "Loading your progress…" : ""}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card padding="lg">
        <p className={styles.note}>{error.message}</p>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No weeks published yet"
        body="Weeks appear here as your facilitators publish them. Nothing to catch up on."
        action={
          <Link href={`/learn/${encodeURIComponent(runId)}`} className={styles.back}>
            Back to the course
          </Link>
        }
      />
    );
  }

  const finished = totals.total > 0 && totals.done === totals.total;

  return (
    <PageEnter className={styles.stack}>
      <Card padding="md" className={styles.summary}>
        <div className={styles.summaryHead}>
          <h2 className={styles.summaryTitle}>Everything so far</h2>
          <span className={styles.summaryCount}>
            {totals.done} of {totals.total}
          </span>
        </div>
        <ProgressBar
          value={totals.done}
          max={totals.total}
          tone={finished ? "success" : "accent"}
          ariaLabel="Overall course progress"
          animateOnMount
        />
        {joinedWeek > 1 && (
          <p className={styles.note}>
            You joined this cohort at week {joinedWeek}, so earlier weeks aren&apos;t
            counted.
          </p>
        )}
      </Card>

      <ol className={styles.rows}>
        {rows.map((row) => (
          <li key={row.weekNumber}>
            <Link
              href={`/learn/${encodeURIComponent(runId)}/weeks/${row.weekNumber}`}
              className={[styles.row, row.counted ? "" : styles.uncounted]
                .filter(Boolean)
                .join(" ")}
            >
              <div className={styles.rowHead}>
                <span className={styles.rowTitle}>
                  Week {row.weekNumber}
                  {row.title ? ` — ${row.title}` : ""}
                </span>
                {row.isCurrent && (
                  <Chip tone="accent" size="sm">
                    This week
                  </Chip>
                )}
                {!row.counted && (
                  <Chip tone="neutral" size="sm">
                    Before you joined
                  </Chip>
                )}
              </div>

              {row.total === 0 ? (
                <p className={styles.rowNote}>Nothing to check off this week.</p>
              ) : (
                <ProgressBar
                  value={row.completed}
                  max={row.total}
                  size="sm"
                  tone={row.completed === row.total ? "success" : "accent"}
                  ariaLabel={`Week ${row.weekNumber} progress`}
                  showLabel
                />
              )}
            </Link>
          </li>
        ))}
      </ol>
    </PageEnter>
  );
}

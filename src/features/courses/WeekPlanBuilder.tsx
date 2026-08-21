"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  COURSE_FIELD_LIMITS,
  weekDocId,
  type WeekPlanEntry,
} from "@/lib/firestore/courses";
import {
  addDaysToKey,
  currentWeekFor,
  isValidDateKey,
} from "@/lib/courses/weekPlan";
import { updateRun } from "./courseMutations";
import styles from "./WeekPlanBuilder.module.css";

/**
 * The run's calendar spine: an ordered list of 7-day slots, each a taught week
 * or a break. Everything the cohort experiences as "what week is it" is
 * computed from this list plus the run's start date, so the builder shows the
 * computed window next to every row — an admin should never have to count
 * Mondays in their head to work out where reading week lands.
 *
 * No drag-and-drop in P1 on purpose: reorder is buttons. The allocation board
 * is where dnd-kit earns its keep; a 12-row list with move up/down is
 * keyboard-operable for free and one less thing to get wrong on touch.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  runId: string;
  /**
   * The SAVED start date (civil "YYYY-MM-DD", "" when unset). The preview
   * column is computed from this, not from an unsaved edit in the meta
   * section — the dates shown are the dates the cohort would actually get.
   */
  startDate: string;
  /** The saved plan. A change of identity (a reload) reseeds the draft. */
  weekPlan: WeekPlanEntry[];
  runAction: ToastRun;
  onSaved: () => void;
  disabled?: boolean;
};

/** Both ends are parsed at T00:00:00Z and formatted in UTC, so the label can
 *  never slide a day across a clock change. */
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function formatDateKey(key: string): string {
  return DAY_MONTH.format(new Date(`${key}T00:00:00Z`));
}

/**
 * Week numbers are positional: the Nth `kind:"week"` row is week N, whatever
 * breaks sit between them. Applied after every mutation so the draft is always
 * canonical and the preview never shows a stale number.
 *
 * `weekId` is deliberately NOT recomputed. It is the `weeks/{wNN}` doc id, and
 * member progress, exercise responses, and attendance registers are all keyed
 * on it (`courseProgress/{runId}__{uid}__{itemId}`,
 * `courseExerciseResponses/{runId}__{uid}__{weekId}__{exerciseId}`). Inserting
 * a week in the middle therefore renumbers the rows after it but leaves their
 * ids — and so their authored curriculum and everyone's saved work — attached
 * to the same slot. That is why `weekId` can legitimately disagree with
 * `weekDocId(weekNumber)` on a plan that has been edited.
 */
function renumber(plan: WeekPlanEntry[]): WeekPlanEntry[] {
  let n = 0;
  return plan.map((entry) => {
    if (entry.kind !== "week") return entry;
    n += 1;
    return { kind: "week", weekNumber: n, weekId: entry.weekId };
  });
}

/** The lowest `wNN` not already used in the plan (ids are never reused while
 *  in play, but a removed row's id becomes free again). */
function nextWeekId(plan: WeekPlanEntry[]): string {
  const used = new Set(
    plan.flatMap((e) => (e.kind === "week" ? [e.weekId] : [])),
  );
  for (let n = 1; n <= COURSE_FIELD_LIMITS.maxWeekPlanEntries; n += 1) {
    const id = weekDocId(n);
    if (!used.has(id)) return id;
  }
  return weekDocId(COURSE_FIELD_LIMITS.maxWeekPlanEntries);
}

export default function WeekPlanBuilder({
  runId,
  startDate,
  weekPlan,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const [plan, setPlan] = useState<WeekPlanEntry[]>(weekPlan);
  const [syncedPlan, setSyncedPlan] = useState<WeekPlanEntry[]>(weekPlan);
  const [planError, setPlanError] = useState<string | null>(null);

  // Reseed whenever the saved plan changes identity (first load, or a reload
  // after any save). Adjusted during render rather than in an effect, per the
  // React docs and TimeField's precedent — an effect here would cost a second
  // render pass and trips the repo's set-state-in-effect lint. One-shot reads,
  // so this can't stomp on a live edit.
  if (weekPlan !== syncedPlan) {
    setSyncedPlan(weekPlan);
    setPlan(weekPlan);
    setPlanError(null);
  }

  // The clock is read once, at mount, not on every render — the "Now" marker
  // must not move mid-interaction. Safe to read here because this builder only
  // ever renders after the run doc has resolved client-side (the editor shows
  // a loading bar until then), so there is no server pass to disagree with.
  const [now] = useState<Date>(() => new Date());

  const hasStart = isValidDateKey(startDate);

  const windows = useMemo(() => {
    if (!hasStart) return null;
    return plan.map((_, i) => {
      const from = addDaysToKey(startDate, i * 7);
      return { from, to: addDaysToKey(from, 6) };
    });
  }, [hasStart, startDate, plan]);

  // The live position, computed from the DRAFT plan — reordering rows moves
  // the "Now" marker before you save, which is the point of the preview.
  const current = useMemo(() => {
    if (!hasStart) return null;
    return currentWeekFor({ startDate, weekPlan: plan }, now);
  }, [hasStart, now, startDate, plan]);

  const full = plan.length >= COURSE_FIELD_LIMITS.maxWeekPlanEntries;
  const dirty = plan !== weekPlan;

  function mutate(next: WeekPlanEntry[]) {
    setPlan(renumber(next));
  }

  function addWeek() {
    if (full) return;
    mutate([...plan, { kind: "week", weekNumber: 0, weekId: nextWeekId(plan) }]);
  }

  function addBreak() {
    if (full) return;
    mutate([...plan, { kind: "break", label: "" }]);
  }

  function removeAt(index: number) {
    const next = plan.slice();
    next.splice(index, 1);
    mutate(next);
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= plan.length) return;
    const next = plan.slice();
    [next[index], next[target]] = [next[target], next[index]];
    mutate(next);
  }

  function setBreakLabel(index: number, label: string) {
    const next = plan.slice();
    const entry = next[index];
    if (entry.kind !== "break") return;
    next[index] = { kind: "break", label };
    mutate(next);
  }

  async function save() {
    // A nameless break renders to the cohort as an unexplained gap in the
    // week rail, so it is caught here rather than shipped.
    const unlabelled = plan.findIndex(
      (e) => e.kind === "break" && !e.label.trim(),
    );
    if (unlabelled !== -1) {
      setPlanError(
        `Slot ${unlabelled + 1} is a break with no label — name it (e.g. "Reading week").`,
      );
      return;
    }
    setPlanError(null);

    let ok = false;
    await runAction(
      async () => {
        await updateRun(runId, { weekPlan: plan });
        ok = true;
      },
      { savingMessage: "Saving week plan…", successMessage: "Week plan saved" },
    );
    // Only reload on success — reseeding the draft after a failure would throw
    // away the edit the admin still needs to retry.
    if (ok) onSaved();
  }

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <p className={styles.hint}>
          Each row is one seven-day slot. Weeks are numbered by their position,
          so adding a break shifts the calendar without renumbering the
          curriculum. Dates below are computed from the run&apos;s saved start
          date.
        </p>
        {!hasStart && (
          <p className={styles.warn}>
            Set a start date in Run details to see the calendar preview.
          </p>
        )}
        {current && current.phase === "before" && (
          <p className={styles.hint}>
            This run hasn&apos;t started yet — week 1 opens {formatDateKey(startDate)}.
          </p>
        )}
        {current && current.phase === "after" && (
          <p className={styles.hint}>Every slot in this plan has now elapsed.</p>
        )}
      </div>

      {plan.length === 0 && (
        <p className={styles.empty}>
          No slots yet. Add the taught weeks in order, dropping a break in
          wherever the cohort pauses.
        </p>
      )}

      <ol className={styles.rows}>
        {plan.map((entry, i) => {
          const isNow = current?.planIndex === i;
          const window = windows?.[i];
          return (
            <li
              key={entry.kind === "week" ? entry.weekId : `break-${i}`}
              className={isNow ? `${styles.row} ${styles.rowNow}` : styles.row}
            >
              <span className={styles.index} aria-hidden>
                {i + 1}
              </span>

              <div className={styles.body}>
                {entry.kind === "week" ? (
                  <span className={styles.weekName}>
                    Week {entry.weekNumber}
                    <span className={styles.weekId}>{entry.weekId}</span>
                  </span>
                ) : (
                  <Input
                    value={entry.label}
                    onChange={(e) => setBreakLabel(i, e.target.value)}
                    placeholder="Break label, e.g. Reading week"
                    maxLength={COURSE_FIELD_LIMITS.runLabel}
                    disabled={disabled}
                    aria-label={`Break label for slot ${i + 1}`}
                  />
                )}
              </div>

              <div className={styles.preview}>
                {window ? (
                  <span className={styles.window}>
                    {formatDateKey(window.from)} – {formatDateKey(window.to)}
                  </span>
                ) : (
                  <span className={styles.windowMuted}>—</span>
                )}
                {isNow && (
                  <span className={styles.nowChip}>
                    {current?.weekNumber !== null ? "This week" : "On break now"}
                  </span>
                )}
              </div>

              <div className={styles.controls}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => move(i, -1)}
                  disabled={disabled || i === 0}
                  aria-label={`Move slot ${i + 1} earlier`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => move(i, 1)}
                  disabled={disabled || i === plan.length - 1}
                  aria-label={`Move slot ${i + 1} later`}
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() => removeAt(i)}
                  disabled={disabled}
                  aria-label={`Remove slot ${i + 1}`}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {planError && <p className={styles.error}>{planError}</p>}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addWeek}
          disabled={disabled || full}
        >
          Add week
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addBreak}
          disabled={disabled || full}
        >
          Add break
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {plan.filter((e) => e.kind === "week").length} weeks ·{" "}
          {plan.filter((e) => e.kind === "break").length} breaks ·{" "}
          {plan.length}/{COURSE_FIELD_LIMITS.maxWeekPlanEntries} slots
        </span>
        <Button type="button" onClick={save} disabled={disabled || !dirty}>
          Save week plan
        </Button>
      </div>
    </div>
  );
}

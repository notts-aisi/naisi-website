"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";
import {
  COURSE_FIELD_LIMITS,
  COURSE_RUN_STATUS_LABEL,
  normalizeCourseRun,
  weekDocId,
  type CourseRunStatus,
  type WeekPlanEntry,
} from "@/lib/firestore/courses";
import {
  addDaysToKey,
  currentWeekFor,
  isValidDateKey,
} from "@/lib/courses/weekPlan";
import {
  normaliseRunWeekIds,
  updateRun,
  weekAddressDrift,
  type WeekIdMove,
} from "./courseMutations";
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
  /**
   * The run's lifecycle status, which decides whether the plan is still
   * reshapeable (see the lock below).
   *
   * Optional, and resolved by a single `getDoc` when it isn't given, so the
   * lock is live whether or not the parent editor threads it through. Pass it
   * and the read goes away; the one-line integration is
   * `status={run.status}` on the `<WeekPlanBuilder>` in `RunEditor.tsx`.
   */
  status?: CourseRunStatus;
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

/** Hover copy on every control the week-plan lock has taken away. */
const LOCK_TITLE = "The week plan is locked once a run leaves draft";

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

/**
 * The dry run's result, in two sentences rather than one list.
 *
 * A move with `hasDoc: false` re-addresses a slot the admin has not written
 * yet, so the batch copies nothing for it. Announcing it as "Will move w05 to
 * w01" describes a write that never happens and pads the list past the moves
 * that do.
 */
function PreviewLine({ moves }: { moves: WeekIdMove[] }) {
  const real = moves.filter((m) => m.hasDoc);
  const planOnly = moves.length - real.length;
  if (moves.length === 0) {
    return <p className={styles.hint}>Nothing to move. The plan is already lined up.</p>;
  }
  return (
    <p className={styles.hint}>
      {real.length > 0
        ? `Will move ${real.map((m) => `${m.from} to ${m.to}`).join(", ")}.`
        : "No week has content to move."}
      {planOnly > 0
        ? ` ${planOnly === 1 ? "1 slot is" : `${planOnly} slots are`} re-addressed with no document to move.`
        : ""}
    </p>
  );
}

export default function WeekPlanBuilder({
  runId,
  startDate,
  weekPlan,
  status: statusProp,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const [plan, setPlan] = useState<WeekPlanEntry[]>(weekPlan);
  const [syncedPlan, setSyncedPlan] = useState<WeekPlanEntry[]>(weekPlan);
  const [planError, setPlanError] = useState<string | null>(null);
  const { role, permissions } = useAuth();
  const isAdmin = role === "admin";
  // The normalise route is gated to admins and `approveCourse` holders, and the
  // drift panel opens for anyone who can open the run editor at all. Without
  // this the run's drafter-owner and its track leads got a bare "Forbidden"
  // from a button the page had just offered them. The explanation stays
  // visible for everyone: knowing the two ids disagree is useful even to
  // someone who cannot be the one to reconcile them.
  const canNormalise = isAdmin || permissions.approveCourse === true;

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

  // The status fallback for a parent that doesn't pass one. Starts null, which
  // reads as LOCKED — a plan that is briefly un-reorderable is a much smaller
  // harm than one that offers a reorder the rules are about to refuse, and the
  // read resolves in a round trip. A parent that passes `status` never gets
  // here at all.
  const [fetchedStatus, setFetchedStatus] = useState<CourseRunStatus | null>(null);
  useEffect(() => {
    if (statusProp !== undefined) return;
    let live = true;
    void (async () => {
      try {
        const snap = await getDoc(doc(getClientDb(), "courseRuns", runId));
        if (!live || !snap.exists()) return;
        setFetchedStatus(normalizeCourseRun(snap.id, snap.data()).status);
      } catch {
        // Leave it locked. The run doc is already on screen via the parent, so
        // a failure here is a transient read, not a missing run.
      }
    })();
    return () => {
      live = false;
    };
  }, [runId, statusProp]);

  const [normalising, setNormalising] = useState(false);
  const [preview, setPreview] = useState<WeekIdMove[] | null>(null);

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

  // THE LOCK. Weeks are reorderable before publishing, not after. Once a run
  // leaves draft the plan's positions are load-bearing: the Nth taught slot IS
  // week N to every member surface, so moving or removing one renumbers every
  // slot after it and repoints the cohort's week pages, registers, mirrored
  // tasks and exercise answers at documents nobody arranged. `firestore.rules`
  // pins `weekPlan` for non-admins from the same boundary; this is the
  // affordance half, so the button is gone before the write is refused.
  //
  // Adding at the END and inserting a break are not the same hazard (they
  // renumber nothing already taught, they only shift later dates), so they
  // stay reachable to admins with the warning below.
  const status = statusProp ?? fetchedStatus;
  const locked = status !== "draft";
  const canReshape = !locked;
  const canGrow = !locked || isAdmin;

  const full = plan.length >= COURSE_FIELD_LIMITS.maxWeekPlanEntries;
  const dirty = plan !== weekPlan;

  // The two spellings of a week, and where they disagree. Only actionable in
  // draft, so the affordance is scoped to exactly that.
  const drift = useMemo(() => weekAddressDrift(weekPlan), [weekPlan]);

  function mutate(next: WeekPlanEntry[]) {
    setPlan(renumber(next));
  }

  function addWeek() {
    if (full || !canGrow) return;
    mutate([...plan, { kind: "week", weekNumber: 0, weekId: nextWeekId(plan) }]);
  }

  function addBreak() {
    if (full || !canGrow) return;
    mutate([...plan, { kind: "break", label: "" }]);
  }

  function removeAt(index: number) {
    if (!canReshape) return;
    const next = plan.slice();
    next.splice(index, 1);
    mutate(next);
  }

  function move(index: number, dir: -1 | 1) {
    if (!canReshape) return;
    const target = index + dir;
    if (target < 0 || target >= plan.length) return;
    const next = plan.slice();
    [next[index], next[target]] = [next[target], next[index]];
    mutate(next);
  }

  /**
   * Ask the route what it WOULD move, then, on a second press, let it move it.
   * Two presses rather than a confirm dialog because the interesting content
   * is the list of moves, and a dialog would either hide it or repeat it.
   */
  async function normalise(apply: boolean) {
    setPlanError(null);
    setNormalising(true);
    try {
      if (!apply) {
        const result = await normaliseRunWeekIds(runId, { dryRun: true });
        setPreview(result.moves);
        return;
      }
      let ok = false;
      await runAction(
        async () => {
          await normaliseRunWeekIds(runId);
          ok = true;
        },
        {
          savingMessage: "Normalising week ids…",
          successMessage: "Week ids normalised",
        },
      );
      if (ok) {
        setPreview(null);
        onSaved();
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Couldn't read the moves.");
    } finally {
      setNormalising(false);
    }
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

        {/* Nothing at all until the status is known. The controls are already
            locked while it resolves (see the fallback above), and announcing
            "checking whether this run is still a draft" on every open of a
            draft is a notice about the component's plumbing, not about the
            run. A parent that passes `status` never renders this at all. */}
        {locked && status && (
          <p className={styles.warn}>
            {`This run is ${COURSE_RUN_STATUS_LABEL[status].toLowerCase()}, so its weeks can no longer be reordered or removed.`}{" "}
            {isAdmin
              ? "You can still add a slot at the end, which shifts every date after it."
              : "An admin can still add a slot at the end."}
          </p>
        )}
        {locked && status && isAdmin && (
          <p className={styles.hint}>
            Adding a slot to a live run moves every later week by seven days.
            Tell the cohort before you save.
          </p>
        )}
      </div>

      {!locked && drift.length > 0 && (
        <div className={styles.drift}>
          <p className={styles.driftTitle}>
            {drift.length === 1
              ? "One week is addressed two different ways."
              : `${drift.length} weeks are addressed two different ways.`}
          </p>
          <p className={styles.hint}>
            Reordering a plan keeps each slot&apos;s document id so authored
            content follows the slot, but every learner page derives the id from
            the week number instead. On a live run the two would resolve
            different documents. While the run is a draft there is nothing keyed
            on the old ids, so they can still be lined up for free.
          </p>
          <ul className={styles.driftList}>
            {drift.map((d) => (
              <li key={d.weekNumber} className={styles.driftRow}>
                Week {d.weekNumber}: editors open{" "}
                <span className={styles.weekId}>{d.planWeekId}</span>, learners
                open <span className={styles.weekId}>{d.canonicalWeekId}</span>
              </li>
            ))}
          </ul>
          {/* A slot with no authored document has nothing to move: listing
              "Will move w05 to w01" for it describes a write that never
              happens, and buries the ones that do. The two are counted apart. */}
          {preview && <PreviewLine moves={preview} />}
          {canNormalise ? (
            <div className={styles.driftActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void normalise(false)}
                disabled={disabled || normalising}
              >
                {preview ? "Re-check moves" : "Preview the moves"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void normalise(true)}
                disabled={disabled || normalising || !preview || preview.length === 0}
              >
                Normalise week ids
              </Button>
            </div>
          ) : (
            <p className={styles.hint}>
              Lining the two ids up is an admin or course-approver job, and it
              can only be done while this run is a draft. Ask one of them before
              the run opens for applications, after which it is fixed for good.
            </p>
          )}
        </div>
      )}

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
                    disabled={disabled || !canGrow}
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
                  disabled={disabled || !canReshape || i === 0}
                  aria-label={`Move slot ${i + 1} earlier`}
                  title={canReshape ? "Move up" : LOCK_TITLE}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => move(i, 1)}
                  disabled={disabled || !canReshape || i === plan.length - 1}
                  aria-label={`Move slot ${i + 1} later`}
                  title={canReshape ? "Move down" : LOCK_TITLE}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() => removeAt(i)}
                  disabled={disabled || !canReshape}
                  aria-label={`Remove slot ${i + 1}`}
                  title={canReshape ? "Remove" : LOCK_TITLE}
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
          disabled={disabled || full || !canGrow}
          title={canGrow ? undefined : LOCK_TITLE}
        >
          Add week
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addBreak}
          disabled={disabled || full || !canGrow}
          title={canGrow ? undefined : LOCK_TITLE}
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

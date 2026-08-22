"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import {
  addDaysToKey,
  currentWeekFor,
  isValidDateKey,
  type WeekPlanEntry,
} from "@/lib/courses/weekPlan";
import { resolveCalendar } from "@/lib/courses/groupResolve";
import { COURSE_FIELD_LIMITS } from "@/lib/firestore/courses";
import { patchGroupPace } from "./useGroupWeeks";
import styles from "./GroupPaceEditor.module.css";

/**
 * A group's own schedule — or, by default, no schedule of its own at all.
 *
 * ── NULL IS THE DEFAULT AND IT IS NOT "EMPTY" ───────────────────────────────
 * `paceStartDate` and `paceWeekPlan` are null until a facilitator sets them,
 * and null means TRACKING: the group is paced by the run, and a change the
 * course makes to its calendar moves this group with it. That is the state
 * almost every group should be in, so it is the state this component opens in,
 * and it opens showing the course's dates rather than a blank form — the
 * question "when does my group meet?" has an answer before anyone edits
 * anything.
 *
 * Setting a schedule is one button, and clearing it back to tracking is
 * another. Nothing here half-overrides: the route takes both fields, and the
 * "back to the course schedule" action sends null for both, because a group
 * with its own start date and the course's plan (or vice versa) is a state
 * nobody asked for and everybody would have to reason about.
 *
 * ── THE PLAN IS REORDERED, NOT INVENTED ─────────────────────────────────────
 * The rows are the run's own weeks. A group can move a week later, drop a
 * break in front of it, or take a week out of its own calendar — but it cannot
 * conjure a week id the course never authored, because `wNN` is the doc id that
 * everyone's progress, exercise responses and attendance are keyed on and a
 * group pointing at a week nobody wrote is a slot that renders nothing. So
 * "Add week" offers the run's weeks that this plan is not already using, and
 * runs out when they are all placed.
 *
 * ── THE RESOLVER OWNS "WHICH CALENDAR" ──────────────────────────────────────
 * The effective calendar is `resolveCalendar(run, group)` and never a local
 * ternary, so this editor and the member's week page, rail, banner and nudge
 * email all agree by construction about which dates are in force.
 */

type Props = {
  groupId: string;
  groupName: string;
  /** The run's calendar — what the group falls back to. */
  runStartDate: string;
  runWeekPlan: WeekPlanEntry[];
  /** The group's overrides as stored. Null on either = tracking the run. */
  paceStartDate: string | null;
  paceWeekPlan: WeekPlanEntry[] | null;
};

/** Both ends parsed at T00:00:00Z and formatted in UTC — see WeekPlanBuilder. */
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const FULL_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatDateKey(key: string): string {
  return isValidDateKey(key) ? DAY_MONTH.format(new Date(`${key}T00:00:00Z`)) : "—";
}

function formatFullDate(key: string): string {
  return isValidDateKey(key) ? FULL_DATE.format(new Date(`${key}T00:00:00Z`)) : "—";
}

/**
 * Week numbers are positional: the Nth `kind:"week"` row is week N, whatever
 * breaks sit between them. `weekId` is deliberately NOT recomputed — it is the
 * `weeks/{wNN}` doc id that progress and responses are keyed on.
 */
function renumber(plan: WeekPlanEntry[]): WeekPlanEntry[] {
  let n = 0;
  return plan.map((entry) => {
    if (entry.kind !== "week") return entry;
    n += 1;
    return { kind: "week", weekNumber: n, weekId: entry.weekId };
  });
}

/** The run's week ids, in the run's own order. */
function runWeekIds(plan: WeekPlanEntry[]): string[] {
  return plan.flatMap((e) => (e.kind === "week" ? [e.weekId] : []));
}

export default function GroupPaceEditor({
  groupId,
  groupName,
  runStartDate,
  runWeekPlan,
  paceStartDate,
  paceWeekPlan,
}: Props) {
  const router = useRouter();
  const { toast, run: runAction, dismiss } = useActionToast();

  const tracking = paceStartDate === null && paceWeekPlan === null;

  // The calendar in force RIGHT NOW, through the one shared resolver.
  const effective = useMemo(
    () =>
      resolveCalendar(
        { startDate: runStartDate, weekPlan: runWeekPlan },
        { paceStartDate, paceWeekPlan },
      ),
    [runStartDate, runWeekPlan, paceStartDate, paceWeekPlan],
  );

  const [editing, setEditing] = useState(!tracking);
  const [startDraft, setStartDraft] = useState(effective.startDate);
  const [planDraft, setPlanDraft] = useState<WeekPlanEntry[]>(effective.weekPlan);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Reseed whenever the saved values change identity (a refresh after a save),
  // adjusted during render rather than in an effect — the WeekPlanBuilder
  // precedent, and the repo's set-state-in-effect lint.
  const [synced, setSynced] = useState(effective);
  if (effective !== synced) {
    setSynced(effective);
    setStartDraft(effective.startDate);
    setPlanDraft(effective.weekPlan);
    setEditing(effective.source === "group");
    setError(null);
  }

  // The clock is read once, at mount: the "now" marker must not move mid-edit.
  const [now] = useState<Date>(() => new Date());

  /** The run's own window for each week id, to measure drift against. */
  const runWindows = useMemo(() => {
    const map = new Map<string, string>();
    if (!isValidDateKey(runStartDate)) return map;
    runWeekPlan.forEach((entry, i) => {
      if (entry.kind === "week") map.set(entry.weekId, addDaysToKey(runStartDate, i * 7));
    });
    return map;
  }, [runStartDate, runWeekPlan]);

  const hasStart = isValidDateKey(startDraft);

  const windows = useMemo(() => {
    if (!hasStart) return null;
    return planDraft.map((_, i) => {
      const from = addDaysToKey(startDraft, i * 7);
      return { from, to: addDaysToKey(from, 6) };
    });
  }, [hasStart, startDraft, planDraft]);

  const current = useMemo(() => {
    if (!hasStart) return null;
    try {
      return currentWeekFor({ startDate: startDraft, weekPlan: planDraft }, now);
    } catch {
      return null;
    }
  }, [hasStart, startDraft, planDraft, now]);

  const usedWeekIds = useMemo(
    () => new Set(planDraft.flatMap((e) => (e.kind === "week" ? [e.weekId] : []))),
    [planDraft],
  );
  const spareWeekIds = useMemo(
    () => runWeekIds(runWeekPlan).filter((id) => !usedWeekIds.has(id)),
    [runWeekPlan, usedWeekIds],
  );

  const full = planDraft.length >= COURSE_FIELD_LIMITS.maxWeekPlanEntries;
  const dirty =
    startDraft !== effective.startDate ||
    JSON.stringify(planDraft) !== JSON.stringify(effective.weekPlan);

  function mutate(next: WeekPlanEntry[]) {
    setPlanDraft(renumber(next));
  }

  function addWeek() {
    const id = spareWeekIds[0];
    if (!id || full) return;
    mutate([...planDraft, { kind: "week", weekNumber: 0, weekId: id }]);
  }

  function addBreak() {
    if (full) return;
    mutate([...planDraft, { kind: "break", label: "" }]);
  }

  function removeAt(index: number) {
    const next = planDraft.slice();
    next.splice(index, 1);
    mutate(next);
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= planDraft.length) return;
    const next = planDraft.slice();
    [next[index], next[target]] = [next[target], next[index]];
    mutate(next);
  }

  function setBreakLabel(index: number, label: string) {
    const next = planDraft.slice();
    if (next[index].kind !== "break") return;
    next[index] = { kind: "break", label };
    mutate(next);
  }

  async function save() {
    if (!isValidDateKey(startDraft)) {
      setError("Pick the day your group's week 1 begins.");
      return;
    }
    const unlabelled = planDraft.findIndex(
      (e) => e.kind === "break" && !e.label.trim(),
    );
    if (unlabelled !== -1) {
      setError(
        `Slot ${unlabelled + 1} is a break with no label — name it (e.g. "Reading week").`,
      );
      return;
    }
    setError(null);
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        await patchGroupPace(groupId, {
          paceStartDate: startDraft,
          paceWeekPlan: planDraft,
        });
        ok = true;
      },
      {
        savingMessage: "Saving your group's schedule…",
        successMessage: `${groupName} now runs to its own schedule`,
      },
    );
    setBusy(false);
    // The saved values live on the group doc, which this client cannot read —
    // the page shell reads it server-side. Refresh so the state line, the
    // divergence chips and the week index all show what was actually stored.
    if (ok) router.refresh();
  }

  async function clearBack() {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        await patchGroupPace(groupId, { paceStartDate: null, paceWeekPlan: null });
        ok = true;
      },
      {
        savingMessage: "Going back to the course schedule…",
        successMessage: `${groupName} follows the course schedule again`,
      },
    );
    setBusy(false);
    setClearing(false);
    if (ok) router.refresh();
  }

  // ---- Tracking, and not yet editing: the course's schedule, plainly ----
  if (!editing) {
    return (
      <>
        <Card as="section" padding="lg">
          <h2 className={styles.sectionTitle}>Schedule</h2>
          <p className={styles.hint}>
            {groupName} follows the course&apos;s schedule. If the course moves a
            week or adds a reading week, your group moves with it — you do not
            have to do anything. Set your own only if this group genuinely runs to
            different dates.
          </p>

          <p className={styles.state}>
            <span>Week 1 begins</span>
            <span className={styles.stateValue}>
              {formatFullDate(effective.startDate)}
            </span>
            <span>·</span>
            <span className={styles.stateValue}>
              {effective.weekPlan.filter((e) => e.kind === "week").length} weeks,{" "}
              {effective.weekPlan.filter((e) => e.kind === "break").length} breaks
            </span>
          </p>

          {!isValidDateKey(effective.startDate) && (
            <p className={`${styles.warn} ${styles.spaced}`}>
              The course has no start date yet, so there are no dates to show. Your
              group can still have its own — but check with the course team first;
              theirs is probably about to arrive.
            </p>
          )}

          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              Set {groupName}&apos;s own schedule
            </Button>
            <span className={styles.count}>
              Starts from a copy of the course&apos;s dates — nothing changes until
              you save.
            </span>
          </div>
        </Card>

        <ActionToast toast={toast} onDismiss={dismiss} />
      </>
    );
  }

  // ---- Editing (or already overridden) ----
  return (
    <>
      <Card as="section" padding="lg">
        <h2 className={styles.sectionTitle}>Schedule</h2>
        <p className={styles.hint}>
          Each row is one seven-day slot for {groupName}. Weeks are numbered by
          position, so dropping a break in shifts your group&apos;s calendar
          without renumbering the curriculum. These dates drive your group&apos;s
          week page, its rail, its reminder emails and its register — and nobody
          else&apos;s.
        </p>

        <p className={styles.state}>
          {tracking ? (
            <>
              <span>Right now</span>
              <span className={styles.stateValue}>
                {groupName} still follows the course schedule
              </span>
              <span>— nothing below is saved yet.</span>
            </>
          ) : (
            <>
              <span>Right now</span>
              <span className={styles.stateValue}>
                {groupName} runs to its own schedule
              </span>
              <span>
                — the course&apos;s week 1 is {formatFullDate(runStartDate)}.
              </span>
            </>
          )}
        </p>

        <div className={`${styles.fields} ${styles.spaced}`}>
          <Field
            id="group-pace-start"
            label="Week 1 begins"
            hint="The day your group's week 1 starts. Every window below counts forward from here."
          >
            {/* A native date input, on purpose: this IS the civil date string
                "YYYY-MM-DD". A popover would invent an instant and a timezone
                the data model deliberately does not have. */}
            <Input
              id="group-pace-start"
              type="date"
              value={startDraft}
              onChange={(e) => setStartDraft(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        {planDraft.length === 0 && (
          <p className={`${styles.empty} ${styles.spaced}`}>
            No slots. Add the weeks your group teaches, in the order it teaches
            them.
          </p>
        )}

        <ol className={styles.rows}>
          {planDraft.map((entry, i) => {
            const isNow = current?.planIndex === i;
            const window = windows?.[i];
            const runFrom =
              entry.kind === "week" ? (runWindows.get(entry.weekId) ?? null) : null;
            const drift =
              window && runFrom && window.from !== runFrom
                ? Math.round(
                    (Date.parse(`${window.from}T00:00:00Z`) -
                      Date.parse(`${runFrom}T00:00:00Z`)) /
                      86_400_000,
                  )
                : 0;

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
                      disabled={busy}
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
                  {drift !== 0 && (
                    <span className={styles.drift}>
                      {Math.abs(drift)} day{Math.abs(drift) === 1 ? "" : "s"}{" "}
                      {drift > 0 ? "later" : "earlier"} than the course
                    </span>
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
                    disabled={busy || i === 0}
                    aria-label={`Move slot ${i + 1} earlier`}
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => move(i, 1)}
                    disabled={busy || i === planDraft.length - 1}
                    aria-label={`Move slot ${i + 1} later`}
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    onClick={() => removeAt(i)}
                    disabled={busy}
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

        {spareWeekIds.length > 0 && (
          <p className={`${styles.hint} ${styles.spaced}`}>
            {spareWeekIds.length} of the course&apos;s weeks{" "}
            {spareWeekIds.length === 1 ? "is" : "are"} not in your group&apos;s
            schedule ({spareWeekIds.join(", ")}). Your group will never see{" "}
            {spareWeekIds.length === 1 ? "it" : "them"} until you add{" "}
            {spareWeekIds.length === 1 ? "it" : "them"} back.
          </p>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addWeek}
            disabled={busy || full || spareWeekIds.length === 0}
          >
            Add week
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addBreak}
            disabled={busy || full}
          >
            Add break
          </Button>
          <span className={styles.spacer} />
          <span className={styles.count}>
            {planDraft.filter((e) => e.kind === "week").length} weeks ·{" "}
            {planDraft.filter((e) => e.kind === "break").length} breaks ·{" "}
            {planDraft.length}/{COURSE_FIELD_LIMITS.maxWeekPlanEntries} slots
          </span>
          <Button type="button" onClick={save} disabled={busy || (!dirty && !tracking)}>
            {tracking ? "Use this schedule" : "Save schedule"}
          </Button>
        </div>

        <div className={styles.actions}>
          {tracking ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setStartDraft(effective.startDate);
                setPlanDraft(effective.weekPlan);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel — keep following the course
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setClearing(true)}
              disabled={busy}
            >
              Go back to the course schedule
            </Button>
          )}
        </div>
      </Card>

      <Modal
        open={clearing}
        onClose={() => setClearing(false)}
        ariaLabel="Go back to the course schedule"
        width="sm"
      >
        <div className={styles.confirm}>
          <h2 className={styles.confirmTitle}>Go back to the course schedule?</h2>
          <p className={styles.confirmBody}>
            {groupName} would be paced by the course again, starting{" "}
            {formatFullDate(runStartDate)}. Your group&apos;s own dates are
            discarded — there is no copy kept.
          </p>
          <p className={styles.confirmBody}>
            Everyone&apos;s week pages, reminders and register move to the
            course&apos;s dates the moment this saves, so a member part-way
            through a week can find themselves in a different one. Your
            group&apos;s customised WEEK CONTENT is untouched either way — this is
            only the calendar.
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" onClick={() => setClearing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={clearBack} disabled={busy}>
              Follow the course schedule
            </Button>
          </div>
        </div>
      </Modal>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

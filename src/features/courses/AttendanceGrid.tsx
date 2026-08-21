"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import MemberName from "@/components/ui/MemberName";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import Skeleton from "@/components/ui/Skeleton";
import {
  ATTENDANCE_STATUS_LABEL,
  type AttendanceStatus,
} from "@/lib/firestore/courseAttendance";
import styles from "./AttendanceGrid.module.css";
import useAttendance, {
  type AttendanceMark,
  type AttendanceMember,
  type AttendanceWeek,
} from "./useAttendance";

/**
 * THE ATTENDANCE REGISTER — one group, every week so far, everyone in it.
 *
 * ── IT IS A REAL TABLE ──────────────────────────────────────────────────────
 * `<table>` with `<th scope="col">` weeks and `<th scope="row">` names, because
 * that is what it is: a screen reader announces "Ada Lovelace, Week 3, Present"
 * from the headers alone, and keyboard users get the table navigation their
 * software already provides. A grid of divs would need every one of those
 * behaviours reimplemented, badly.
 *
 * ── WHAT MOVES, AND WHAT NEVER DOES ─────────────────────────────────────────
 * Cell BACKGROUND and glyph SCALE animate. Row and column geometry NEVER does
 * (the plan states this as a rule for this component specifically): a register
 * is read by scanning across a row and down a column, and a width or height
 * that animates drags every other cell out from under the eye that is scanning
 * it. Nothing here transitions width, height, padding or the grid's tracks.
 *
 * The glyph pops only where the FACILITATOR just acted — see `pop()`. Mounting
 * a half-marked register would otherwise fire thirty pops at once on load,
 * which reads as the page glitching rather than as feedback.
 *
 * ── OPTIMISTIC, WITH TWO FEEDBACK CHANNELS ──────────────────────────────────
 * `useAttendance.mark` moves the cell before the network answers and puts it
 * back if the answer is no. Which channel reports that follows the plan's rule:
 *  · ONE TAP is keep-working feedback → inline (`SavedFlash`, plus the route's
 *    own sentence on failure — see `cellError`).
 *  · A BULK column mark is must-not-continue → `ActionToast`, which dims the
 *    page until the facilitator has read the outcome.
 *
 * ── MID-RUN JOINERS (plan risk #5) ──────────────────────────────────────────
 * Cells before a member's `joinedWeekNumber` are INERT — a dash, not an
 * unmarked cell, with an aria-label that says why. Rendering them as markable
 * would invite a register that says someone was absent from sessions that
 * happened before they existed to the group. The route refuses those writes
 * too; this is the visible half of one rule.
 *
 * PII: names arrive as `displayName` and render through `MemberName`. There is
 * no email anywhere in this component's data, by construction.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AttendanceGridProps = {
  /** The group whose register this is. Everything else is server-derived. */
  groupId: string;
  /**
   * Accepted for symmetry with the review page's callsite and deliberately
   * unused: the register's run comes off the group document server-side, so a
   * run id in the URL can never disagree with the one the marks are stored
   * under.
   */
  runId?: string;
};

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/**
 * unmarked → present → absent → excused → late → unmarked.
 *
 * Present first because it is the overwhelmingly common answer, and the whole
 * gesture is "tap everyone who came". `null` (unmarked) is IN the cycle, not
 * an escape hatch beside it: a mis-tap must be undoable with more taps, never
 * with a modifier key or a second control.
 */
const CYCLE: Array<AttendanceStatus | null> = [
  "present",
  "absent",
  "excused",
  "late",
  null,
];

function nextStatus(current: AttendanceStatus | null): AttendanceStatus | null {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length];
}

/**
 * Tick and cross are read without a legend; excused and late are lettered and
 * decoded by the legend above the table. Colour is never the only signal —
 * each status has its own glyph as well as its own tone.
 */
const GLYPH: Record<AttendanceStatus, string> = {
  present: "✓",
  absent: "✕",
  excused: "E",
  late: "L",
};

/**
 * An unmarked cell is not blank. A faint dot says "this is a control that has
 * not been used", which is the state a facilitator is scanning for; an empty
 * 44px square reads as a gap in the table instead.
 */
const UNMARKED_GLYPH = "·";

const STATUS_CLASS: Record<AttendanceStatus, string> = {
  present: styles.isPresent,
  absent: styles.isAbsent,
  excused: styles.isExcused,
  late: styles.isLate,
};

/** A beat over `--dur-settle` (260ms), so the pop class outlives its own animation. */
const POP_MS = 320;

const NO_POPS: ReadonlySet<string> = new Set();

function cellKey(weekNumber: number, uid: string): string {
  return `${weekNumber} ${uid}`;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * Layout-matched to the real thing so arrival costs no reflow. One
 * announcement, not one per bar: `Skeleton`'s wrapper is its own live region,
 * so only the first carries a label.
 */
function GridSkeleton() {
  return (
    <div className={styles.skeleton}>
      <Skeleton
        width="100%"
        height="4.5rem"
        radius="var(--radius-md)"
        ariaLabel="Loading the attendance register…"
      />
      <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
      <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
      <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttendanceGrid
// ---------------------------------------------------------------------------

export default function AttendanceGrid({ groupId }: AttendanceGridProps) {
  const { group, weeks, members, records, loading, error, reload, mark } =
    useAttendance(groupId);
  const { toast, run: runAction, dismiss } = useActionToast();

  const [saveState, setSaveState] = useState<SaveState>("idle");
  /**
   * The route's OWN sentence for a refused single tap. `SavedFlash`'s error
   * copy is deliberately generic ("your last change isn't stored"), which is
   * right for an autosave and wrong here: this register refuses in specifics —
   * "Ada hadn't joined the group in week 3", "Forbidden" — and those sentences
   * are the whole reason the facilitator can fix it. Cleared by the next tap.
   */
  const [cellError, setCellError] = useState<string | null>(null);

  const [popped, setPopped] = useState<ReadonlySet<string>>(NO_POPS);
  /**
   * Every scheduled beat is registered so unmount cancels the lot. NOT effect
   * cleanup: two marks in quick succession would have the second run's cleanup
   * cancel the FIRST cell's timer (the `ReviewQueue` note, same fix).
   */
  const timersRef = useRef<Set<number>>(new Set());
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current.clear();
    },
    [],
  );

  const pop = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setPopped((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setPopped((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next.size === prev.size ? prev : next;
      });
    }, POP_MS);
    timersRef.current.add(timer);
  }, []);

  const statusOf = useCallback(
    (weekNumber: number, uid: string): AttendanceStatus | null =>
      records[String(weekNumber)]?.[uid] ?? null,
    [records],
  );

  // ---- One tap -------------------------------------------------------------

  const onCycle = useCallback(
    async (week: AttendanceWeek, member: AttendanceMember) => {
      const next = nextStatus(statusOf(week.weekNumber, member.uid));
      setCellError(null);
      setSaveState("saving");
      pop([cellKey(week.weekNumber, member.uid)]);
      try {
        await mark(week.weekNumber, [{ uid: member.uid, status: next }]);
        setSaveState("saved");
      } catch (e) {
        // The hook has already put the cell back; this is the sentence.
        setSaveState("idle");
        setCellError(e instanceof Error ? e.message : "That didn't go through.");
      }
    },
    [mark, pop, statusOf],
  );

  // ---- A whole column ------------------------------------------------------

  /**
   * "Mark the rest present" — the bulk gesture a facilitator actually wants
   * after a session: everyone who has not been given a status yet was there.
   *
   * It never overwrites an EXISTING mark. A recorded absence is a considered
   * statement about a person, and a bulk button that could erase one would
   * make the register untrustworthy for exactly the cases it matters in.
   */
  const remainingFor = useCallback(
    (week: AttendanceWeek): AttendanceMark[] =>
      members
        .filter(
          (m) =>
            week.weekNumber >= m.joinedWeekNumber &&
            statusOf(week.weekNumber, m.uid) === null,
        )
        .map((m) => ({ uid: m.uid, status: "present" as const })),
    [members, statusOf],
  );

  const onBulk = useCallback(
    (week: AttendanceWeek) => {
      const targets = remainingFor(week);
      if (targets.length === 0) return;
      setCellError(null);
      pop(targets.map((t) => cellKey(week.weekNumber, t.uid)));
      void runAction(
        async () => {
          await mark(week.weekNumber, targets);
        },
        {
          savingMessage: `Marking ${targets.length} present…`,
          successMessage: `Week ${week.weekNumber}: ${targets.length} marked present.`,
        },
      );
    },
    [mark, pop, remainingFor, runAction],
  );

  // ---- Per-column tallies --------------------------------------------------

  /**
   * `marked / eligible` per week, where eligible excludes anyone who had not
   * joined yet — the same scoping the cells use, so the fraction can always
   * reach its denominator.
   */
  const tallies = useMemo(() => {
    const map = new Map<number, { marked: number; eligible: number }>();
    for (const week of weeks) {
      let marked = 0;
      let eligible = 0;
      for (const member of members) {
        if (week.weekNumber < member.joinedWeekNumber) continue;
        eligible += 1;
        if (statusOf(week.weekNumber, member.uid) !== null) marked += 1;
      }
      map.set(week.weekNumber, { marked, eligible });
    }
    return map;
  }, [weeks, members, statusOf]);

  // ---- States --------------------------------------------------------------

  const hasGrid = members.length > 0 || weeks.length > 0;

  if (loading && !hasGrid) return <GridSkeleton />;

  if (error && !hasGrid) {
    return (
      <div className={styles.root}>
        <p className={styles.error}>{error.message}</p>
        <div>
          <Button variant="secondary" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (members.length === 0) {
    return (
      <EmptyState
        title="Nobody is in this group yet."
        body="Once allocation places members here, the register fills in a column per week."
      />
    );
  }

  if (weeks.length === 0) {
    return (
      <EmptyState
        title="This run has no taught weeks yet."
        body="Add weeks to the run's plan and the register will follow the cohort."
      />
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <ul className={styles.legend}>
          {CYCLE.filter((s): s is AttendanceStatus => s !== null).map((status) => (
            <li key={status} className={styles.legendItem}>
              <span
                className={`${styles.legendGlyph} ${STATUS_CLASS[status]}`}
                aria-hidden="true"
              >
                {GLYPH[status]}
              </span>
              {ATTENDANCE_STATUS_LABEL[status]}
            </li>
          ))}
          <li className={styles.legendItem}>
            <span className={styles.legendGlyph} aria-hidden="true">
              {UNMARKED_GLYPH}
            </span>
            Not marked
          </li>
        </ul>

        <div className={styles.toolbarEnd}>
          <SavedFlash state={saveState} />
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* One line for both kinds of trouble: a refused mark (the route's own
          sentence) and a refresh that failed on top of a grid that already
          loaded. The refusal wins — it is the newer thing, and it is the one
          the facilitator caused. */}
      {(cellError || error) && (
        <p className={styles.error} role="status">
          {cellError ?? error?.message}
        </p>
      )}

      {/* The register's OWN scroller. Never `.mainWide` (CLAUDE.md,
          "Main-area width"): a wide data view handles its own overflow, and the
          `min-width: 0` chain below is what keeps this table scrolling inside
          itself instead of widening the shell and orphaning the sidebar. The
          height bound is what gives the sticky header something to stick to —
          a container that cannot scroll vertically has no sticky to offer. */}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.caption}>
            Attendance for {group?.name || "this group"} — {members.length}{" "}
            {members.length === 1 ? "member" : "members"}, {weeks.length}{" "}
            {weeks.length === 1 ? "week" : "weeks"} so far. Each cell cycles
            through present, absent, excused, late and back to not marked.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${styles.head} ${styles.corner}`}>
                Member
              </th>
              {weeks.map((week) => {
                const tally = tallies.get(week.weekNumber) ?? {
                  marked: 0,
                  eligible: 0,
                };
                const remaining = tally.eligible - tally.marked;
                // Three states, because "nothing to do" has two very different
                // reasons: everyone is marked, or nobody had joined the group
                // that week. A column of joiners-to-be must not read as done.
                const bulkLabel =
                  tally.eligible === 0
                    ? "Nobody yet"
                    : remaining === 0
                      ? "All marked"
                      : `Rest present (${remaining})`;
                return (
                  <th
                    key={week.weekNumber}
                    scope="col"
                    className={`${styles.head} ${styles.weekHead}`}
                  >
                    <span className={styles.weekLabel}>Week {week.weekNumber}</span>
                    {week.title && (
                      <span className={styles.weekTitle}>{week.title}</span>
                    )}
                    <span className={styles.tally}>
                      {tally.marked}/{tally.eligible}
                    </span>
                    <button
                      type="button"
                      className={styles.bulk}
                      onClick={() => onBulk(week)}
                      disabled={remaining === 0}
                      aria-label={
                        remaining === 0
                          ? `Week ${week.weekNumber}: ${bulkLabel}`
                          : `Mark the remaining ${remaining} present in week ${week.weekNumber}`
                      }
                    >
                      {bulkLabel}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.uid}>
                <th scope="row" className={styles.nameCell}>
                  <MemberName name={member.displayName} />
                </th>
                {weeks.map((week) => {
                  const notYet = week.weekNumber < member.joinedWeekNumber;
                  const status = statusOf(week.weekNumber, member.uid);
                  const key = cellKey(week.weekNumber, member.uid);

                  // INERT, not unmarked — see the mid-run joiner note above.
                  // A stored status here can only come from a
                  // `joinedWeekNumber` edited after the fact; it is shown
                  // rather than hidden, and stays uneditable.
                  if (notYet) {
                    return (
                      <td key={key} className={styles.cell}>
                        <span
                          className={styles.notYet}
                          role="img"
                          aria-label={`Not in the group yet — joined in week ${member.joinedWeekNumber}${
                            status ? `, recorded ${ATTENDANCE_STATUS_LABEL[status]}` : ""
                          }`}
                        >
                          {status ? GLYPH[status] : "—"}
                        </span>
                      </td>
                    );
                  }

                  const next = nextStatus(status);
                  return (
                    <td key={key} className={styles.cell}>
                      <button
                        type="button"
                        className={`${styles.cellButton} ${
                          status ? STATUS_CLASS[status] : styles.isUnmarked
                        }`}
                        aria-pressed={status !== null}
                        aria-label={`${member.displayName}, week ${week.weekNumber}: ${
                          status ? ATTENDANCE_STATUS_LABEL[status] : "not marked"
                        }. Sets ${next ? ATTENDANCE_STATUS_LABEL[next] : "not marked"}.`}
                        onClick={() => void onCycle(week, member)}
                      >
                        {/* Keyed by status so a change REMOUNTS the glyph: the
                            pop animation then runs exactly once per change, and
                            only when this cell is in `popped` (i.e. the
                            facilitator did it — never on load). */}
                        <span
                          key={status ?? "none"}
                          className={`${styles.glyph} ${
                            popped.has(key) ? styles.glyphPop : ""
                          }`}
                          aria-hidden="true"
                        >
                          {status ? GLYPH[status] : UNMARKED_GLYPH}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

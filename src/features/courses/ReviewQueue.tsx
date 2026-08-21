"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Chip, { type ChipTone } from "@/components/ui/Chip";
import CountedTextarea from "@/components/ui/CountedTextarea";
import EmptyState from "@/components/ui/EmptyState";
import MemberName from "@/components/ui/MemberName";
import MemberText from "@/components/ui/MemberText";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import SegmentedControl, {
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import Skeleton from "@/components/ui/Skeleton";
import {
  EXERCISE_LIMITS,
  REVIEW_STATUS_LABEL,
  type ExerciseReviewStatus,
} from "@/lib/firestore/courseExercises";
import { validateSubmissionUrl } from "@/lib/firestore/courses";
import {
  useReviewQueue,
  type ExerciseResponseWire,
  type ReviewExercise,
  type ReviewRow,
} from "./useReviewQueue";
import styles from "./ReviewQueue.module.css";

/**
 * The facilitator review queue for one group, one week at a time.
 *
 * Two panes, deliberately: the LEFT list is the queue — who is waiting, at a
 * glance, in one column you can drive from the keyboard — and the RIGHT pane is
 * one member's work, in the same place every time. That "same place" is the
 * whole layout argument, and it is why the detail pane CROSSFADES rather than
 * slides: a slide says "you navigated somewhere", and nobody navigated. Plan
 * section: "Placement map — Review queue".
 *
 * ── NAMES ONLY ──────────────────────────────────────────────────────────────
 * Exercise answers are member-authored content on a surface a peer facilitator
 * is reading. The payload carries display names and nothing else identifying;
 * this component adds no lookup of its own, and every name renders through
 * `MemberName` (whose fallback chain ends at "NAISI member", never an email).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── XSS ─────────────────────────────────────────────────────────────────────
 * Member text goes through `MemberText` and nothing else. Member LINKS are
 * re-validated with `validateSubmissionUrl` AT RENDER TIME, not merely trusted
 * because the submit route checked them: a stored `javascript:` URL from a
 * bug, a migration, or a hand-edited document must not become an anchor here.
 * A link that fails renders as inert text with a warning, never as an <a>.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Toast, not inline: sending a verdict emails nothing but it is a
 * must-not-continue action a member will read, so it takes `ActionToast` (the
 * plan's toast-vs-inline rule).
 */

type Props = {
  /** For the "open the week" escape hatch when a week has no exercises. */
  runId: string;
  groupId: string;
  /** The run's authored week numbers, in plan order (breaks excluded). */
  weeks: number[];
  /** The cohort's current (or anchor) week, already narrowed to `weeks`. */
  initialWeek: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The detail pane's out-beat. A literal, not a token: the plan specifies
 * 200ms-in / 60ms-out, and 60ms is deliberately below the smallest duration
 * token — it is a "get out of the way" beat, not an animation anyone reads.
 * The 200ms in-beat IS a token (`--dur-fade`), applied in the CSS.
 */
const DETAIL_OUT_MS = 60;

/** Matches `--dur-panel` (280ms) plus a frame of slack. */
const LEAVE_MS = 320;

/**
 * The same beat under `prefers-reduced-motion`, where the belt in tokens.css
 * collapses `--dur-panel` to 1ms but keeps `--dur-fade` at 120ms (opacity is
 * not a vestibular trigger). The row is therefore gone in ~120ms, and holding
 * it mounted for the full 320 leaves an invisible, `aria-hidden` husk in the
 * list for twice as long as it takes to disappear.
 */
const REDUCED_LEAVE_MS = 160;

/** How long a departing row stays mounted, per the viewer's motion setting. */
function leaveMs(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return LEAVE_MS;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? REDUCED_LEAVE_MS
    : LEAVE_MS;
}

/** Identity-stable empty set: assigning it is a no-op re-render for React. */
const NO_LEAVERS: ReadonlySet<string> = new Set();

const STATUS_TONE: Record<ExerciseReviewStatus, ChipTone> = {
  unreviewed: "accent",
  seen: "neutral",
  "needs-work": "warning",
  approved: "success",
};

/**
 * The three verdicts on the button row. Every one of them LOCKS the member out
 * — the submit route 409s on any status but `unreviewed` — so `unreviewed` is
 * not a fourth verdict, it is the undo: "Reopen for edits", rendered apart from
 * these (see `ReopenAction`) because it hands the work back rather than ruling
 * on it. Without it, "Needs work" would be a dead end and the only way to let
 * someone revise would be the Firestore console.
 */
const VERDICTS: ExerciseReviewStatus[] = ["seen", "needs-work", "approved"];

/** The one status that is a hand-back rather than a ruling. */
const REOPEN: ExerciseReviewStatus = "unreviewed";

type Filter = "all" | "needs-review" | "needs-work" | "approved";

/**
 * A member's standing for the selected week, collapsed to one word.
 *
 * Order matters and encodes the queue's priority: anything unreviewed outranks
 * anything else, because that is the work. `not-started` is its own state
 * rather than an empty "needs review" — a member who has submitted nothing is
 * not waiting on the facilitator, and putting them in the review queue would
 * make the count lie.
 */
type RowState = "not-started" | "needs-review" | "needs-work" | "seen" | "approved";

function rowStateOf(row: ReviewRow): RowState {
  const submitted = row.responses.filter((r) => r.submittedAt !== null);
  if (submitted.length === 0) return "not-started";
  if (submitted.some((r) => r.reviewStatus === "unreviewed")) return "needs-review";
  if (submitted.some((r) => r.reviewStatus === "needs-work")) return "needs-work";
  if (submitted.every((r) => r.reviewStatus === "approved")) return "approved";
  return "seen";
}

function matchesFilter(state: RowState, filter: Filter): boolean {
  if (filter === "all") return true;
  return state === filter;
}

/** Client-only render (data arrives from a fetch), so no SSR/CSR skew. */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(n, 0), max);
}

/**
 * A filter pill's label with its tally. The count is its own element so it can
 * be dimmed and tabular-aligned — a bare "Needs review 3" reads as prose and
 * makes the numbers hard to compare down the row.
 */
function withCount(label: string, count: number) {
  return (
    <>
      {label} <span className={styles.count}>{count}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

/**
 * Layout-matched to the real two-pane grid so arrival costs no reflow — the
 * shift a skeleton exists to prevent. One announcement, not one per bar:
 * `Skeleton`'s wrapper is its own live region, so only the first carries a
 * label and the rest pass an empty one.
 */
function QueueSkeleton() {
  return (
    <div className={styles.panes}>
      <div className={styles.listPane}>
        <Skeleton
          width="100%"
          height="3.5rem"
          radius="var(--radius-md)"
          ariaLabel="Loading this week's exercises…"
        />
        <Skeleton width="100%" height="3.5rem" radius="var(--radius-md)" ariaLabel="" />
        <Skeleton width="100%" height="3.5rem" radius="var(--radius-md)" ariaLabel="" />
      </div>
      <div className={styles.detailPane}>
        <Skeleton width="100%" height="12rem" radius="var(--radius-md)" ariaLabel="" />
        <Skeleton width="100%" height="12rem" radius="var(--radius-md)" ariaLabel="" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReviewQueue
// ---------------------------------------------------------------------------

export default function ReviewQueue({ runId, groupId, weeks, initialWeek }: Props) {
  const [weekNumber, setWeekNumber] = useState(initialWeek);
  // Opens on the work, not on the archive: "Needs review" IS the queue. When
  // it is empty the empty state says so and offers the other filters.
  const [filter, setFilter] = useState<Filter>("needs-review");

  const { week, rows, loading, error, reload, review } = useReviewQueue(
    groupId,
    weekNumber,
  );
  const { toast, run: runAction, dismiss } = useActionToast();
  const [busyResponseId, setBusyResponseId] = useState<string | null>(null);

  const domId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const optionDomId = useCallback((uid: string) => `${domId}-opt-${uid}`, [domId]);
  const feedbackDomId = useCallback(
    (responseId: string) => `${domId}-fb-${responseId}`,
    [domId],
  );

  // ---- Filtering + the leave animation ------------------------------------

  const matching = useMemo(
    () => rows.filter((row) => matchesFilter(rowStateOf(row), filter)),
    [rows, filter],
  );
  const matchingIds = useMemo(() => new Set(matching.map((r) => r.uid)), [matching]);

  /**
   * Rows that have just stopped matching the filter and are collapsing out.
   * They stay MOUNTED for `LEAVE_MS` so the `grid-rows 1fr→0fr` track can run
   * and the list closes over the gap (plan: "reviewed row leaves via
   * grid-rows"). Unmounting them immediately would make the rest of the list
   * jump, which is the thing the animation exists to prevent.
   */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NO_LEAVERS);
  const visible = useMemo(
    () =>
      leaving.size === 0
        ? matching
        : rows.filter((r) => matchingIds.has(r.uid) || leaving.has(r.uid)),
    [rows, matching, matchingIds, leaving],
  );

  /**
   * Every scheduled beat is registered so unmount cancels the lot. NOT effect
   * cleanup: two verdicts in quick succession would have the second run's
   * cleanup cancel the FIRST row's removal timer, stranding it collapsed
   * forever. One shared registry, cleared once, is the fix.
   */
  const timersRef = useRef<Set<number>>(new Set());
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current.clear();
    },
    [],
  );

  /**
   * Diff the matching set across renders to spot a row that has just left it.
   *
   * The `key` guard is what keeps this honest: a row disappearing because the
   * FILTER or the WEEK changed is not a departure, it is a different question
   * being asked, and animating twenty rows shut at once would read as the page
   * breaking. Only a change WITHIN a stable question — i.e. a verdict landing —
   * animates.
   */
  const seenRef = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  useEffect(() => {
    const key = `${groupId} ${weekNumber} ${filter}`;
    const ids = matching.map((r) => r.uid);
    const prev = seenRef.current;
    seenRef.current = { key, ids };

    if (prev.key !== key) {
      // Identity-stable constant, so this is a no-op unless something really
      // was mid-collapse when the question changed.
      setLeaving(NO_LEAVERS);
      return;
    }

    const present = new Set(ids);
    const gone = prev.ids.filter((uid) => !present.has(uid));
    if (gone.length === 0) return;

    setLeaving((s) => {
      const next = new Set(s);
      for (const uid of gone) next.add(uid);
      return next;
    });
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setLeaving((s) => {
        const next = new Set(s);
        for (const uid of gone) next.delete(uid);
        return next.size === s.size ? s : next;
      });
    }, leaveMs());
    timersRef.current.add(timer);
  }, [matching, groupId, weekNumber, filter]);

  // ---- Selection -----------------------------------------------------------

  /**
   * Selection is an INDEX into `matching`, not a uid, and that is load-bearing.
   * When the row you just reviewed drops out of the filter, the same index now
   * points at the NEXT person — the selection advances for free, in the same
   * render, with no "jump to the top of the list" frame in between. A uid-based
   * selection cannot do that without a second state update chasing the first.
   */
  const [selIndex, setSelIndex] = useState(0);
  const index = matching.length === 0 ? -1 : clamp(selIndex, matching.length - 1);
  const selectedRow = index >= 0 ? matching[index] : null;
  const selectedUid = selectedRow?.uid ?? null;

  const selectAt = useCallback(
    (next: number) => {
      if (matching.length === 0) return;
      const target = clamp(next, matching.length - 1);
      setSelIndex(target);
      const uid = matching[target]?.uid;
      if (uid) {
        document
          .getElementById(optionDomId(uid))
          ?.scrollIntoView({ block: "nearest" });
      }
    },
    [matching, optionDomId],
  );

  const focusFeedback = useCallback(() => {
    const first = selectedRow?.responses.find((r) => r.submittedAt !== null);
    if (!first) return;
    document.getElementById(feedbackDomId(first.id))?.focus();
  }, [selectedRow, feedbackDomId]);

  /**
   * j/k (and the arrows, Home/End) drive the list; Enter drops into the
   * feedback box. Scoped to the listbox rather than the document on purpose —
   * a global handler would eat the "j" someone is typing into their feedback.
   * Escape inside a feedback box returns focus here, which closes the loop.
   */
  function onListKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        selectAt(index + 1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        selectAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        selectAt(0);
        break;
      case "End":
        e.preventDefault();
        selectAt(matching.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        focusFeedback();
        break;
      default:
        break;
    }
  }

  // ---- The detail crossfade ------------------------------------------------

  /**
   * 200ms in / 60ms out, in the SAME element — a swap, not a navigation.
   *
   * One DOM node, never keyed, so the opacity transition actually fires: a
   * `key`ed remount would start each pane at its final opacity with nothing to
   * transition from. The content swaps at the bottom of the fade, while nothing
   * is visible.
   */
  const [shown, setShown] = useState<{ uid: string | null; fading: boolean }>({
    uid: null,
    fading: false,
  });

  /**
   * While the last matching row is collapsing out there IS no selection —
   * `matching` is empty and `selectedRow` is null. Blanking the pane in that
   * beat reads as the page losing its place a fraction after you acted, so the
   * person just reviewed is held until their row has actually gone.
   */
  const detailUid = selectedUid ?? (leaving.size > 0 ? shown.uid : null);

  /**
   * Starting the swap is a RENDER-PHASE adjustment (React's documented
   * adjust-state-on-change pattern), not an effect: an effect would paint one
   * frame of the new selection at full opacity before the fade began, which is
   * the flash the crossfade exists to avoid. First arrival and the list
   * emptying have nothing to fade from or to, so they swap outright.
   */
  if (!shown.fading && shown.uid !== detailUid) {
    setShown(
      shown.uid === null || detailUid === null
        ? { uid: detailUid, fading: false }
        : { uid: shown.uid, fading: true },
    );
  }

  // Finishing it is the one thing that genuinely needs a timer. Selection
  // moving again mid-fade re-runs this, cancelling the old beat and landing on
  // the newest person — so a fast j-j-j never strands the pane on a stale row.
  useEffect(() => {
    if (!shown.fading) return;
    const timer = window.setTimeout(() => {
      setShown({ uid: detailUid, fading: false });
    }, DETAIL_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [shown.fading, detailUid]);

  const shownUid = shown.uid;
  const fading = shown.fading;

  // The pane reads from `rows`, not `matching`: a member who has just dropped
  // out of the filter should stay legible for the beat their row spends
  // collapsing, rather than blanking the moment the verdict lands.
  const shownRow = shownUid ? (rows.find((r) => r.uid === shownUid) ?? null) : null;

  // ---- Actions -------------------------------------------------------------

  const submitReview = useCallback(
    (responseId: string, status: ExerciseReviewStatus, comment: string) => {
      setBusyResponseId(responseId);
      // Reopening is not a verdict and must not be narrated as one — "Marked
      // unreviewed" describes the field being written, not the thing that just
      // happened to the member's answer.
      const reopening = status === REOPEN;
      void runAction(
        async () => {
          // The comment travels with it deliberately: the route only leaves
          // existing feedback alone when the field is ABSENT, and sending the
          // box's current contents keeps what the member is revising against.
          await review(responseId, status, comment);
        },
        {
          savingMessage: reopening ? "Reopening…" : "Sending feedback…",
          successMessage: reopening
            ? "Reopened for edits"
            : `Marked ${REVIEW_STATUS_LABEL[status].toLowerCase()}`,
        },
      ).finally(() => setBusyResponseId(null));
    },
    [runAction, review],
  );

  // ---- Counts for the filter labels ---------------------------------------

  const counts = useMemo(() => {
    const tally = { all: rows.length, "needs-review": 0, "needs-work": 0, approved: 0 };
    for (const row of rows) {
      const state = rowStateOf(row);
      if (state === "needs-review") tally["needs-review"] += 1;
      else if (state === "needs-work") tally["needs-work"] += 1;
      else if (state === "approved") tally.approved += 1;
    }
    return tally;
  }, [rows]);

  const filterOptions: readonly SegmentedOption<Filter>[] = [
    { value: "needs-review", label: withCount("Needs review", counts["needs-review"]) },
    { value: "needs-work", label: withCount("Needs work", counts["needs-work"]) },
    { value: "approved", label: withCount("Approved", counts.approved) },
    { value: "all", label: withCount("All", counts.all) },
  ];

  const weekOptions: ResponsiveSelectOption[] = weeks.map((n) => ({
    value: String(n),
    label: `Week ${n}`,
  }));

  // -------------------------------------------------------------------------

  if (weeks.length === 0) {
    return (
      <EmptyState
        title="This run has no weeks yet"
        body="Exercises are authored per week. Once the run's week plan exists, the responses show up here."
        action={
          <Link className={styles.emptyLink} href={`/learn/${encodeURIComponent(runId)}`}>
            Back to the course
          </Link>
        }
      />
    );
  }

  const exercises = week?.exercises ?? [];

  return (
    <>
      <div className={styles.queue}>
        <div className={styles.controls}>
          <div className={styles.control}>
            <span className={styles.controlLabel}>Week</span>
            <div className={styles.weekSelect}>
              <ResponsiveSelect
                value={String(weekNumber)}
                onChange={(next) => {
                  setWeekNumber(Number(next));
                  setSelIndex(0);
                }}
                options={weekOptions}
                ariaLabel="Which week to review"
              />
            </div>
          </div>

          <div className={styles.control}>
            <span className={styles.controlLabel}>Show</span>
            <SegmentedControl
              value={filter}
              onChange={(next) => {
                setFilter(next);
                setSelIndex(0);
              }}
              options={filterOptions}
              ariaLabel="Filter the queue"
              size="md"
            />
          </div>

          {/* No label of its own — it aligns to the baseline of the two
              labelled controls beside it rather than inventing a heading for a
              button that says what it does. */}
          <div className={styles.controlAction}>
            <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        {week?.title ? (
          <p className={styles.weekTitle}>
            Week {week.weekNumber} — {week.title}
          </p>
        ) : null}

        {error && rows.length > 0 && (
          <p className={styles.error} role="status">
            Couldn&apos;t refresh: {error.message} — showing the last version that
            loaded.
          </p>
        )}

        {/* Three states, in the house order: layout-matched Skeleton →
            EmptyState → content. */}
        {!week && loading ? (
          <QueueSkeleton />
        ) : !week ? (
          <EmptyState
            title="Couldn't load this week"
            body={error?.message ?? "The week's exercises didn't come back."}
            action={<Button onClick={reload}>Try again</Button>}
          />
        ) : exercises.length === 0 ? (
          <EmptyState
            title={`Week ${week.weekNumber} has no exercises`}
            body="Nothing to review here. Pick another week, or open the week to see what it does have."
            action={
              <Link
                className={styles.emptyLink}
                href={`/learn/${encodeURIComponent(runId)}/weeks/${week.weekNumber}`}
              >
                Open week {week.weekNumber}
              </Link>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No one is in this group yet"
            body="Once places are allocated, everyone in the group appears here with their week's work."
          />
        ) : (
          <div className={styles.panes}>
            <div className={styles.listPane}>
              {visible.length === 0 ? (
                <div className={styles.listEmpty}>
                  <EmptyState
                    title="Nothing here"
                    body={
                      filter === "needs-review"
                        ? "Everything submitted this week has been looked at."
                        : "No one in this group is in that state this week."
                    }
                    action={
                      filter === "all" ? undefined : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setFilter("all");
                            setSelIndex(0);
                          }}
                        >
                          Show everyone
                        </Button>
                      )
                    }
                  />
                </div>
              ) : (
                <ul
                  ref={listRef}
                  className={styles.list}
                  role="listbox"
                  aria-label="Members in this group"
                  aria-activedescendant={
                    selectedUid ? optionDomId(selectedUid) : undefined
                  }
                  tabIndex={0}
                  onKeyDown={onListKeyDown}
                >
                  {visible.map((row) => {
                    const isLeaving = leaving.has(row.uid) && !matchingIds.has(row.uid);
                    const selected = row.uid === selectedUid;
                    return (
                      <li
                        key={row.uid}
                        id={optionDomId(row.uid)}
                        role="option"
                        aria-selected={selected}
                        // A collapsing row is at opacity 0 with pointer events
                        // off — visually gone, but still an `option` a screen
                        // reader would count and read out for the rest of the
                        // beat. Hiding it keeps the listbox's contents equal to
                        // what is on screen for sighted and non-sighted readers
                        // alike. It is never the active descendant while
                        // leaving (it has dropped out of `matching`), so this
                        // hides nothing focus is pointing at.
                        aria-hidden={isLeaving || undefined}
                        className={`${styles.row} ${isLeaving ? styles.rowLeaving : ""}`}
                        onClick={() => {
                          const i = matching.findIndex((r) => r.uid === row.uid);
                          if (i < 0) return;
                          setSelIndex(i);
                          // Clicking hands the keyboard the list too, so j/k
                          // work straight after a mouse pick.
                          listRef.current?.focus();
                        }}
                      >
                        <div className={styles.rowInner}>
                          <div
                            className={`${styles.rowBody} ${selected ? styles.rowSelected : ""}`}
                          >
                            <span className={styles.rowName}>
                              <MemberName name={row.displayName} />
                            </span>
                            <RowStatus row={row} exercises={exercises} />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <section
              className={`${styles.detailPane} ${fading ? styles.detailFading : ""}`}
              aria-label="Selected member's work"
            >
              {shownRow ? (
                <>
                  <h2 className={styles.detailName}>
                    <MemberName name={shownRow.displayName} />
                  </h2>
                  {exercises.map((exercise, i) => (
                    <ExerciseCard
                      key={exercise.id}
                      exercise={exercise}
                      ordinal={i + 1}
                      response={shownRow.responses.find(
                        (r) => r.exerciseId === exercise.id,
                      )}
                      memberName={shownRow.displayName}
                      feedbackId={feedbackDomId}
                      busyResponseId={busyResponseId}
                      onReview={submitReview}
                      onEscape={() => listRef.current?.focus()}
                    />
                  ))}
                </>
              ) : (
                <p className={styles.muted}>Pick someone on the left to read their work.</p>
              )}
            </section>
          </div>
        )}

        {visible.length > 0 && (
          <p className={styles.keys}>
            <kbd className={styles.kbd}>j</kbd> / <kbd className={styles.kbd}>k</kbd>{" "}
            move through the list, <kbd className={styles.kbd}>Enter</kbd> jumps to the
            feedback box, <kbd className={styles.kbd}>Esc</kbd> comes back.
          </p>
        )}
      </div>
      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The list row's status strip
// ---------------------------------------------------------------------------

/**
 * One chip per exercise, in the week's order, so a glance down the column
 * reads as a grid of standings. The chip's LABEL is the exercise number and
 * its colour is the verdict — colour is never the only channel, so each chip
 * carries an `aria-label`/`title` spelling both out.
 */
function RowStatus({
  row,
  exercises,
}: {
  row: ReviewRow;
  exercises: readonly ReviewExercise[];
}) {
  const state = rowStateOf(row);
  if (state === "not-started") {
    return <span className={styles.notStarted}>Not started</span>;
  }
  return (
    <span className={styles.rowChips}>
      {exercises.map((exercise, i) => {
        const response = row.responses.find((r) => r.exerciseId === exercise.id);
        const submitted = response && response.submittedAt !== null;
        const label = submitted
          ? REVIEW_STATUS_LABEL[response.reviewStatus]
          : "Not submitted";
        return (
          <Chip
            key={exercise.id}
            size="sm"
            tone={submitted ? STATUS_TONE[response.reviewStatus] : "neutral"}
            title={`Exercise ${i + 1}: ${label}`}
            aria-label={`Exercise ${i + 1}: ${label}`}
            className={submitted ? undefined : styles.chipEmpty}
          >
            {i + 1}
          </Chip>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One exercise in the detail pane
// ---------------------------------------------------------------------------

function ExerciseCard({
  exercise,
  ordinal,
  response,
  memberName,
  feedbackId,
  busyResponseId,
  onReview,
  onEscape,
}: {
  exercise: ReviewExercise;
  ordinal: number;
  response: ExerciseResponseWire | undefined;
  /** For the feedback label only — the name the payload gave, nothing derived. */
  memberName: string;
  feedbackId: (responseId: string) => string;
  busyResponseId: string | null;
  onReview: (
    responseId: string,
    status: ExerciseReviewStatus,
    comment: string,
  ) => void;
  onEscape: () => void;
}) {
  const [comment, setComment] = useState(response?.reviewerComment ?? "");

  /**
   * Adjust-state-on-prop-change (React's documented pattern — no effect, no
   * flash). The signature includes the response ID, so moving to another member
   * reseeds the box rather than carrying one person's draft onto another's
   * work — which is the failure this component would otherwise have, because
   * the pane is NOT keyed by member (the crossfade needs one stable node).
   */
  const signature = [
    response?.id ?? "",
    response?.reviewerComment ?? "",
    response?.reviewedAt ?? "",
  ].join("\n⁣\n");
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    setComment(response?.reviewerComment ?? "");
  }

  const submitted = response && response.submittedAt !== null;
  const busy = response ? busyResponseId === response.id : false;

  /**
   * RE-VALIDATED AT RENDER TIME, every time. The submit route is the security
   * boundary, but this is the last gate before a member-authored string becomes
   * an href — a stored `javascript:` URL (a bug, a migration, a hand edit) must
   * render as text, not as a link. `null` means valid.
   */
  const linkError =
    response?.responseType === "link" && response.linkUrl
      ? validateSubmissionUrl(response.linkUrl, EXERCISE_LIMITS.linkUrl)
      : null;

  return (
    <article className={styles.exercise}>
      <header className={styles.exerciseHead}>
        <span className={styles.exerciseNumber} aria-hidden="true">
          {ordinal}
        </span>
        <div className={styles.exerciseMeta}>
          {/* Facilitator-authored, but still a text node — this file renders no
              markup from any source. */}
          <p className={styles.prompt}>{exercise.prompt}</p>
          {exercise.helpText && <p className={styles.help}>{exercise.helpText}</p>}
        </div>
        <span className={styles.exerciseTags}>
          {exercise.required && (
            <Chip size="sm" tone="neutral">
              Required
            </Chip>
          )}
          {submitted && (
            <Chip size="sm" tone={STATUS_TONE[response.reviewStatus]}>
              {REVIEW_STATUS_LABEL[response.reviewStatus]}
            </Chip>
          )}
        </span>
      </header>

      {!submitted ? (
        <>
          <p className={styles.muted}>
            {response
              ? "Started but not submitted yet — there is nothing to review until they send it."
              : "Nothing submitted yet."}
          </p>
          {/* A draft carrying a verdict can't be produced from this screen (the
              buttons below only exist for submitted work), but the route's lock
              keys off the status alone, so if one ever exists the member is
              frozen out of their own draft. The hand-back has to be reachable
              wherever the lock can be. */}
          {response && response.reviewStatus !== REOPEN && (
            <ReopenAction
              responseId={response.id}
              comment={comment}
              busy={busy}
              onReview={onReview}
            />
          )}
        </>
      ) : (
        <>
          <div className={styles.answer}>
            {response.responseType === "link" ? (
              linkError ? (
                <>
                  <p className={styles.linkWarning}>
                    This link didn&apos;t pass validation, so it isn&apos;t clickable:{" "}
                    {linkError}
                  </p>
                  {/* Inert text, deliberately: a refused URL is still evidence
                      of what they sent. */}
                  <MemberText text={response.linkUrl ?? ""} />
                </>
              ) : (
                <a
                  className={styles.answerLink}
                  href={response.linkUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {response.linkUrl}
                </a>
              )
            ) : response.text ? (
              <MemberText text={response.text} />
            ) : (
              <p className={styles.muted}>They submitted an empty answer.</p>
            )}
          </div>

          <p className={styles.submittedAt}>
            Submitted {formatWhen(response.submittedAt)}
            {response.reviewedAt && (
              <>
                {` · reviewed ${formatWhen(response.reviewedAt)}`}
                {/* Through MemberName like every other name on this surface —
                    interpolated raw, a whitespace-only display name leaves a
                    dangling "by " instead of the fallback. */}
                {response.reviewerName && (
                  <>
                    {" by "}
                    <MemberName name={response.reviewerName} />
                  </>
                )}
              </>
            )}
          </p>

          <div className={styles.feedback}>
            <label className={styles.fieldLabel} htmlFor={feedbackId(response.id)}>
              Feedback for <MemberName name={memberName} />
            </label>
            <p className={styles.help}>
              They see this on their week page. It is sent with whichever verdict you
              pick below.
            </p>
            <CountedTextarea
              id={feedbackId(response.id)}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onEscape();
                }
              }}
              max={EXERCISE_LIMITS.reviewerComment}
              rows={4}
              disabled={busy}
              placeholder="What worked, what to try next. Short and specific beats long."
            />
            <div className={styles.verdicts}>
              {VERDICTS.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant={
                    status === "approved"
                      ? "primary"
                      : status === "needs-work"
                        ? "secondary"
                        : "ghost"
                  }
                  disabled={busy}
                  onClick={() => onReview(response.id, status, comment)}
                >
                  {REVIEW_STATUS_LABEL[status]}
                </Button>
              ))}
            </div>
            {/* Only on a row a verdict has already locked: before that there is
                nothing to undo, and the button would read as a fourth verdict. */}
            {response.reviewStatus !== REOPEN && (
              <ReopenAction
                responseId={response.id}
                comment={comment}
                busy={busy}
                onReview={onReview}
              />
            )}
          </div>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reopen — the undo for a verdict
// ---------------------------------------------------------------------------

/**
 * Sets the status back to `unreviewed`, which is the ONLY thing that hands
 * editing back to the member: the submit route refuses (409) to write any row
 * whose status is anything else, so "Needs work" without this is a dead end and
 * the intended workflow — leave the comment, reopen, they revise — is
 * unreachable outside the Firestore console.
 *
 * The feedback in the box goes with it. That is the point rather than a side
 * effect: what they are revising against has to survive the round trip, and the
 * route only preserves existing feedback when the field is absent OR resent.
 *
 * Set apart from the verdict row (its own line, quiet variant) because it is
 * not a fourth verdict — it is the undo for the other three.
 */
function ReopenAction({
  responseId,
  comment,
  busy,
  onReview,
}: {
  responseId: string;
  comment: string;
  busy: boolean;
  onReview: (
    responseId: string,
    status: ExerciseReviewStatus,
    comment: string,
  ) => void;
}) {
  return (
    <div className={styles.reopen}>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => onReview(responseId, REOPEN, comment)}
      >
        Reopen for edits
      </Button>
      <p className={styles.reopenNote}>
        Unlocks their answer so they can revise it. Your feedback stays with it.
      </p>
    </div>
  );
}

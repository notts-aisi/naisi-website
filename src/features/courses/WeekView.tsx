"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import Accordion from "@/components/ui/Accordion";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import CountedTextarea from "@/components/ui/CountedTextarea";
import EmptyState from "@/components/ui/EmptyState";
import MemberName from "@/components/ui/MemberName";
import MemberText from "@/components/ui/MemberText";
import ProgressBar from "@/components/ui/ProgressBar";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import Skeleton from "@/components/ui/Skeleton";
import StarRating from "@/components/ui/StarRating";
import PageEnter from "@/components/motion/PageEnter";
import { addDaysToKey, isValidDateKey } from "@/lib/courses/weekPlan";
import { weekDocId, type Material } from "@/lib/firestore/courses";
import {
  PROGRESS_LIMITS,
  type CourseProgressDoc,
  type ProgressItemKind,
} from "@/lib/firestore/courseProgress";
import MaterialCheck from "./MaterialCheck";
import PacingBanner from "./PacingBanner";
import SessionCard from "./SessionCard";
import WeekCurriculum from "./WeekCurriculum";
import WeekRail from "./WeekRail";
import { saveProgressReflection, toggleProgressItem } from "./progressMutations";
import { useRunOverview } from "./useRunOverview";
import { useRunProgress } from "./useRunProgress";
import { useWeek } from "./useWeek";
import { useWeekComments, type WeekComments } from "./useWeekComments";
import {
  clearWeekNavDirection,
  peekWeekNavDirection,
  setWeekNavDirection,
} from "./weekNavDirection";
import styles from "./WeekView.module.css";

/**
 * The member week page: header + ProgressBar (the spatial anchor — they NEVER
 * animate position across week↔week navigation), pacing banner, the shared
 * WeekCurriculum spine with check-off buttons hung off every row, the
 * reflection panel and cohort-notes lane under each material, and the footer
 * week nav. Plan sections: "Placement map — Week page", "Check-off
 * choreography", "Toast vs inline rule" — the timings here are theirs.
 *
 * Data: one overview fetch (run + current week + own enrolment + group), one
 * week-doc get, and the live own-progress listener. The listener is what
 * settles the optimistic check-off; the `overrides` map below only bridges
 * the microtask gap before the local write lands in the snapshot — and, on a
 * refused write, holds the flip until the 200ms revert.
 *
 * Toast vs inline: check-off FAILURE is the only toast on this page. Saves of
 * the reflection panel are keep-working feedback → inline SavedFlash; an
 * admin hiding or unhiding a cohort comment is a must-not-continue action and
 * takes the toast.
 */

type ViewerRole = "learner" | "facilitator" | "admin";

type Props = {
  runId: string;
  weekNumber: number;
  uid: string;
  viewerRole: ViewerRole;
};

/** Mirrors weekPlan.ts (not exported there); every slot is 7 civil days. */
const DAYS_PER_WEEK = 7;

/** How long the row-wash / error-flash classes stay applied (animation + slack). */
const WASH_MS = 700;
const ERROR_FLASH_MS = 900;
/** Choreo class outlives the last star pop (460 + 4×45 + 260 ≈ 900ms). */
const CHOREO_MS = 1400;
/** Failure revert: the plan's 200ms beat between refusal and the flip-back. */
const REVERT_MS = 200;

const EMPTY_ROWS: ReadonlyArray<never> = [];

export default function WeekView({ runId, weekNumber, uid, viewerRole }: Props) {
  const overview = useRunOverview(runId);
  const week = useWeek(runId, weekDocId(weekNumber), viewerRole !== "learner");
  const progress = useRunProgress(runId);
  const comments = useWeekComments(runId, weekNumber);
  const { toast, run: runToast, dismiss } = useActionToast();

  // Travel direction for the entrance, handed over by the PREVIOUS page's nav
  // click. Mount-constant, so a lazy initialiser fits: peek is pure
  // (StrictMode's double render reads the same answer twice); the slot is
  // cleared after mount so a back/forward nav minutes later can't replay it.
  const [navDir] = useState<"up" | "left" | "right">(
    () => peekWeekNavDirection() ?? "up",
  );
  useEffect(() => {
    clearWeekNavDirection();
  }, []);

  // ---- Optimistic state + choreography flags -----------------------------
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [flashes, setFlashes] = useState<ReadonlyMap<string, "wash" | "error">>(
    new Map(),
  );
  const [openPanels, setOpenPanels] = useState<ReadonlySet<string>>(new Set());
  const [choreoPanels, setChoreoPanels] = useState<ReadonlySet<string>>(new Set());

  // Every scheduled beat is registered so unmount can cancel the lot — a
  // revert timer firing into an unmounted page is noise at best.
  const timeoutsRef = useRef<Set<number>>(new Set());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timeoutsRef.current.delete(id);
      fn();
    }, ms);
    timeoutsRef.current.add(id);
  }, []);
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const id of timeouts) window.clearTimeout(id);
    };
  }, []);

  const setOverride = useCallback((id: string, value: boolean | null) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);

  const setInSet = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
      id: string,
      present: boolean,
    ) => {
      setter((prev) => {
        if (prev.has(id) === present) return prev;
        const next = new Set(prev);
        if (present) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );

  const flash = useCallback(
    (id: string, kind: "wash" | "error") => {
      setFlashes((prev) => new Map(prev).set(id, kind));
      later(
        () =>
          setFlashes((prev) => {
            if (prev.get(id) !== kind) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          }),
        kind === "wash" ? WASH_MS : ERROR_FLASH_MS,
      );
    },
    [later],
  );

  const isDone = useCallback(
    (id: string) => overrides.get(id) ?? progress.byItemId.get(id)?.completed ?? false,
    [overrides, progress.byItemId],
  );

  const canWrite = overview.data?.enrolment?.status === "active";

  const handleToggle = useCallback(
    (itemKind: ProgressItemKind, itemId: string, next: boolean) => {
      if (!canWrite) return;
      const current = progress.byItemId.get(itemId) ?? null;

      // The optimistic flip — before the write, never after (plan). The
      // listener's latency compensation takes over almost immediately; the
      // override covers the await gap and the failure choreography.
      setOverride(itemId, next);
      if (itemKind === "material") {
        if (next) {
          setInSet(setOpenPanels, itemId, true);
          setInSet(setChoreoPanels, itemId, true);
          later(() => setInSet(setChoreoPanels, itemId, false), CHOREO_MS);
          flash(itemId, "wash");
        } else {
          setInSet(setOpenPanels, itemId, false);
        }
      }

      toggleProgressItem({
        runId,
        uid,
        weekNumber,
        itemKind,
        itemId,
        current,
        next,
      })
        .then(() => setOverride(itemId, null))
        .catch(() => {
          // The ONLY check-off case that gets a toast (plan's toast-vs-inline
          // rule). Revert lands a beat later so the refusal reads as an
          // undo, not a glitch.
          later(() => {
            setOverride(itemId, null);
            if (itemKind === "material") setInSet(setOpenPanels, itemId, false);
            flash(itemId, "error");
          }, REVERT_MS);
          void runToast(async () => {
            throw new Error(
              "That check-off didn't save — it has been undone. Check your connection and try again.",
            );
          });
        });
    },
    [
      canWrite,
      flash,
      later,
      progress.byItemId,
      runId,
      runToast,
      setInSet,
      setOverride,
      uid,
      weekNumber,
    ],
  );

  // ---- Moderation (admins only; the UI never renders it for anyone else) --
  const isAdmin = viewerRole === "admin";
  const reloadComments = comments.reload;

  const moderate = useCallback(
    (progressId: string, action: "hide" | "clear") => {
      void runToast(
        async () => {
          const res = await fetch(
            `/api/courses/progress/${encodeURIComponent(progressId)}/moderate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action }),
            },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(
              body?.error ?? `Couldn't update that comment (${res.status}).`,
            );
          }
          // The route is the only source of truth for what the lane shows —
          // a local edit would guess at a filter the server owns.
          reloadComments();
        },
        {
          savingMessage: action === "hide" ? "Hiding comment…" : "Restoring comment…",
          successMessage: action === "hide" ? "Comment hidden" : "Comment restored",
        },
      );
    },
    [reloadComments, runToast],
  );

  // ---- Early states (3-state pattern: Skeleton → EmptyState → PageEnter) --
  const runHomeHref = `/learn/${encodeURIComponent(runId)}`;

  if (overview.error) {
    return (
      <EmptyState
        title="Couldn't load this course"
        body={overview.error.message}
        action={<Link href="/learn">Back to your courses</Link>}
      />
    );
  }
  if (week.status === "error") {
    return (
      <EmptyState
        title="Couldn't load this week"
        body={week.error?.message}
        action={<Link href={runHomeHref}>Back to the course</Link>}
      />
    );
  }
  if (overview.loading || !overview.data || week.status === "loading" || progress.loading) {
    return <WeekSkeleton />;
  }
  if (week.status === "missing" || week.status === "unpublished") {
    return (
      <EmptyState
        title={
          week.status === "unpublished"
            ? "This week isn't published yet"
            : "This week doesn't exist"
        }
        body={
          week.status === "unpublished"
            ? "Your facilitators are still putting it together — check back soon."
            : undefined
        }
        action={<Link href={runHomeHref}>Back to the course</Link>}
      />
    );
  }

  const payload = overview.data;
  const weekDoc = week.week;
  if (!weekDoc) return <WeekSkeleton />; // unreachable; narrows the type

  // ---- Derived page facts -------------------------------------------------
  const hasEnrolment = payload.enrolment !== null;

  // Optional materials are deliberately excluded from BOTH sides of the
  // fraction — `Material.optional` is "excluded from completion percentages"
  // in the data model, and 100% must be reachable without extension reading.
  const countableIds = weekDoc.materials
    .filter((m) => !m.optional)
    .map((m) => m.id)
    .concat(weekDoc.checklist.map((c) => c.id));
  const doneCount = countableIds.filter((id) => isDone(id)).length;
  const weekComplete = countableIds.length > 0 && doneCount === countableIds.length;

  // The viewed week's slot start (civil-date maths, never elapsed ms) — what
  // SessionCard needs to name the concrete evening of THIS week's session.
  const planIndex = payload.run.weekPlan.findIndex(
    (e) => e.kind === "week" && e.weekNumber === weekNumber,
  );
  const slotStartKey =
    planIndex >= 0 && isValidDateKey(payload.run.startDate)
      ? addDaysToKey(payload.run.startDate, planIndex * DAYS_PER_WEEK)
      : null;

  // Footer nav walks taught weeks only — breaks are calendar padding, not
  // destinations — and is bounded by the plan.
  const taughtWeeks = payload.run.weekPlan.filter((e) => e.kind === "week");
  const taughtIndex = taughtWeeks.findIndex((e) => e.weekNumber === weekNumber);
  const prevWeek = taughtIndex > 0 ? taughtWeeks[taughtIndex - 1].weekNumber : null;
  const nextWeek =
    taughtIndex >= 0 && taughtIndex < taughtWeeks.length - 1
      ? taughtWeeks[taughtIndex + 1].weekNumber
      : null;
  const weekHref = (w: number) => `${runHomeHref}/weeks/${w}`;

  const rowClass = (id: string): string | undefined => {
    const parts: string[] = [];
    if (isDone(id)) parts.push(styles.itemDone);
    const f = flashes.get(id);
    if (f === "wash") parts.push(styles.itemWash);
    if (f === "error") parts.push(styles.itemError);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };

  return (
    <div>
      {/* Header + ProgressBar: the spatial anchor. Deliberately OUTSIDE
          PageEnter — across week↔week navigation this block must hold its
          position while only the content below travels. */}
      <header className={styles.header}>
        <p className={styles.eyebrow}>
          <Link href={runHomeHref} className={styles.eyebrowLink}>
            {payload.run.courseTitle || "Course"}
          </Link>
          <span aria-hidden="true"> — </span>
          Week {weekNumber} of {payload.run.totalWeeks}
        </p>
        <h1 className={styles.title}>{weekDoc.title || `Week ${weekNumber}`}</h1>
        {(weekDoc.estimatedMinutes !== null || !weekDoc.published) && (
          <p className={styles.meta}>
            {weekDoc.estimatedMinutes !== null && (
              <span>About {weekDoc.estimatedMinutes} min of materials</span>
            )}
            {!weekDoc.published && (
              // Learners never reach an unpublished week (useWeek gates), so
              // this chip only ever faces facilitators and admins.
              <Chip tone="warning" size="sm">
                Unpublished
              </Chip>
            )}
          </p>
        )}
        {hasEnrolment && countableIds.length > 0 && (
          <div className={styles.progress}>
            <ProgressBar
              value={doneCount}
              max={countableIds.length}
              ariaLabel="Week progress"
              tone={weekComplete ? "success" : "accent"}
              showLabel
              animateOnMount
            />
          </div>
        )}
      </header>

      <div className={styles.layout}>
        <aside className={styles.aside}>
          {payload.group && (
            <SessionCard group={payload.group} slotStartKey={slotStartKey} />
          )}
          <WeekRail
            plan={payload.run.weekPlan}
            anchorWeekNumber={payload.currentWeek?.anchorWeekNumber ?? 0}
            phase={payload.currentWeek?.phase ?? "before"}
            currentWeekNumber={payload.currentWeek?.weekNumber ?? null}
            // Only the viewed week's completion is computable here (other
            // weeks' item totals aren't in the payload); its ring closing on
            // 100% is the plan's week-completion moment.
            completedWeekNumbers={weekComplete ? [weekNumber] : []}
            hrefForWeek={weekHref}
            variant="strip"
            animate={false}
          />
        </aside>

        <PageEnter direction={navDir} className={styles.mainCol}>
          <PacingBanner
            runId={runId}
            viewedWeek={weekNumber}
            currentWeek={payload.currentWeek}
          />

          <WeekCurriculum
            week={weekDoc}
            renderMaterialAction={
              hasEnrolment
                ? (m) => (
                    <MaterialCheck
                      checked={isDone(m.id)}
                      disabled={!canWrite}
                      label={m.title || "Untitled"}
                      onToggle={(next) => handleToggle("material", m.id, next)}
                    />
                  )
                : undefined
            }
            renderChecklistAction={
              hasEnrolment
                ? (c) => (
                    <MaterialCheck
                      checked={isDone(c.id)}
                      disabled={!canWrite}
                      label={c.title || "Untitled"}
                      onToggle={(next) => handleToggle("checklist", c.id, next)}
                    />
                  )
                : undefined
            }
            materialClassName={hasEnrolment ? (m) => rowClass(m.id) : undefined}
            renderMaterialExtra={(m) => (
              <MaterialExtras
                runId={runId}
                uid={uid}
                weekNumber={weekNumber}
                material={m}
                row={progress.byItemId.get(m.id) ?? null}
                completed={isDone(m.id)}
                canReflect={canWrite}
                open={openPanels.has(m.id)}
                choreo={choreoPanels.has(m.id)}
                onOpen={() => setInSet(setOpenPanels, m.id, true)}
                onClose={() => setInSet(setOpenPanels, m.id, false)}
                comments={comments}
                canModerate={isAdmin}
                onModerate={moderate}
              />
            )}
            exercisesFooter={
              // Honest pre-P8 line, the pre-P4 CourseCTA precedent: name the
              // gap and the interim path rather than dead-ending.
              <p className={styles.exercisesNote}>
                Submitting exercises on the site opens soon — your facilitator
                will tell you where to send work this week.
              </p>
            }
          />

          {(prevWeek !== null || nextWeek !== null) && (
            <nav className={styles.weekNav} aria-label="Week navigation">
              {prevWeek !== null ? (
                <Link
                  href={weekHref(prevWeek)}
                  className={styles.weekNavLink}
                  onClick={() => setWeekNavDirection("right")}
                >
                  <span className={styles.navArrow} aria-hidden="true">
                    ←
                  </span>
                  Week {prevWeek}
                </Link>
              ) : (
                <span />
              )}
              {nextWeek !== null ? (
                <Link
                  href={weekHref(nextWeek)}
                  className={styles.weekNavLink}
                  onClick={() => setWeekNavDirection("left")}
                >
                  Week {nextWeek}
                  <span className={styles.navArrow} aria-hidden="true">
                    →
                  </span>
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </PageEnter>
      </div>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-material extras: reflection panel + cohort-notes disclosure
// ---------------------------------------------------------------------------

type Draft = { rating: number | null; comment: string; note: string };

type ExtrasProps = {
  runId: string;
  uid: string;
  weekNumber: number;
  material: Material;
  row: CourseProgressDoc | null;
  /** Optimistic — may lead `row.completed` by a beat. */
  completed: boolean;
  /** Active enrolment: may write reflections. */
  canReflect: boolean;
  open: boolean;
  /** True while this panel's open is part of a check-off choreography. */
  choreo: boolean;
  onOpen: () => void;
  onClose: () => void;
  comments: WeekComments;
  /**
   * Admin only. The moderated rows these controls act on reach nobody else's
   * payload, but the flag gates the RENDER as well — a control a member cannot
   * use must not appear beside their cohort's comments at all.
   */
  canModerate: boolean;
  onModerate: (progressId: string, action: "hide" | "clear") => void;
};

function MaterialExtras({
  runId,
  uid,
  weekNumber,
  material,
  row,
  completed,
  canReflect,
  open,
  choreo,
  onOpen,
  onClose,
  comments,
  canModerate,
  onModerate,
}: ExtrasProps) {
  const fieldId = useId();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notesOpen, setNotesOpen] = useState(false);

  // Draft seeded on open, discarded on close — the render-phase adjustment
  // pattern (no effect): seeding only when null means a Save landing mid-edit
  // never clobbers what the member is typing.
  const [draft, setDraft] = useState<Draft | null>(null);
  if (open && draft === null) {
    setDraft({
      rating: row?.rating ?? null,
      comment: row?.publicComment ?? "",
      note: row?.privateNote ?? "",
    });
  }
  if (!open && draft !== null) {
    setDraft(null);
  }

  const hasReflection = Boolean(
    row && (row.rating !== undefined || row.publicComment || row.privateNote),
  );

  const save = async () => {
    if (!draft || !row?.completed) return;
    setSaveState("saving");
    try {
      await saveProgressReflection({
        runId,
        uid,
        weekNumber,
        itemKind: "material",
        itemId: material.id,
        current: row,
        rating: draft.rating ?? undefined,
        publicComment: draft.comment.trim() ? draft.comment : undefined,
        privateNote: draft.note.trim() ? draft.note : undefined,
      });
      setSaveState("saved");
      // The member's own comment joins the cohort lane; refresh it if it has
      // been fetched (no-op otherwise — the eventual first load is fresh).
      comments.reload();
    } catch {
      // Inline, NOT a toast: reflection saves are keep-working feedback
      // (plan's toast-vs-inline rule). The error persists until the next try.
      setSaveState("error");
    }
  };

  const toggleNotes = () => {
    const next = !notesOpen;
    setNotesOpen(next);
    // First open anywhere on the page fetches the whole week once; reopening
    // after a failure retries rather than pinning the error for the session.
    if (next) {
      if (comments.error && !comments.loading) comments.reload();
      else comments.load();
    }
  };

  const noteRows = comments.byItemId.get(material.id) ?? EMPTY_ROWS;
  const noteCount = comments.loaded ? noteRows.length : null;

  const showReflection = canReflect && completed;
  const panelClass = [
    styles.panel,
    open ? styles.panelOpen : "",
    choreo ? styles.panelChoreo : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={styles.extras}>
      {showReflection && !open && (
        <button type="button" className={styles.reflectOpen} onClick={onOpen}>
          {hasReflection ? "Edit your reflection" : "Add a reflection"}
        </button>
      )}

      {showReflection && (
        // Always mounted while completed so the grid-rows track can animate
        // both ways; inert + aria-hidden park the form fields while closed.
        <div className={panelClass} aria-hidden={!open} inert={!open}>
          <div className={styles.panelInner}>
            <div className={styles.panelBody}>
              {row?.moderatedByUid && (
                <p className={styles.moderated}>
                  A moderator hid this comment. You can still edit it, but it
                  stays hidden from the cohort until a moderator clears it.
                </p>
              )}

              <div className={styles.stars}>
                <span className={styles.fieldLabel} id={`${fieldId}-rating`}>
                  How useful was this?
                </span>
                <StarRating
                  value={draft?.rating ?? null}
                  onChange={(n) => setDraft((d) => (d ? { ...d, rating: n } : d))}
                  onClear={() => setDraft((d) => (d ? { ...d, rating: null } : d))}
                  ariaLabel="How useful was this?"
                />
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={`${fieldId}-comment`}>
                  Reflection
                  <span className={styles.fieldHint}> · Visible to everyone on this run</span>
                </label>
                <CountedTextarea
                  id={`${fieldId}-comment`}
                  rows={3}
                  value={draft?.comment ?? ""}
                  max={PROGRESS_LIMITS.publicComment}
                  placeholder="What stood out? What would you tell the rest of your cohort?"
                  onChange={(e) => {
                    const comment = e.target.value;
                    setDraft((d) => (d ? { ...d, comment } : d));
                  }}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={`${fieldId}-note`}>
                  Private note
                  <span className={styles.fieldHint}> · Only facilitators and admins see this</span>
                </label>
                <CountedTextarea
                  id={`${fieldId}-note`}
                  rows={2}
                  value={draft?.note ?? ""}
                  max={PROGRESS_LIMITS.privateNote}
                  placeholder="Questions, sticking points, anything for your facilitator."
                  onChange={(e) => {
                    const note = e.target.value;
                    setDraft((d) => (d ? { ...d, note } : d));
                  }}
                />
              </div>

              <div className={styles.panelActions}>
                <Button size="sm" onClick={() => void save()} disabled={!row?.completed}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Skip
                </Button>
                <SavedFlash state={saveState} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={styles.notes}>
        <Accordion
          summary={
            <>
              <span>
                Cohort notes
                {noteCount !== null ? ` (${noteCount})` : ""}
              </span>
              <span
                className={notesOpen ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
                aria-hidden="true"
              >
                ▾
              </span>
            </>
          }
          open={notesOpen}
          onToggle={toggleNotes}
          summaryClassName={styles.notesSummary}
        >
          <div className={styles.notesBody}>
            {comments.loading && <Skeleton lines={2} ariaLabel="Loading cohort notes…" />}
            {!comments.loading && comments.error && (
              <p className={styles.notesEmpty}>{comments.error.message}</p>
            )}
            {comments.loaded && !comments.loading && noteRows.length === 0 && (
              <p className={styles.notesEmpty}>
                No notes on this yet — save a reflection and yours will appear here.
              </p>
            )}
            {noteRows.map((r) => (
              <div
                key={r.progressId}
                className={
                  r.moderated ? `${styles.noteRow} ${styles.noteHidden}` : styles.noteRow
                }
              >
                <div className={styles.noteHead}>
                  <span className={styles.noteName}>
                    <MemberName name={r.displayName} />
                  </span>
                  {r.rating !== null && (
                    <StarRating value={r.rating} readOnly ariaLabel="Their rating" size="sm" />
                  )}
                  {/* Hidden rows only ever arrive in an admin's payload; the
                      chip explains the dimming, which would otherwise read as
                      a loading state. */}
                  {canModerate && r.moderated && (
                    <Chip tone="warning" size="sm">
                      Hidden
                    </Chip>
                  )}
                  {canModerate && (
                    <button
                      type="button"
                      className={styles.moderate}
                      onClick={() =>
                        onModerate(r.progressId, r.moderated ? "clear" : "hide")
                      }
                    >
                      {r.moderated ? "Unhide" : "Hide"}
                    </button>
                  )}
                </div>
                {/* Member-authored plain text — MemberText is the XSS boundary.
                    Hidden rows keep their text: moderation is a visibility
                    stamp, and an admin deciding whether to restore one needs to
                    read what was taken down. */}
                <MemberText text={r.comment} className={styles.noteText} />
              </div>
            ))}
          </div>
        </Accordion>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — layout-matched (header, two columns) so arrival of the
// real page costs no reflow.
// ---------------------------------------------------------------------------

function WeekSkeleton() {
  return (
    <div>
      <header className={styles.header}>
        <Skeleton width="14rem" height="0.85rem" />
        <Skeleton width="60%" height="2.2rem" />
        <Skeleton width="100%" height="0.4rem" radius="var(--radius-pill)" />
      </header>
      <div className={styles.layout}>
        <div className={styles.aside}>
          <Skeleton height="9rem" radius="var(--radius-lg)" ariaLabel="" />
          <Skeleton height="2.25rem" ariaLabel="" />
        </div>
        <div className={styles.mainCol}>
          <Skeleton lines={4} height="2.5rem" />
        </div>
      </div>
    </div>
  );
}

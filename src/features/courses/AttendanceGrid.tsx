"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import EmptyState from "@/components/ui/EmptyState";
import MemberName from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import Skeleton from "@/components/ui/Skeleton";
import {
  ATTENDANCE_LIMITS,
  ATTENDANCE_STATUS_LABEL,
  type AttendanceStatus,
} from "@/lib/firestore/courseAttendance";
import styles from "./AttendanceGrid.module.css";
import ParticipantNoteDrawer from "./ParticipantNoteDrawer";
import PushConfirm from "./PushConfirm";
import useAttendance, {
  type AttendanceMark,
  type AttendanceMember,
  type AttendanceSession,
} from "./useAttendance";

/**
 * THE ATTENDANCE REGISTER: one group, every session so far, everyone in it.
 *
 * ── IT IS A REAL TABLE ──────────────────────────────────────────────────────
 * `<table>` with `<th scope="col">` sessions and `<th scope="row">` names,
 * because that is what it is: a screen reader announces "Ada Lovelace, Week 3,
 * Present" from the headers alone, and keyboard users get the table navigation
 * their software already provides. A grid of divs would need every one of
 * those behaviours reimplemented, badly.
 *
 * ── WHAT MOVES, AND WHAT NEVER DOES ─────────────────────────────────────────
 * Cell BACKGROUND and glyph SCALE animate. Row and column geometry NEVER does:
 * a register is read by scanning across a row and down a column, and a width
 * or height that animates drags every other cell out from under the eye that
 * is scanning it. Nothing here transitions width, height, padding or tracks.
 *
 * The glyph pops only where the FACILITATOR just acted (see `pop()`). Mounting
 * a half-marked register would otherwise fire thirty pops at once on load,
 * which reads as the page glitching rather than as feedback.
 *
 * ── THE FIVE-STATE TAP CYCLE ────────────────────────────────────────────────
 * unmarked, present, late, left-early, absent, excused, back to unmarked.
 * Present first because it is the overwhelmingly common answer and the whole
 * gesture is "tap everyone who came"; the rest in attended-most to
 * attended-least order, which is the order the rollup counts them in, so the
 * cycle reads as a slider rather than as a list. `null` is IN the cycle, not
 * an escape hatch beside it: a mis-tap must be undoable with more taps, never
 * with a modifier key or a second control.
 *
 * ── THE DRAFT / PUSHED BOUNDARY IS THE SHAPE OF THIS SCREEN ─────────────────
 * A column is a draft until PUSH ATTENDANCE. Pushing locks it, rebuilds every
 * member's attendance record and mails the group about the next session, so a
 * pushed column renders as read-only for a facilitator and stays editable for
 * an admin, whose every change is logged. The confirm in front of the button
 * (`PushConfirm`) names who is emailed, that the register locks, and how many
 * people are about to be counted absent for want of a mark.
 *
 * ── MID-RUN JOINERS ─────────────────────────────────────────────────────────
 * Cells before a member's `joinedWeekNumber` are INERT: a dash, not an
 * unmarked cell, with an aria-label that says why. Rendering them as markable
 * would invite a register that says someone was absent from sessions that
 * happened before they existed to the group. The routes refuse those writes
 * too; this is the visible half of one rule.
 *
 * PII: names arrive as `displayName` and render through `MemberName`.
 * Participant notes live behind the drawer, never in a cell, and carry their
 * own disclosure line. There is no email address anywhere in this component's
 * data, by construction.
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

const CYCLE: Array<AttendanceStatus | null> = [
  "present",
  "late",
  "left-early",
  "absent",
  "excused",
  null,
];

function nextStatus(current: AttendanceStatus | null): AttendanceStatus | null {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length];
}

/**
 * Tick and cross are read without a legend; the rest are lettered or arrowed
 * and decoded by the legend above the table. Colour is never the only signal:
 * each status has its own glyph as well as its own tone.
 */
const GLYPH: Record<AttendanceStatus, string> = {
  present: "✓",
  late: "L",
  "left-early": "↘",
  absent: "✕",
  excused: "E",
};

/**
 * An unmarked cell is not blank. A faint dot says "this is a control that has
 * not been used", which is the state a facilitator is scanning for; an empty
 * 44px square reads as a gap in the table instead.
 */
const UNMARKED_GLYPH = "·";

const STATUS_CLASS: Record<AttendanceStatus, string> = {
  present: styles.isPresent,
  late: styles.isLate,
  "left-early": styles.isLeftEarly,
  absent: styles.isAbsent,
  excused: styles.isExcused,
};

/** A beat over `--dur-settle` (260ms), so the pop class outlives its animation. */
const POP_MS = 320;

const NO_POPS: ReadonlySet<string> = new Set();

function cellKey(sessionKey: string, uid: string): string {
  return `${sessionKey} ${uid}`;
}

/** "Tue 6 Oct" from a civil date key, or "" when the session has no date. */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function dateLabel(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
  // Noon UTC: far enough from either boundary that no London offset can move
  // the civil date this label names.
  const at = new Date(`${dateKey}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? "" : DATE_FORMAT.format(at);
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
// The session note
// ---------------------------------------------------------------------------

/**
 * A note about the SESSION, not about any one person: "the projector died",
 * "we ran the second exercise as a whole group".
 *
 * It lives here rather than in its own file because it is one field and one
 * button, and it is deliberately NOT `ParticipantNoteDrawer`: that component
 * carries a disclosure line about personal data, which would be the wrong
 * thing to say about a note that names nobody. Two notes, two audiences, two
 * sentences.
 */
function SessionNoteDialog({
  session,
  onClose,
  onSave,
}: {
  session: AttendanceSession | null;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  // Seeded ONCE. The caller keys this component on the session, so pointing
  // it at a different one remounts it: no reseeding effect, and a reload
  // landing under an open dialog cannot wipe what is being typed.
  const [draft, setDraft] = useState(session?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That note didn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} ariaLabel="Note on this session">
      <div className={styles.dialog}>
        <h2 className={styles.dialogTitle}>
          Week {session.weekNumber}
          {session.occurrence > 1 ? `, session ${session.occurrence}` : ""}
        </h2>
        <p className={styles.dialogMeta}>
          About the session as a whole. For anything about a named person, use the
          note beside their cell instead.
        </p>
        <CountedTextarea
          value={draft}
          max={ATTENDANCE_LIMITS.notes}
          rows={5}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What a reader would need to know about this session later."
        />
        {error && (
          <p className={styles.error} role="status">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? "Saving..." : "Save note"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// AttendanceGrid
// ---------------------------------------------------------------------------

export default function AttendanceGrid({ groupId }: AttendanceGridProps) {
  const {
    group,
    sessions,
    members,
    records,
    participantNotes,
    canEditPushed,
    loading,
    error,
    reload,
    mark,
    edit,
    push,
    saveNote,
  } = useAttendance(groupId);
  const { toast, run: runAction, dismiss } = useActionToast();

  const [saveState, setSaveState] = useState<SaveState>("idle");
  /**
   * The route's OWN sentence for a refused single tap. `SavedFlash`'s error
   * copy is deliberately generic ("your last change isn't stored"), which is
   * right for an autosave and wrong here: this register refuses in specifics,
   * "Ada hadn't joined the group in week 3", "This register has been pushed",
   * and those sentences are the whole reason the facilitator can fix it.
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
    (sessionKey: string, uid: string): AttendanceStatus | null =>
      records[sessionKey]?.[uid] ?? null,
    [records],
  );

  // ---- The session a dialog is pointed at ----------------------------------

  const [pushTarget, setPushTarget] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [resendTarget, setResendTarget] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [noteTarget, setNoteTarget] = useState<{ sessionKey: string; uid: string } | null>(
    null,
  );
  const [sessionNoteTarget, setSessionNoteTarget] = useState<string | null>(null);

  const sessionByKey = useMemo(
    () => new Map(sessions.map((s) => [s.sessionKey, s])),
    [sessions],
  );
  const pushSession = pushTarget ? (sessionByKey.get(pushTarget) ?? null) : null;
  const resendSession = resendTarget ? (sessionByKey.get(resendTarget) ?? null) : null;
  const noteSession = noteTarget ? (sessionByKey.get(noteTarget.sessionKey) ?? null) : null;
  const noteMember = noteTarget
    ? (members.find((m) => m.uid === noteTarget.uid) ?? null)
    : null;
  const sessionNoteSession = sessionNoteTarget
    ? (sessionByKey.get(sessionNoteTarget) ?? null)
    : null;

  // ---- One tap -------------------------------------------------------------

  const onCycle = useCallback(
    async (session: AttendanceSession, member: AttendanceMember) => {
      const current = statusOf(session.sessionKey, member.uid);
      const next = nextStatus(current);
      setCellError(null);
      setSaveState("saving");
      pop([cellKey(session.sessionKey, member.uid)]);
      try {
        const marks: AttendanceMark[] = [{ uid: member.uid, status: next }];
        // A LOCKED register takes the admin's PATCH lane instead, which logs
        // the change. Same gesture, a different door, and a facilitator never
        // reaches it because their cells are not buttons.
        if (session.pushedAt) await edit(session, marks);
        else await mark(session, marks);
        setSaveState("saved");
      } catch (e) {
        // The hook has already put the cell back; this is the sentence.
        setSaveState("idle");
        setCellError(e instanceof Error ? e.message : "That didn't go through.");
      }
    },
    [edit, mark, pop, statusOf],
  );

  // ---- A whole column ------------------------------------------------------

  /**
   * "Mark the rest present": the bulk gesture a facilitator actually wants
   * after a session, since everyone who has not been given a status yet was
   * there.
   *
   * It never overwrites an EXISTING mark. A recorded absence is a considered
   * statement about a person, and a bulk button that could erase one would
   * make the register untrustworthy for exactly the cases it matters in.
   */
  const remainingFor = useCallback(
    (session: AttendanceSession): AttendanceMark[] =>
      members
        .filter(
          (m) =>
            session.weekNumber >= m.joinedWeekNumber &&
            statusOf(session.sessionKey, m.uid) === null,
        )
        .map((m) => ({ uid: m.uid, status: "present" as const })),
    [members, statusOf],
  );

  const onBulk = useCallback(
    (session: AttendanceSession) => {
      const targets = remainingFor(session);
      if (targets.length === 0) return;
      setCellError(null);
      pop(targets.map((t) => cellKey(session.sessionKey, t.uid)));
      void runAction(
        async () => {
          await mark(session, targets);
        },
        {
          savingMessage: `Marking ${targets.length} present…`,
          successMessage: `Week ${session.weekNumber}: ${targets.length} marked present.`,
        },
      );
    },
    [mark, pop, remainingFor, runAction],
  );

  // ---- The session's own switches ------------------------------------------

  const onToggleHeld = useCallback(
    (session: AttendanceSession) => {
      const next = !session.held;
      setCellError(null);
      void runAction(
        async () => {
          // A pushed register takes the admin's PATCH lane, which logs the
          // move and rebuilds every rollup the switch changes. Same gesture,
          // a different door, and a facilitator never sees the button.
          if (session.pushedAt) await edit(session, [], { held: next });
          else await mark(session, [], { held: next });
        },
        {
          savingMessage: next ? "Marking the session as held…" : "Marking the session as not held…",
          successMessage: next
            ? `Week ${session.weekNumber} counts in everyone's attendance again.`
            : `Week ${session.weekNumber} is out of everyone's attendance: it did not happen.`,
        },
      );
    },
    [edit, mark, runAction],
  );

  const onSessionNote = useCallback(
    async (session: AttendanceSession, text: string) => {
      setCellError(null);
      if (session.pushedAt) await edit(session, [], { notes: text });
      else await mark(session, [], { notes: text });
    },
    [edit, mark],
  );

  // ---- The push ------------------------------------------------------------

  const onPush = useCallback(async () => {
    if (!pushSession) return;
    setPushing(true);
    setCellError(null);
    try {
      const result = await push(pushSession);
      setPushTarget(null);
      // Reported through the toast rather than inline: this is the one action
      // on the page that must not be continued past without being read.
      void runAction(async () => undefined, {
        savingMessage: "Pushing…",
        successMessage: result.alreadyPushed
          ? "That register was already pushed, so nothing was sent again."
          : result.sent > 0
            ? `Register locked. ${result.sent} ${result.sent === 1 ? "person" : "people"} emailed about the next session.`
            : `Register locked. ${result.reason ?? "No email was sent."}`,
      });
    } catch (e) {
      setCellError(e instanceof Error ? e.message : "The push didn't go through.");
    } finally {
      setPushing(false);
    }
  }, [push, pushSession, runAction]);

  // ---- The admin's resend --------------------------------------------------

  /**
   * A push that locked the register and then failed to mail the group leaves
   * no lane a facilitator can use: the marker is claimed, so pressing Push
   * again reports "already pushed" and sends nothing. Before this button the
   * only recovery was the run-wide catch-up, which mails every OTHER group of
   * the run a second time.
   *
   * Admin only (the route refuses anyone else), behind a confirm, and every
   * press is recorded on the marker as a force.
   */
  const onResend = useCallback(async () => {
    if (!resendSession) return;
    setResending(true);
    setCellError(null);
    try {
      const result = await push(resendSession, { force: true });
      setResendTarget(null);
      void runAction(async () => undefined, {
        savingMessage: "Re-sending…",
        successMessage:
          result.sent > 0
            ? `${result.sent} ${result.sent === 1 ? "person" : "people"} emailed again about the next session.`
            : (result.reason ?? "No email was sent."),
      });
    } catch (e) {
      setCellError(e instanceof Error ? e.message : "The resend didn't go through.");
    } finally {
      setResending(false);
    }
  }, [push, resendSession, runAction]);

  // ---- Per-column tallies --------------------------------------------------

  /**
   * `marked / eligible` per session, where eligible excludes anyone who had
   * not joined yet: the same scoping the cells use, so the fraction can always
   * reach its denominator.
   */
  const tallies = useMemo(() => {
    const map = new Map<string, { marked: number; eligible: number }>();
    for (const session of sessions) {
      let marked = 0;
      let eligible = 0;
      for (const member of members) {
        if (session.weekNumber < member.joinedWeekNumber) continue;
        eligible += 1;
        if (statusOf(session.sessionKey, member.uid) !== null) marked += 1;
      }
      map.set(session.sessionKey, { marked, eligible });
    }
    return map;
  }, [sessions, members, statusOf]);

  // ---- States --------------------------------------------------------------

  const hasGrid = members.length > 0 || sessions.length > 0;

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
        body="Once allocation places members here, the register fills in a column per session."
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="This run has no taught weeks yet."
        body="Add weeks to the run's plan and the register will follow the cohort."
      />
    );
  }

  const pushTally = pushSession
    ? (tallies.get(pushSession.sessionKey) ?? { marked: 0, eligible: 0 })
    : { marked: 0, eligible: 0 };
  const pushIndex = pushSession
    ? sessions.findIndex((s) => s.sessionKey === pushSession.sessionKey)
    : -1;
  const nextAfterPush = pushIndex >= 0 ? (sessions[pushIndex + 1] ?? null) : null;

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
          loaded. The refusal wins: it is the newer thing, and it is the one
          the facilitator caused. */}
      {(cellError || error) && (
        <p className={styles.error} role="status">
          {cellError ?? error?.message}
        </p>
      )}

      {/* The register's OWN scroller. Never `.mainWide` (CLAUDE.md,
          "Main-area width"): a wide data view handles its own overflow, and
          the `min-width: 0` chain below is what keeps this table scrolling
          inside itself instead of widening the shell and orphaning the
          sidebar. The height bound is what gives the sticky header something
          to stick to: a container that cannot scroll vertically has no sticky
          to offer. */}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.caption}>
            Attendance for {group?.name || "this group"} — {members.length}{" "}
            {members.length === 1 ? "member" : "members"}, {sessions.length}{" "}
            {sessions.length === 1 ? "session" : "sessions"} so far. Each cell cycles
            through present, late, left early, absent, excused and back to not marked.
            A pushed register is locked.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${styles.head} ${styles.corner}`}>
                Member
              </th>
              {sessions.map((session) => {
                const tally = tallies.get(session.sessionKey) ?? {
                  marked: 0,
                  eligible: 0,
                };
                const remaining = tally.eligible - tally.marked;
                const pushed = session.pushedAt !== null;
                // Three states, because "nothing to do" has two very different
                // reasons: everyone is marked, or nobody had joined the group
                // that week. A column of joiners-to-be must not read as done.
                const bulkLabel =
                  tally.eligible === 0
                    ? "Nobody yet"
                    : remaining === 0
                      ? "All marked"
                      : `Rest present (${remaining})`;
                const when = dateLabel(session.dateKey);
                return (
                  <th
                    key={session.sessionKey}
                    scope="col"
                    className={`${styles.head} ${styles.weekHead} ${
                      pushed ? styles.headPushed : ""
                    }`}
                  >
                    <span className={styles.weekLabel}>
                      Week {session.weekNumber}
                      {session.occurrence > 1 ? ` (${session.occurrence})` : ""}
                    </span>
                    {when && <span className={styles.weekDate}>{when}</span>}
                    {session.title && (
                      <span className={styles.weekTitle}>{session.title}</span>
                    )}
                    <span className={styles.tally}>
                      {tally.marked}/{tally.eligible}
                    </span>

                    {!session.held && (
                      <span className={styles.notHeld}>Not held</span>
                    )}

                    {pushed && <span className={styles.pushed}>Pushed</span>}

                    {/* The bulk gesture and the push itself belong to the
                        DRAFT column only: one is how a facilitator finishes
                        marking, the other is the act of finishing. */}
                    {!pushed && (
                      <button
                        type="button"
                        className={styles.bulk}
                        onClick={() => onBulk(session)}
                        disabled={remaining === 0 || !session.held}
                        aria-label={
                          remaining === 0
                            ? `Week ${session.weekNumber}: ${bulkLabel}`
                            : `Mark the remaining ${remaining} present in week ${session.weekNumber}`
                        }
                      >
                        {bulkLabel}
                      </button>
                    )}

                    {/* The held switch and the session note stay on a PUSHED
                        column for whoever may correct one: PATCH supports both
                        and logs both, and "the fire alarm went off" is usually
                        written after the register has gone. */}
                    {(!pushed || canEditPushed) && (
                      <>
                        <button
                          type="button"
                          className={styles.bulk}
                          onClick={() => onToggleHeld(session)}
                          aria-label={
                            session.held
                              ? `Mark week ${session.weekNumber} as not held`
                              : `Mark week ${session.weekNumber} as held after all`
                          }
                        >
                          {session.held ? "Didn't happen" : "It did happen"}
                        </button>
                        <button
                          type="button"
                          className={styles.bulk}
                          onClick={() => setSessionNoteTarget(session.sessionKey)}
                          aria-label={`Note on week ${session.weekNumber} as a whole`}
                        >
                          {session.notes ? "Session note ✓" : "Session note"}
                        </button>
                      </>
                    )}

                    {!pushed && (
                      <button
                        type="button"
                        className={`${styles.bulk} ${styles.pushButton}`}
                        onClick={() => setPushTarget(session.sessionKey)}
                        aria-label={`Push the week ${session.weekNumber} register, which locks it and emails the group`}
                      >
                        Push
                      </button>
                    )}

                    {/* The recovery lane for a push whose mail failed after
                        the register locked. Admin only, and it reaches THIS
                        group alone. */}
                    {pushed && canEditPushed && (
                      <button
                        type="button"
                        className={styles.bulk}
                        onClick={() => setResendTarget(session.sessionKey)}
                        aria-label={`Send the week ${session.weekNumber} reminder to this group again`}
                      >
                        Resend reminder
                      </button>
                    )}
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
                {sessions.map((session) => {
                  const notYet = session.weekNumber < member.joinedWeekNumber;
                  const status = statusOf(session.sessionKey, member.uid);
                  const key = cellKey(session.sessionKey, member.uid);
                  const hasNote = Boolean(
                    participantNotes[session.sessionKey]?.[member.uid],
                  );

                  // INERT, not unmarked: see the mid-run joiner note above. A
                  // stored status here can only come from a `joinedWeekNumber`
                  // edited after the fact; it is shown rather than hidden, and
                  // stays uneditable.
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

                  // A pushed register is READ-ONLY unless the caller may
                  // correct one. The lock is a fact about the document, so it
                  // is rendered as a fact rather than as a disabled button
                  // nobody can explain.
                  const locked = session.pushedAt !== null && !canEditPushed;
                  const next = nextStatus(status);
                  return (
                    <td key={key} className={styles.cell}>
                      <div className={styles.cellStack}>
                        {locked ? (
                          <span
                            className={`${styles.cellButton} ${styles.cellLocked} ${
                              status ? STATUS_CLASS[status] : styles.isUnmarked
                            }`}
                            role="img"
                            aria-label={`${member.displayName}, week ${session.weekNumber}: ${
                              status ? ATTENDANCE_STATUS_LABEL[status] : "not marked"
                            }. This register is pushed and locked.`}
                          >
                            {status ? GLYPH[status] : UNMARKED_GLYPH}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`${styles.cellButton} ${
                              status ? STATUS_CLASS[status] : styles.isUnmarked
                            }`}
                            aria-pressed={status !== null}
                            aria-label={`${member.displayName}, week ${session.weekNumber}: ${
                              status ? ATTENDANCE_STATUS_LABEL[status] : "not marked"
                            }. Sets ${next ? ATTENDANCE_STATUS_LABEL[next] : "not marked"}.`}
                            onClick={() => void onCycle(session, member)}
                          >
                            {/* Keyed by status so a change REMOUNTS the glyph:
                                the pop animation then runs exactly once per
                                change, and only when this cell is in `popped`
                                (i.e. the facilitator did it, never on load). */}
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
                        )}
                        <button
                          type="button"
                          className={`${styles.noteDot} ${hasNote ? styles.noteDotSet : ""}`}
                          onClick={() =>
                            setNoteTarget({
                              sessionKey: session.sessionKey,
                              uid: member.uid,
                            })
                          }
                          aria-label={`${hasNote ? "Read or edit the" : "Add a"} private note on ${member.displayName} for week ${session.weekNumber}`}
                        >
                          <span aria-hidden="true">{hasNote ? "✎" : "+"}</span>
                        </button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PushConfirm
        open={pushSession !== null}
        onClose={() => setPushTarget(null)}
        onConfirm={() => void onPush()}
        busy={pushing}
        session={pushSession}
        groupName={group?.name ?? ""}
        eligible={pushTally.eligible}
        unmarked={Math.max(0, pushTally.eligible - pushTally.marked)}
        nextLabel={
          nextAfterPush
            ? `week ${nextAfterPush.weekNumber}${
                dateLabel(nextAfterPush.dateKey) ? ` on ${dateLabel(nextAfterPush.dateKey)}` : ""
              }`
            : null
        }
      />

      {resendSession && (
        <Modal
          open
          onClose={() => setResendTarget(null)}
          ariaLabel="Re-send this group's reminder"
          width="sm"
        >
          <div className={styles.dialog}>
            <h2 className={styles.dialogTitle}>
              Re-send the reminder after week {resendSession.weekNumber}
              {resendSession.occurrence > 1 ? `, session ${resendSession.occurrence}` : ""}?
            </h2>
            <p className={styles.dialogMeta}>
              This group has already been sent (or claimed) this reminder. Use it when
              the push locked the register but the email failed: everyone in{" "}
              {group?.name || "this group"} gets the message again, and nobody outside
              the group is emailed. The re-send is recorded against your name.
            </p>
            <div className={styles.dialogActions}>
              <Button
                variant="secondary"
                onClick={() => setResendTarget(null)}
                disabled={resending}
              >
                Cancel
              </Button>
              <Button onClick={() => void onResend()} disabled={resending}>
                {resending ? "Re-sending..." : "Re-send reminder"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <SessionNoteDialog
        key={sessionNoteSession?.sessionKey ?? "no-session-note"}
        session={sessionNoteSession}
        onClose={() => setSessionNoteTarget(null)}
        onSave={async (text) => {
          if (sessionNoteSession) await onSessionNote(sessionNoteSession, text);
        }}
      />

      <ParticipantNoteDrawer
        key={noteTarget ? `${noteTarget.sessionKey} ${noteTarget.uid}` : "no-note"}
        open={noteSession !== null && noteMember !== null}
        onClose={() => setNoteTarget(null)}
        session={noteSession}
        member={noteMember}
        note={
          noteTarget
            ? (participantNotes[noteTarget.sessionKey]?.[noteTarget.uid] ?? "")
            : ""
        }
        onSave={async (text) => {
          if (!noteSession || !noteMember) return;
          await saveNote(noteSession, noteMember.uid, text);
        }}
      />

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

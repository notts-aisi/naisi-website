"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AttendanceEditResult,
  AttendanceMarkResult,
  AttendancePayload,
  AttendanceSession,
} from "@/app/api/courses/groups/[groupId]/attendance/route";
import type { AttendancePushResult } from "@/app/api/courses/groups/[groupId]/attendance/push/route";
import type { ParticipantNoteResult } from "@/app/api/courses/groups/[groupId]/participant-notes/route";
import type { AttendanceStatus } from "@/lib/firestore/courseAttendance";

/**
 * One group's attendance register: the data behind `AttendanceGrid`.
 *
 * A one-shot fetch with a manual refresh (the `useReviewQueue` / `useMyExercises`
 * idiom), not `onSnapshot`, for the reasons those hooks give and one more of
 * this surface's own:
 *
 *  1. `courseAttendance` is `read/write: if false` in firestore.rules. The
 *     routes are the ONLY path to this data in either direction, and they are
 *     also what strip it down to names. There is no client query that could
 *     replace them.
 *  2. Nothing moves behind the facilitator's back. A register is typed by the
 *     person looking at the room; a standing listener would buy a live flip
 *     nobody is waiting for.
 *  3. The grid is OPTIMISTIC. A listener firing mid-gesture would fight the
 *     local value that has not been confirmed yet, exactly the flicker the
 *     optimistic path exists to avoid.
 *
 * ── KEY-TAGGED STORE (the P8 precedent, and load-bearing here) ──────────────
 * Every piece of state carries the `groupId` it was fetched for. A facilitator
 * who runs two groups can switch between them fast enough that the first
 * group's response lands after the second group's render, and merging that
 * would show one group's marks under the other group's roster. A stale
 * response whose key no longer matches is dropped, and so is a stale
 * optimistic patch or revert.
 *
 * ── WHAT IS NOT OPTIMISTIC, AND WHY ─────────────────────────────────────────
 * Marks are: they are small, reversible, and the whole gesture is tapping
 * quickly down a column. PUSH is not. It locks the register, rewrites every
 * member's attendance record and mails the group, and a UI that showed it as
 * done before the server agreed would be claiming an email had gone out. The
 * push and the note drawer both wait for their answer and then reload.
 *
 * ── PII BOUNDARY ────────────────────────────────────────────────────────────
 * The payload carries `displayName`, the marks, and the facilitator's own
 * participant notes. No email address, no lookup of its own, nothing derived
 * from a uid beyond using it as a key. Names render through `MemberName` and
 * notes through `MemberText`.
 */

export type { AttendanceStatus };

/** One cell's target state. `null` CLEARS the mark (back to unmarked). */
export type AttendanceMark = { uid: string; status: AttendanceStatus | null };

export type { AttendanceSession };
export type AttendanceMember = AttendancePayload["members"][number];
export type AttendanceRecords = AttendancePayload["records"];
export type AttendanceNotes = AttendancePayload["participantNotes"];

/** What one save is changing about one session, beyond its marks. */
export type SessionPatch = { held?: boolean; notes?: string };

export type AttendanceState = {
  group: AttendancePayload["group"] | null;
  /** The grid's columns: sessions up to and including the current week. */
  sessions: AttendanceSession[];
  /** The grid's rows: active members, name-sorted. */
  members: AttendanceMember[];
  /** `sessionKey -> uid -> status`. Sparse: absent means unmarked. */
  records: AttendanceRecords;
  /** `sessionKey -> uid -> note`. Private to staff. */
  participantNotes: AttendanceNotes;
  /** True when this caller may correct a register that is already pushed. */
  canEditPushed: boolean;
  /** True on the first load of a group AND on a manual refresh. */
  loading: boolean;
  /** A fetch for the CURRENT group has landed, so the grid is real. */
  loaded: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Mark cells, or change the session's held switch or note. Marks apply
   * OPTIMISTICALLY and revert if the write is refused; the session patch waits
   * for the answer, because a held switch that flickered would be read as a
   * cancelled session. THROWS so the caller can put the route's own sentence
   * in front of the facilitator.
   */
  mark: (
    session: AttendanceSession,
    marks: AttendanceMark[],
    patch?: SessionPatch,
  ) => Promise<void>;
  /**
   * An admin's correction to a register that is already pushed: marks, the
   * held switch, or the session note. Every change appends its own audit row.
   */
  edit: (
    session: AttendanceSession,
    marks: AttendanceMark[],
    patch?: SessionPatch,
  ) => Promise<AttendanceEditResult>;
  /**
   * PUSH ATTENDANCE. Locks the register, rebuilds the mirrors, mails the
   * group. `force` is the ADMIN-ONLY resend over a claimed reminder marker.
   */
  push: (
    session: AttendanceSession,
    opts?: { force?: boolean },
  ) => Promise<AttendancePushResult>;
  /** Write or clear one private note about one member for one session. */
  saveNote: (
    session: AttendanceSession,
    uid: string,
    note: string,
  ) => Promise<ParticipantNoteResult>;
};

const NO_SESSIONS: AttendanceSession[] = [];
const NO_MEMBERS: AttendanceMember[] = [];
const NO_RECORDS: AttendanceRecords = {};
const NO_NOTES: AttendanceNotes = {};

/**
 * A separator that cannot occur in a group id, so the composite stamp can
 * never be spelled two ways. (`useReviewQueue` and `useMyExercises` use the
 * same one.)
 */
const SEP = " ";

type Store = {
  key: string;
  data: AttendancePayload | null;
  error: Error | null;
};

/**
 * `records` with `marks` applied to one session: a pure function over a plain
 * object, so the optimistic patch and the revert are the same operation run
 * with different values. A session whose last mark is cleared loses its key
 * entirely, which keeps the payload's own "absent means unmarked" invariant
 * true of the local copy too.
 */
function withMarks(
  records: AttendanceRecords,
  sessionKey: string,
  marks: AttendanceMark[],
): AttendanceRecords {
  const week = { ...(records[sessionKey] ?? {}) };
  for (const mark of marks) {
    if (mark.status === null) delete week[mark.uid];
    else week[mark.uid] = mark.status;
  }
  const next = { ...records };
  if (Object.keys(week).length === 0) delete next[sessionKey];
  else next[sessionKey] = week;
  return next;
}

/** The route's own sentence where it gave one, a status where it did not. */
function errorFrom(
  body: { error?: string } | null,
  res: Response,
  fallback: string,
): string {
  return body?.error ?? `${fallback} (${res.status}).`;
}

export function useAttendance(groupId: string): AttendanceState {
  const idle = !groupId;
  const key = idle ? "" : groupId;

  const [store, setStore] = useState<Store>({ key: "", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  // The stamp whose fetch has landed. Deriving `loading` from the pair (rather
  // than flipping a boolean inside the effect body, which is a cascading
  // render) means a manual `reload()` reads as "refreshing" straight away.
  const [settled, setSettled] = useState("");

  const stamp = `${key}${SEP}${nonce}`;
  const endpoint = `/api/courses/groups/${encodeURIComponent(groupId)}/attendance`;

  useEffect(() => {
    if (idle) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/groups/${encodeURIComponent(groupId)}/attendance`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (AttendancePayload & { error?: string })
          | null;
        if (!res.ok || !body || !Array.isArray(body.members)) {
          // The route's own sentence where it gave one: a facilitator who has
          // been taken off the group needs to read "Forbidden", not "failed".
          throw new Error(body?.error ?? `Couldn't load the register (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (!cancelled) setStore({ key, data: payload, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A failed REFRESH keeps the grid it already had: replacing a register
        // someone is halfway through marking with an error card is the wrong
        // trade. A failed FIRST load of this key has nothing to keep.
        setStore((prev) => ({
          key,
          data: prev.key === key ? prev.data : null,
          error: e instanceof Error ? e : new Error(String(e)),
        }));
      })
      .finally(() => {
        if (!cancelled) setSettled(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, [idle, groupId, key, stamp, nonce]);

  const fresh = store.key === key ? store : null;
  const data = fresh?.data ?? null;

  const mark = useCallback(
    async (session: AttendanceSession, marks: AttendanceMark[], patch?: SessionPatch) => {
      if (!marks.length && !patch) return;
      const sessionKey = session.sessionKey;

      // What each cell held BEFORE the gesture, captured from the render's own
      // snapshot. The revert restores exactly these, and nothing else.
      const before = new Map<string, AttendanceStatus | null>();
      const current = data?.records[sessionKey] ?? {};
      for (const m of marks) before.set(m.uid, current[m.uid] ?? null);

      // OPTIMISTIC: the cells move now. Key-guarded like every other write
      // here. The session patch is NOT applied optimistically; it lands on the
      // reload below, because a held switch that flickered back would have
      // said a session was cancelled.
      if (marks.length) {
        setStore((prev) =>
          prev.key === key && prev.data
            ? {
                ...prev,
                data: {
                  ...prev.data,
                  records: withMarks(prev.data.records, sessionKey, marks),
                },
              }
            : prev,
        );
      }

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            weekNumber: session.weekNumber,
            occurrence: session.occurrence,
            ...(marks.length ? { marks } : {}),
            ...(patch?.held !== undefined ? { held: patch.held } : {}),
            ...(patch?.notes !== undefined ? { notes: patch.notes } : {}),
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | (Partial<AttendanceMarkResult> & { error?: string })
          | null;
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error ?? `That didn't go through (${res.status}).`);
        }
        // The session's own fields are server truth, so they arrive by reload
        // rather than by guess.
        if (patch) setNonce((n) => n + 1);
      } catch (e) {
        // REVERT, cell by cell, and only where the optimistic value is still
        // standing: a cell the facilitator has since re-marked belongs to that
        // later gesture, and yanking it back would undo a change they can see
        // themselves making. A revert for a group the grid has left is dropped
        // by the key guard: the failed write did not land anywhere either.
        if (marks.length) {
          setStore((prev) => {
            if (prev.key !== key || !prev.data) return prev;
            const week = prev.data.records[sessionKey] ?? {};
            const restore = marks.filter((m) => (week[m.uid] ?? null) === m.status);
            if (restore.length === 0) return prev;
            return {
              ...prev,
              data: {
                ...prev.data,
                records: withMarks(
                  prev.data.records,
                  sessionKey,
                  restore.map((m) => ({ uid: m.uid, status: before.get(m.uid) ?? null })),
                ),
              },
            };
          });
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    [data, endpoint, key],
  );

  const edit = useCallback(
    async (
      session: AttendanceSession,
      marks: AttendanceMark[],
      patch?: SessionPatch,
    ) => {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekNumber: session.weekNumber,
          occurrence: session.occurrence,
          marks,
          ...(patch?.held !== undefined ? { held: patch.held } : {}),
          ...(patch?.notes !== undefined ? { notes: patch.notes } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<AttendanceEditResult> & { error?: string })
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(errorFrom(body, res, "That correction didn't go through"));
      }
      setNonce((n) => n + 1);
      return body as AttendanceEditResult;
    },
    [endpoint],
  );

  const push = useCallback(
    async (session: AttendanceSession, opts?: { force?: boolean }) => {
      const res = await fetch(`${endpoint}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekNumber: session.weekNumber,
          occurrence: session.occurrence,
          ...(opts?.force ? { force: true } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<AttendancePushResult> & { error?: string })
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(errorFrom(body, res, "The push didn't go through"));
      }
      // ALWAYS reload: the register is locked now, and the grid has to show
      // that before the facilitator taps another cell into a 409.
      setNonce((n) => n + 1);
      return body as AttendancePushResult;
    },
    [endpoint],
  );

  const saveNote = useCallback(
    async (session: AttendanceSession, uid: string, note: string) => {
      const res = await fetch(
        `/api/courses/groups/${encodeURIComponent(groupId)}/participant-notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            weekNumber: session.weekNumber,
            occurrence: session.occurrence,
            uid,
            note,
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (Partial<ParticipantNoteResult> & { error?: string })
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(errorFrom(body, res, "That note didn't save"));
      }
      const saved = body as ParticipantNoteResult;
      // Merged locally rather than reloaded: the drawer is open over the grid,
      // and a full refetch under it would swap the roster out from beneath the
      // note the facilitator is reading.
      setStore((prev) => {
        if (prev.key !== key || !prev.data) return prev;
        const forSession = { ...(prev.data.participantNotes[saved.sessionKey] ?? {}) };
        if (saved.note) forSession[uid] = saved.note;
        else delete forSession[uid];
        const participantNotes = { ...prev.data.participantNotes };
        if (Object.keys(forSession).length === 0) delete participantNotes[saved.sessionKey];
        else participantNotes[saved.sessionKey] = forSession;
        return { ...prev, data: { ...prev.data, participantNotes } };
      });
      return saved;
    },
    [groupId, key],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const loading = idle ? false : settled !== stamp;

  return {
    group: data?.group ?? null,
    sessions: data?.sessions ?? NO_SESSIONS,
    members: data?.members ?? NO_MEMBERS,
    records: data?.records ?? NO_RECORDS,
    participantNotes: data?.participantNotes ?? NO_NOTES,
    canEditPushed: data?.canEditPushed ?? false,
    loading,
    loaded: !idle && !loading && data !== null,
    error: fresh?.error ?? null,
    reload,
    mark,
    edit,
    push,
    saveNote,
  };
}

export default useAttendance;

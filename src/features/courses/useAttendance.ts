"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AttendanceMarkResult,
  AttendancePayload,
} from "@/app/api/courses/groups/[groupId]/attendance/route";
import type { AttendanceStatus } from "@/lib/firestore/courseAttendance";

/**
 * One group's attendance register — the data behind `AttendanceGrid`.
 *
 * A one-shot fetch with a manual refresh (the `useReviewQueue` / `useMyExercises`
 * idiom), not `onSnapshot`, for the reasons those hooks give and one more of
 * this surface's own:
 *
 *  1. `courseAttendance` is `read/write: if false` in firestore.rules. The route
 *     is the ONLY path to this data in either direction, and it is also what
 *     strips it down to names. There is no client query that could replace it.
 *  2. Nothing moves behind the facilitator's back. A register is typed by the
 *     person looking at the room; a standing listener would buy a live flip
 *     nobody is waiting for.
 *  3. The grid is OPTIMISTIC. A listener firing mid-gesture would fight the
 *     local value that has not been confirmed yet — exactly the flicker the
 *     optimistic path exists to avoid.
 *
 * ── KEY-TAGGED STORE (the P8 precedent, and load-bearing here) ──────────────
 * Every piece of state carries the `groupId` it was fetched for. A facilitator
 * who runs two groups can switch between them fast enough that the first
 * group's response lands after the second group's render — and merging that
 * would show one group's marks under the other group's roster. A stale response
 * whose key no longer matches is dropped, and so is a stale optimistic patch or
 * revert.
 *
 * ── PII BOUNDARY ────────────────────────────────────────────────────────────
 * The payload carries `displayName` and nothing else identifying. This hook
 * adds no lookup of its own — no users read, no uid→email map, nothing derived
 * from a uid beyond using it as a key. Names render through `MemberName`.
 */

export type { AttendanceStatus };

/** One cell's target state. `null` CLEARS the mark (back to unmarked). */
export type AttendanceMark = { uid: string; status: AttendanceStatus | null };

export type AttendanceWeek = AttendancePayload["weeks"][number];
export type AttendanceMember = AttendancePayload["members"][number];
export type AttendanceRecords = AttendancePayload["records"];

export type AttendanceState = {
  group: AttendancePayload["group"] | null;
  /** The grid's columns — taught weeks up to and including the current one. */
  weeks: AttendanceWeek[];
  /** The grid's rows — active members, name-sorted. */
  members: AttendanceMember[];
  /** `String(weekNumber) -> uid -> status`. Sparse: absent means unmarked. */
  records: AttendanceRecords;
  /** True on the first load of a group AND on a manual refresh. */
  loading: boolean;
  /** A fetch for the CURRENT group has landed, so the grid is real. */
  loaded: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Mark one cell or a whole column. Applies OPTIMISTICALLY, then reverts the
   * cells it moved if the write is refused, and THROWS so the caller can put
   * the route's own sentence in front of the facilitator (a single tap through
   * `SavedFlash`, a bulk mark through `useActionToast`).
   */
  mark: (weekNumber: number, marks: AttendanceMark[]) => Promise<void>;
};

const NO_WEEKS: AttendanceWeek[] = [];
const NO_MEMBERS: AttendanceMember[] = [];
const NO_RECORDS: AttendanceRecords = {};

/**
 * A separator that cannot occur in a group id, so the composite stamp can never
 * be spelled two ways. (`useReviewQueue` and `useMyExercises` use the same one.)
 */
const SEP = " ";

type Store = {
  key: string;
  data: AttendancePayload | null;
  error: Error | null;
};

/**
 * `records` with `marks` applied to one week — a pure function over a plain
 * object, so the optimistic patch and the revert are the same operation run
 * with different values. A week whose last mark is cleared loses its key
 * entirely, which keeps the payload's own "absent means unmarked" invariant
 * true of the local copy too.
 */
function withMarks(
  records: AttendanceRecords,
  weekNumber: number,
  marks: AttendanceMark[],
): AttendanceRecords {
  const wk = String(weekNumber);
  const week = { ...(records[wk] ?? {}) };
  for (const mark of marks) {
    if (mark.status === null) delete week[mark.uid];
    else week[mark.uid] = mark.status;
  }
  const next = { ...records };
  if (Object.keys(week).length === 0) delete next[wk];
  else next[wk] = week;
  return next;
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
          throw new Error(
            body?.error ?? `Couldn't load the register (${res.status}).`,
          );
        }
        return body;
      })
      .then((payload) => {
        if (!cancelled) setStore({ key, data: payload, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A failed REFRESH keeps the grid it already had — replacing a register
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
    async (weekNumber: number, marks: AttendanceMark[]) => {
      if (!marks.length) return;

      // What each cell held BEFORE the gesture, captured from the render's own
      // snapshot. The revert restores exactly these, and nothing else.
      const before = new Map<string, AttendanceStatus | null>();
      const currentWeek = data?.records[String(weekNumber)] ?? {};
      for (const m of marks) before.set(m.uid, currentWeek[m.uid] ?? null);

      // OPTIMISTIC: the cell moves now. Key-guarded like every other write here.
      setStore((prev) =>
        prev.key === key && prev.data
          ? {
              ...prev,
              data: {
                ...prev.data,
                records: withMarks(prev.data.records, weekNumber, marks),
              },
            }
          : prev,
      );

      try {
        const res = await fetch(
          `/api/courses/groups/${encodeURIComponent(groupId)}/attendance`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ weekNumber, marks }),
          },
        );
        const body = (await res.json().catch(() => null)) as
          | (Partial<AttendanceMarkResult> & { error?: string })
          | null;
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error ?? `That didn't go through (${res.status}).`);
        }
      } catch (e) {
        // REVERT, cell by cell, and only where the optimistic value is still
        // standing: a cell the facilitator has since re-marked belongs to that
        // later gesture, and yanking it back would undo a change they can see
        // themselves making. A revert for a group the grid has left is dropped
        // by the key guard — the failed write did not land anywhere either.
        setStore((prev) => {
          if (prev.key !== key || !prev.data) return prev;
          const week = prev.data.records[String(weekNumber)] ?? {};
          const restore = marks.filter((m) => (week[m.uid] ?? null) === m.status);
          if (restore.length === 0) return prev;
          return {
            ...prev,
            data: {
              ...prev.data,
              records: withMarks(
                prev.data.records,
                weekNumber,
                restore.map((m) => ({ uid: m.uid, status: before.get(m.uid) ?? null })),
              ),
            },
          };
        });
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    [data, groupId, key],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const loading = idle ? false : settled !== stamp;

  return {
    group: data?.group ?? null,
    weeks: data?.weeks ?? NO_WEEKS,
    members: data?.members ?? NO_MEMBERS,
    records: data?.records ?? NO_RECORDS,
    loading,
    loaded: !idle && !loading && data !== null,
    error: fresh?.error ?? null,
    reload,
    mark,
  };
}

export default useAttendance;

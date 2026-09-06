"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import {
  addDaysToKey,
  isValidDateKey,
  type WeekPlanEntry,
} from "@/lib/courses/weekPlan";
import { getClientDb } from "@/lib/firebase/client";
import type { GroupSessionMode } from "@/lib/firestore/courseGroups";
import {
  normalizeCourseWeek,
  weekDocId,
  type ChecklistItem,
  type CourseWeekDoc,
  type Exercise,
  type Material,
} from "@/lib/firestore/courses";

/**
 * The facilitator editing surface's data layer: which of a group's weeks are
 * still tracking the course, which have been forked, and the four writes that
 * change that.
 *
 * ── COPY-ON-WRITE, READ SIDE ────────────────────────────────────────────────
 * A group has no weeks of its own until a facilitator edits one. Until then
 * `courseGroups/{groupId}/weeks` is EMPTY and the group reads the run's
 * canonical `courseRuns/{runId}/weeks/{wNN}` — which is why admin refinements
 * keep reaching a group right up to the moment its facilitator personalises
 * that week, and stop reaching it for good afterwards.
 *
 * So the read is two collections, not one, and the interesting value is the
 * PAIR: `canonical` (what the course says), `fork` (what this group says, when
 * it has said anything) and `effective` (the fork if there is one, else
 * canonical). Every row on the edit index is a statement about that pair, and
 * the editor needs both halves — the canonical one is what a facilitator is
 * shown BEFORE they fork, so the "what am I about to take a copy of" question
 * has an answer on screen.
 *
 * Both collections are `allow read: if isSignedIn()` in firestore.rules (the
 * group subcollection matching the run's weeks, deliberately: `published` is a
 * render gate, not a confidentiality boundary), so these are plain client-SDK
 * gets. The GROUP DOC is not — `courseGroups` reads are restricted to the
 * authoring tier, which a plain facilitator is not part of — so everything
 * that lives on the group doc (the pace overrides, the session and its
 * per-week mode) is read server-side by the page shells and handed down as
 * props. Do not add a group-doc read here; it would 403 for the exact people
 * this surface exists for.
 *
 * One-shot gets with a manual `reload`, not `onSnapshot`: curriculum does not
 * move under the person editing it, and every write on this surface goes
 * through a route and calls `reload()` itself.
 *
 * ── WRITES ARE ALL ROUTES ───────────────────────────────────────────────────
 * `courseGroups/{groupId}/weeks/**` is `allow write: if false` for everyone —
 * the facilitator trust boundary (text-safe fields only, never `guideBlocks`)
 * is a per-field judgement that rules cannot make, so it lives in the route
 * and the client is simply not a writer. The URL builders below are the ONE
 * place those endpoints are spelled; if a route lands on a different path,
 * this file is the single edit.
 */

// ---------------------------------------------------------------------------
// Endpoints — the single spelling
// ---------------------------------------------------------------------------

function groupBase(groupId: string): string {
  return `/api/courses/groups/${encodeURIComponent(groupId)}`;
}

/** POST — copies the canonical week into the group. Idempotent. */
export function groupWeekForkUrl(groupId: string, weekId: string): string {
  return `${groupBase(groupId)}/weeks/${encodeURIComponent(weekId)}/fork`;
}

/** PATCH — edits an ALREADY FORKED week. Refuses on an unforked one. */
export function groupWeekUrl(groupId: string, weekId: string): string {
  return `${groupBase(groupId)}/weeks/${encodeURIComponent(weekId)}`;
}

/** PATCH — the group's calendar overrides (`null` clears back to the run). */
export function groupPaceUrl(groupId: string): string {
  return `${groupBase(groupId)}/pace`;
}

/**
 * PATCH `{ weekId, mode }` — per-week session metadata on the group doc (the
 * virtual/in-person mode). `mode` is SERVER-OWNED, pinned in rules alongside
 * `memberCount`, so a route is the only way to write it.
 *
 * NOTE FOR THE ROUTE THAT IMPLEMENTS THIS: the pace route is its twin — same
 * gate (facilitator of this live group, or admin), same "unknown field is a
 * 400" body handling, and `mode: null` CLEARS the override rather than storing
 * a value, because "never set" and "explicitly in person" are different states
 * and `sessionModeForWeek` reports the difference.
 */
export function groupSessionUrl(groupId: string): string {
  return `${groupBase(groupId)}/session`;
}

/** POST — the operational room notice. */
export function groupNoticeUrl(groupId: string): string {
  return `${groupBase(groupId)}/notice`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A forked week: an EXACT `CourseWeekDoc` (ids preserved from the canonical at
 * fork time, so progress and exercise-response keys survive the fork) plus the
 * three fields that record where it came from.
 */
export type GroupWeekFork = {
  week: CourseWeekDoc;
  forkedAt: Date | null;
  forkedByUid: string | null;
  /** The canonical week's `updatedAt` at fork time; null when it had none. */
  forkedFromRunWeekAt: Date | null;
};

/** One row of the edit index — a plan slot with its content state resolved. */
export type GroupWeekRow =
  | {
      kind: "break";
      planIndex: number;
      label: string;
      /** Civil dates for the slot, or "" when the calendar has no start date. */
      from: string;
      to: string;
    }
  | {
      kind: "week";
      planIndex: number;
      weekNumber: number;
      from: string;
      to: string;
      /**
       * ALWAYS `weekDocId(weekNumber)`, never the plan entry's own `weekId` —
       * the one addressing doctrine every member-facing surface resolves. The
       * two can disagree on a reordered plan, and the fork this row's buttons
       * write must be the document this row's members read.
       */
      weekId: string;
      /** The run's week. Null when the slot points at a week nobody authored. */
      canonical: CourseWeekDoc | null;
      /** This group's own copy, when it has taken one. */
      fork: GroupWeekFork | null;
      /** Fork if present, else canonical — what this group's members read. */
      effective: CourseWeekDoc | null;
      forked: boolean;
    };

/** The fields a facilitator may change. Deliberately no `title`, no `guideBlocks`. */
export type GroupWeekPatch = {
  summary?: string;
  estimatedMinutes?: number | null;
  published?: boolean;
  materials?: Material[];
  exercises?: Exercise[];
  checklist?: ChecklistItem[];
  /** Set only after the person has read the real counts and ticked the box. */
  acknowledgeOrphans?: boolean;
};

/** Live rows referencing an item the patch would remove. Counted server-side. */
export type OrphanCount = {
  itemId: string;
  progress: number;
  responses: number;
};

export type PatchResult =
  | { kind: "ok" }
  /** Refused: removing these items would orphan real member work. */
  | { kind: "orphans"; message: string; orphans: OrphanCount[] }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function normalizeFork(id: string, raw: Record<string, unknown>): GroupWeekFork {
  return {
    // The SAME normaliser the canonical week goes through: a fork is a
    // `CourseWeekDoc`, not a look-alike, and anything that renders one renders
    // the other without knowing which it has.
    week: normalizeCourseWeek(id, raw),
    forkedAt: tsToDate(raw.forkedAt),
    forkedByUid:
      typeof raw.forkedByUid === "string" && raw.forkedByUid ? raw.forkedByUid : null,
    forkedFromRunWeekAt: tsToDate(raw.forkedFromRunWeekAt),
  };
}

// ---------------------------------------------------------------------------
// Route calls
// ---------------------------------------------------------------------------

/** Carries the route's parsed body so a refusal can be inspected, not just read. */
class RouteError extends Error {
  readonly payload: Record<string, unknown>;

  constructor(message: string, payload: Record<string, unknown>) {
    super(message);
    this.name = "RouteError";
    this.payload = payload;
  }
}

async function requestJson(
  url: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<Record<string, unknown>> {
  // Same-origin default carries the session cookie; no `credentials` needed.
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!res.ok || payload?.ok !== true) {
    // The route's own sentence where it gave one — a facilitator taken off the
    // group needs to read what the route said, not "something went wrong".
    const sentence =
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : null;
    throw new RouteError(
      sentence ?? `That didn't go through (${res.status}).`,
      payload ?? {},
    );
  }
  return payload;
}

function readOrphans(payload: Record<string, unknown>): OrphanCount[] {
  const raw = payload.orphans;
  if (!Array.isArray(raw)) return [];
  const out: OrphanCount[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.itemId !== "string" || !row.itemId) continue;
    out.push({
      itemId: row.itemId,
      progress: typeof row.progress === "number" ? Math.max(0, row.progress) : 0,
      responses: typeof row.responses === "number" ? Math.max(0, row.responses) : 0,
    });
  }
  return out;
}

/**
 * Take this group's own copy of a week. Idempotent by contract — the route
 * creates the doc and reports `alreadyForked` rather than failing when a
 * second click (or a second facilitator) gets there first.
 */
export async function forkGroupWeek(
  groupId: string,
  weekId: string,
): Promise<{ alreadyForked: boolean }> {
  const payload = await requestJson(groupWeekForkUrl(groupId, weekId), "POST");
  return { alreadyForked: payload.alreadyForked === true };
}

/**
 * Edit a forked week. Never throws for the two outcomes the UI has something
 * to say about — an ordinary refusal and the orphan refusal are both RESULTS,
 * because the orphan one carries the counts the acknowledge panel exists to
 * show.
 */
export async function patchGroupWeek(
  groupId: string,
  weekId: string,
  patch: GroupWeekPatch,
): Promise<PatchResult> {
  try {
    await requestJson(groupWeekUrl(groupId, weekId), "PATCH", patch);
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof RouteError) {
      const orphans = readOrphans(err.payload);
      if (orphans.length > 0) {
        return { kind: "orphans", message: err.message, orphans };
      }
      return { kind: "error", message: err.message };
    }
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "That didn't go through.",
    };
  }
}

/** The group's calendar overrides. `null` on a field clears it back to the run. */
export async function patchGroupPace(
  groupId: string,
  body: { paceStartDate?: string | null; paceWeekPlan?: WeekPlanEntry[] | null },
): Promise<void> {
  await requestJson(groupPaceUrl(groupId), "PATCH", body);
}

/**
 * Set (or clear, with `null`) how one week meets. `mode` is server-owned — it
 * is pinned in rules like `memberCount`, so this route is the only writer.
 */
export async function setGroupWeekMode(
  groupId: string,
  weekId: string,
  mode: GroupSessionMode | null,
): Promise<void> {
  await requestJson(groupSessionUrl(groupId), "PATCH", { weekId, mode });
}

// ---------------------------------------------------------------------------
// useGroupWeeks — the edit index
// ---------------------------------------------------------------------------

type Store = {
  stamp: string;
  key: string;
  canonical: Map<string, CourseWeekDoc>;
  forks: Map<string, GroupWeekFork>;
  error: Error | null;
};

export type GroupWeeksState = {
  rows: GroupWeekRow[];
  /** How many taught weeks this group has taken its own copy of. */
  forkedCount: number;
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

const NO_ROWS: GroupWeekRow[] = [];

/**
 * Every slot of the calendar this group actually teaches to, paired with its
 * content state.
 *
 * `weekPlan` and `startDate` are the RESOLVED calendar — the group's overrides
 * where it has them, the run's otherwise — computed by the page shell through
 * `resolveCalendar`. This hook never decides which calendar is in force; it is
 * handed one and paints the content state onto it.
 */
export function useGroupWeeks(
  runId: string,
  groupId: string,
  weekPlan: WeekPlanEntry[],
  startDate: string,
): GroupWeeksState {
  const key = runId && groupId ? `${runId}/${groupId}` : "";
  const [nonce, setNonce] = useState(0);
  const [store, setStore] = useState<Store | null>(null);

  const stamp = `${key}#${nonce}`;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const db = getClientDb();

    Promise.all([
      getDocs(collection(db, "courseRuns", runId, "weeks")),
      getDocs(collection(db, "courseGroups", groupId, "weeks")),
    ])
      .then(([runWeeks, groupWeeks]) => {
        if (cancelled) return;
        const canonical = new Map<string, CourseWeekDoc>();
        runWeeks.forEach((snap) => {
          canonical.set(snap.id, normalizeCourseWeek(snap.id, snap.data() ?? {}));
        });
        const forks = new Map<string, GroupWeekFork>();
        groupWeeks.forEach((snap) => {
          forks.set(snap.id, normalizeFork(snap.id, snap.data() ?? {}));
        });
        setStore({ stamp, key, canonical, forks, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("useGroupWeeks:", err);
        setStore({
          stamp,
          key,
          canonical: new Map(),
          forks: new Map(),
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [key, runId, groupId, stamp]);

  const fresh = store && store.key === key && !store.error ? store : null;

  const rows = useMemo<GroupWeekRow[]>(() => {
    if (!fresh) return NO_ROWS;
    const dated = isValidDateKey(startDate);
    return weekPlan.map((entry, planIndex) => {
      const from = dated ? addDaysToKey(startDate, planIndex * 7) : "";
      const to = from ? addDaysToKey(from, 6) : "";
      if (entry.kind === "break") {
        return { kind: "break", planIndex, label: entry.label, from, to };
      }
      // ── ONE WEEK-ADDRESSING DOCTRINE: `weekDocId(weekNumber)` ────────────
      // NOT `entry.weekId`. `WeekPlanBuilder.renumber()` preserves each plan
      // entry's own `weekId` and reassigns its `weekNumber`, and says outright
      // that the two may legitimately disagree — while EVERY member-facing
      // surface (the week page, the rail, the register, the task mirror, the
      // nudge, the fork resolver) addresses `weekDocId(weekNumber)`. Reading
      // the plan's spelling here made this editor the only surface on the other
      // doctrine: after a break insert the facilitator would fork "w03" while
      // their own members read "w04", and the fork would be invisible to the
      // group it was made for — the one failure this whole file exists to
      // prevent. See `tests/course-schedule-changes.test.mjs`, "one press of ▲
      // permutes the curriculum the cohort reads".
      const weekId = weekDocId(entry.weekNumber);
      const canonical = fresh.canonical.get(weekId) ?? null;
      const fork = fresh.forks.get(weekId) ?? null;
      return {
        kind: "week",
        planIndex,
        weekNumber: entry.weekNumber,
        weekId,
        from,
        to,
        canonical,
        fork,
        effective: fork?.week ?? canonical,
        forked: fork !== null,
      };
    });
  }, [fresh, weekPlan, startDate]);

  const forkedCount = useMemo(
    () => rows.filter((row) => row.kind === "week" && row.forked).length,
    [rows],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    rows,
    forkedCount,
    loading: !key ? false : store?.stamp !== stamp,
    error: store && store.key === key ? store.error : null,
    reload,
  };
}

// ---------------------------------------------------------------------------
// useGroupWeek — one week, both halves
// ---------------------------------------------------------------------------

export type GroupWeekState = {
  /** The run's week. Null when the plan slot points at nothing authored. */
  canonical: CourseWeekDoc | null;
  fork: GroupWeekFork | null;
  /** Fork if present, else canonical — what this group's members read today. */
  effective: CourseWeekDoc | null;
  forked: boolean;
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

type SingleStore = {
  stamp: string;
  key: string;
  canonical: CourseWeekDoc | null;
  fork: GroupWeekFork | null;
  error: Error | null;
};

export function useGroupWeek(
  runId: string,
  groupId: string,
  weekId: string,
): GroupWeekState {
  const key = runId && groupId && weekId ? `${runId}/${groupId}/${weekId}` : "";
  const [nonce, setNonce] = useState(0);
  const [store, setStore] = useState<SingleStore | null>(null);

  const stamp = `${key}#${nonce}`;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const db = getClientDb();

    Promise.all([
      getDoc(doc(db, "courseRuns", runId, "weeks", weekId)),
      getDoc(doc(db, "courseGroups", groupId, "weeks", weekId)),
    ])
      .then(([runWeek, groupWeek]) => {
        if (cancelled) return;
        setStore({
          stamp,
          key,
          canonical: runWeek.exists()
            ? normalizeCourseWeek(runWeek.id, runWeek.data() ?? {})
            : null,
          fork: groupWeek.exists()
            ? normalizeFork(groupWeek.id, groupWeek.data() ?? {})
            : null,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("useGroupWeek:", err);
        setStore({
          stamp,
          key,
          canonical: null,
          fork: null,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [key, runId, groupId, weekId, stamp]);

  const fresh = store && store.key === key ? store : null;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    canonical: fresh?.error ? null : (fresh?.canonical ?? null),
    fork: fresh?.error ? null : (fresh?.fork ?? null),
    effective: fresh?.error ? null : (fresh?.fork?.week ?? fresh?.canonical ?? null),
    forked: !fresh?.error && Boolean(fresh?.fork),
    loading: !key ? false : store?.stamp !== stamp,
    error: fresh?.error ?? null,
    reload,
  };
}

export default useGroupWeeks;

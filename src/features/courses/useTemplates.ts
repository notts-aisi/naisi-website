"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RETRO_ANONYMITY_FLOOR,
  templateRowOrder,
  type CourseTemplateRow,
  type MaterialRetroRow,
  type RetroFacilitatorNote,
} from "@/lib/firestore/courseTemplates";
import { MATERIAL_NOTE_LIMITS } from "@/lib/firestore/courseMaterialNotes";
import { cloneWeeksFromRun } from "./courseMutations";

/**
 * Course templates + the run retrospective — the client half of V2-2.
 *
 * The SHAPES come from `@/lib/firestore/courseTemplates`, which is isomorphic
 * on purpose (no `server-only`, no `firebase-admin`) precisely so this file and
 * the routes agree by construction rather than by two hand-copied type
 * declarations. What lives here is the crossing: a payload that has been
 * through JSON is `unknown` until something checks it, so every response passes
 * a normaliser below and a route answering an unrecognised shape produces an
 * empty list and a visible error rather than a half-drawn card.
 *
 * Reads are one-shot fetches with a manual refresh (the `useAllocation` idiom),
 * never `onSnapshot`. `courseTemplates` and `courseMaterialNotes` both refuse
 * every client write in rules and are read by staff through routes, so there is
 * no client query a listener could stand on — and nothing moves behind the
 * reader's back: an append-only editorial collection is touched by one admin at
 * a time.
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Read a route response without ever throwing on a malformed body — a 500 from
 * the platform is an HTML error page, and that has to reach the reader as a
 * sentence rather than a JSON syntax error.
 */
async function readBody<T extends object>(
  res: Response,
): Promise<(T & { ok?: true; error?: string }) | null> {
  return (await res.json().catch(() => null)) as (T & { ok?: true; error?: string }) | null;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/**
 * Whatever a Firestore timestamp looks like once it has crossed JSON, as an
 * ISO string. `toTemplateRow()` sends a string, but a route that forgets it
 * would hand over the Admin SDK's `{_seconds, _nanoseconds}` — accepting both
 * means provenance never silently reads "date unknown" because of a
 * serialisation detail on the far side of the wire.
 */
function isoOrNull(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (v && typeof v === "object") {
    const raw = v as { seconds?: unknown; _seconds?: unknown };
    const seconds =
      typeof raw.seconds === "number"
        ? raw.seconds
        : typeof raw._seconds === "number"
          ? raw._seconds
          : null;
    if (seconds !== null) return new Date(seconds * 1000).toISOString();
  }
  return null;
}

/** Day-precision display for a wire instant. `null` reads as unknown, never as today. */
export function formatWireStamp(iso: string | null): string {
  if (!iso) return "date unknown";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "date unknown";
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The first candidate that is actually an array. Unwraps list envelopes. */
function firstArray(...candidates: unknown[]): unknown[] {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function normalizeTemplateRow(raw: unknown): CourseTemplateRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // A row with no address is unusable — it can't be applied and it can't be
  // deleted — so it is dropped rather than rendered as an inert line.
  const id = str(r.id);
  if (!id) return null;

  const retro = r.retrospective;
  return {
    id,
    courseId: str(r.courseId),
    courseTitle: str(r.courseTitle),
    label: str(r.label),
    sourceRunId: str(r.sourceRunId),
    sourceGroupId: str(r.sourceGroupId) || null,
    savedAt: isoOrNull(r.savedAt),
    savedByUid: str(r.savedByUid),
    savedByName: str(r.savedByName),
    weekCount: count(r.weekCount),
    retrospective:
      retro && typeof retro === "object"
        ? {
            runLabel: str((retro as Record<string, unknown>).runLabel),
            memberCount: count((retro as Record<string, unknown>).memberCount),
            ratedMaterialCount: count(
              (retro as Record<string, unknown>).ratedMaterialCount,
            ),
          }
        : null,
  };
}

export type SaveTemplateInput = {
  label: string;
  sourceRunId: string;
  /**
   * Reserved for V2-3, where a diverged group's curriculum becomes a snapshot
   * source. Today every save freezes the run canonical weeks, so callers pass
   * `null` (or omit it) and the route stores `null`.
   */
  sourceGroupId?: string | null;
};

export type UseCourseTemplates = {
  /** Newest first — `templateRowOrder`, the collection's own reading order. */
  templates: CourseTemplateRow[];
  /** True until the first payload for THIS courseId has landed. */
  loading: boolean;
  /** A refresh in flight, with the previous rows still on screen. */
  refreshing: boolean;
  error: Error | null;
  reload: () => void;
  /** THROWS on refusal — callers wrap it in `useActionToast().run`. */
  saveTemplate: (input: SaveTemplateInput) => Promise<string>;
  /** THROWS on refusal. */
  deleteTemplate: (templateId: string) => Promise<void>;
};

const NO_TEMPLATES: CourseTemplateRow[] = [];

/** Every saved iteration of one course. */
export function useCourseTemplates(courseId: string): UseCourseTemplates {
  // Key-tagged store (the `useGroupRoster` idiom): switching course must DROP
  // the previous course's templates rather than show them under a new family
  // heading, and carrying the key the rows were fetched for is the only way to
  // be sure of that.
  const [store, setStore] = useState<{
    key: string;
    rows: CourseTemplateRow[];
    error: Error | null;
  }>({ key: "", rows: NO_TEMPLATES, error: null });
  const [nonce, setNonce] = useState(0);
  // The stamp whose fetch has landed. Derived rather than a boolean flipped
  // inside the effect body (which is a cascading render), so a manual
  // `reload()` reads as "refreshing" on the frame it is clicked.
  const [settled, setSettled] = useState("");

  const idle = !courseId;
  const stamp = `${courseId}#${nonce}`;

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/${encodeURIComponent(courseId)}/templates`)
      .then(async (res) => {
        const body = await readBody<{ templates?: unknown }>(res);
        if (!res.ok) {
          // The route's own sentence where it gave one: a drafter who has lost
          // the permission needs to read "Forbidden", not "failed".
          throw new Error(body?.error ?? `Couldn't load saved templates (${res.status}).`);
        }
        const rows = firstArray(body?.templates)
          .map(normalizeTemplateRow)
          .filter((t): t is CourseTemplateRow => t !== null);
        // Sorted client-side even though the route sorts too: `savedAt` is
        // exactly the sparse field an `orderBy` would silently drop a document
        // for missing, and `templateRowOrder` is the shared answer to it.
        rows.sort(templateRowOrder);
        return rows;
      })
      .then((rows) => {
        if (!cancelled) setStore({ key: courseId, rows, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A failed REFRESH keeps the rows it already had; a failed first load
        // of this key has nothing to keep and shows the error alone.
        setStore((prev) => ({
          key: courseId,
          rows: prev.key === courseId ? prev.rows : NO_TEMPLATES,
          error: asError(e),
        }));
      })
      .finally(() => {
        if (!cancelled) setSettled(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, stamp]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const saveTemplate = useCallback(
    async (input: SaveTemplateInput): Promise<string> => {
      const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/templates`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          label: input.label,
          sourceRunId: input.sourceRunId,
          sourceGroupId: input.sourceGroupId ?? null,
        }),
      });
      const body = await readBody<{ templateId?: unknown }>(res);
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `Couldn't save this template (${res.status}).`);
      }
      reload();
      return str(body.templateId);
    },
    [courseId, reload],
  );

  const deleteTemplate = useCallback(
    async (templateId: string): Promise<void> => {
      const res = await fetch(`/api/courses/templates/${encodeURIComponent(templateId)}`, {
        method: "DELETE",
      });
      const body = await readBody<Record<string, never>>(res);
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `Couldn't delete this template (${res.status}).`);
      }
      reload();
    },
    [reload],
  );

  const fresh = store.key === courseId;
  return {
    templates: fresh ? store.rows : NO_TEMPLATES,
    loading: !idle && !fresh,
    refreshing: !idle && settled !== stamp,
    error: fresh ? store.error : null,
    reload,
    saveTemplate,
    deleteTemplate,
  };
}

// ---------------------------------------------------------------------------
// Applying a curriculum source
// ---------------------------------------------------------------------------

/** Where a run's weeks are about to be copied from. */
export type CurriculumSource =
  | { kind: "template"; id: string }
  | { kind: "run"; id: string };

/**
 * The result of a copy. Returned, never thrown, because the two failure modes
 * are not the same thing to the person reading them: `refused` means the server
 * looked, said no, and changed NOTHING — authored weeks standing in the way, or
 * member work a replace would orphan. That is a stop, not something to retry.
 */
export type ApplyOutcome =
  | { ok: true; message: string }
  | { ok: false; refused: boolean; error: string };

/**
 * How many removed week ids the receipt spells out before it starts counting.
 * A replace can drop up to 59 weeks and a sentence that names all of them is
 * not a receipt — but the first few are what an admin recognises, so the list
 * is truncated rather than dropped.
 */
const MAX_NAMED_REMOVALS = 6;

/**
 * Best sentence available for a successful template apply.
 *
 * REMOVALS ARE STATED PLAINLY. The route has always returned `removed` — week
 * documents deleted because the snapshot has no counterpart for them — and
 * this function used to read only `created` and `replaced`, so a replace that
 * silently dropped two weeks reported "Copied 6 weeks · replaced 6." and left
 * the admin to notice the gap themselves. A deletion is the one outcome that
 * cannot be checked afterwards by looking at the screen, because the thing to
 * look at is what went; so it is named, with the ids where the route sends
 * them.
 */
function applyMessage(body: Record<string, unknown> | null): string {
  const created = typeof body?.created === "number" ? Math.max(0, body.created) : null;
  const replaced = typeof body?.replaced === "number" ? Math.max(0, body.replaced) : null;
  const removedIds = firstArray(body?.removedIds)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  // The COUNT is authoritative, not the id list: a route that reports the
  // number without the names must still say a removal happened.
  const removed =
    typeof body?.removed === "number" ? Math.max(0, body.removed) : removedIds.length;

  if (created === null && replaced === null && removed === 0) {
    return "The template's weeks are on this run.";
  }
  const parts: string[] = [];
  if (created !== null) parts.push(`Copied ${created} week${created === 1 ? "" : "s"}`);
  if (replaced) parts.push(`replaced ${replaced} that already existed here`);
  if (removed > 0) {
    const named = removedIds.slice(0, MAX_NAMED_REMOVALS);
    const rest = removedIds.length - named.length;
    const which =
      named.length > 0
        ? ` (${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})`
        : "";
    parts.push(
      `removed ${removed} the template doesn't have${which}`,
    );
  }
  return `${parts.join(" · ")}.`;
}

/**
 * Copy a curriculum into `runId` from either a saved template or another run.
 *
 * One function for both because it is one decision to the admin making it, and
 * because the outcome has to read the same either way. The paths differ only in
 * which server owns the invariant: `clone-weeks` for a run source (the
 * pre-existing copy-forward route), `apply-template` for a snapshot — the
 * latter is also the one that refuses a replace outright while any member has
 * progress or an exercise response on the run.
 */
export async function applyCurriculumSource(
  runId: string,
  source: CurriculumSource,
  replace: boolean,
): Promise<ApplyOutcome> {
  if (source.kind === "run") {
    try {
      const res = await cloneWeeksFromRun(runId, source.id, replace);
      return {
        ok: true,
        message:
          `Copied ${res.created} week${res.created === 1 ? "" : "s"}` +
          (res.skipped > 0 ? ` · skipped ${res.skipped} that already existed here.` : "."),
      };
    } catch (e: unknown) {
      return { ok: false, refused: false, error: messageFrom(e) };
    }
  }

  try {
    const res = await fetch(`/api/courses/runs/${encodeURIComponent(runId)}/apply-template`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ templateId: source.id, replace }),
    });
    const body = await readBody<Record<string, unknown>>(res);
    // 409 is the conflict lane the allocation publish route already uses for
    // "I looked, and I am not doing this": weeks in the way, or member work a
    // replace would orphan. The route's own sentence says which.
    if (res.status === 409) {
      return {
        ok: false,
        refused: true,
        error:
          body?.error ??
          "This run already has weeks the copy would overwrite, so nothing was copied.",
      };
    }
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        refused: false,
        error: body?.error ?? `That copy didn't go through (${res.status}).`,
      };
    }
    return { ok: true, message: applyMessage(body) };
  } catch (e: unknown) {
    return { ok: false, refused: false, error: messageFrom(e) };
  }
}

// ---------------------------------------------------------------------------
// Retrospective
// ---------------------------------------------------------------------------

export type RetrospectivePayload = {
  /** Just enough to head the page; null on a route that doesn't send it. */
  run: { label: string; courseTitle: string } | null;
  materials: MaterialRetroRow[];
  /**
   * The run outgrew `RETRO_PROGRESS_LIMIT` and the aggregation saw a prefix of
   * its progress rows. Surfaced, never swallowed: an average over part of a
   * cohort presented as the whole thing is the one failure this view must not
   * hide.
   */
  truncated: boolean;
};

function normalizeNote(raw: unknown): RetroFacilitatorNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const note = str(r.note);
  if (!note) return null;
  return { byName: str(r.byName), note, at: isoOrNull(r.at) };
}

function normalizeMaterial(raw: unknown): MaterialRetroRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const itemId = str(r.itemId);
  if (!itemId) return null;

  const ratingCount = count(r.ratingCount);
  const average =
    typeof r.avgRating === "number" && Number.isFinite(r.avgRating) ? r.avgRating : null;

  return {
    itemId,
    weekNumber: count(r.weekNumber),
    title: str(r.title),
    // THE ANONYMITY FLOOR, re-applied at the boundary. `aggregateRetrospective`
    // already withholds it server-side; doing it again here means no component
    // downstream can render a small-cohort average even by mistake, and the two
    // copies read the same exported constant so they cannot drift apart.
    avgRating: ratingCount >= RETRO_ANONYMITY_FLOOR ? average : null,
    ratingCount,
    completedCount: count(r.completedCount),
    enrolledCount: count(r.enrolledCount),
    facilitatorNotes: firstArray(r.facilitatorNotes)
      .map(normalizeNote)
      .filter((n): n is RetroFacilitatorNote => n !== null),
  };
}

function normalizeRetrospective(body: unknown): RetrospectivePayload {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // The pinned contract fixes the ROW shape, not the envelope key, and the
  // route is written in parallel with this file — accept the plausible
  // spellings (and a bare array) so a naming difference is not a blank page.
  const materials = firstArray(root.materials, root.items, root.rows, body)
    .map(normalizeMaterial)
    .filter((m): m is MaterialRetroRow => m !== null);
  // Curriculum order. The aggregation already emits it; re-stated here because
  // the view renders week sections off this order and must not depend on a
  // second implementation of it.
  materials.sort((a, b) => a.weekNumber - b.weekNumber || a.title.localeCompare(b.title));

  const runRaw = root.run;
  const run =
    runRaw && typeof runRaw === "object"
      ? {
          label: str((runRaw as Record<string, unknown>).label),
          courseTitle: str((runRaw as Record<string, unknown>).courseTitle),
        }
      : null;

  return { run, materials, truncated: root.truncated === true };
}

export type AddNoteInput = { itemId: string; weekNumber: number; note: string };
export type AddNoteResult = { ok: true } | { ok: false; error: string };

export type UseRetrospective = {
  data: RetrospectivePayload | null;
  /** True until the first payload for THIS runId has landed. */
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Post one facilitator note. Returns a result rather than throwing: the
   * composer sits inline beside the material it belongs to, and a refusal has
   * to land there rather than as a page-level toast.
   */
  addNote: (input: AddNoteInput) => Promise<AddNoteResult>;
};

/** One run's per-material evidence, plus the note composer's write path. */
export function useRetrospective(runId: string): UseRetrospective {
  const [store, setStore] = useState<{
    key: string;
    data: RetrospectivePayload | null;
    error: Error | null;
  }>({ key: "", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState("");

  const idle = !runId;
  const stamp = `${runId}#${nonce}`;

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/retrospective`)
      .then(async (res) => {
        const body = await readBody<Record<string, unknown>>(res);
        if (!res.ok) {
          throw new Error(body?.error ?? `Couldn't load the retrospective (${res.status}).`);
        }
        return normalizeRetrospective(body);
      })
      .then((data) => {
        if (!cancelled) setStore({ key: runId, data, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStore((prev) => ({
          key: runId,
          data: prev.key === runId ? prev.data : null,
          error: asError(e),
        }));
      })
      .finally(() => {
        if (!cancelled) setSettled(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, stamp]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const addNote = useCallback(
    async (input: AddNoteInput): Promise<AddNoteResult> => {
      const note = input.note.trim().slice(0, MATERIAL_NOTE_LIMITS.note);
      if (!note) return { ok: false, error: "Write the note first." };
      try {
        const res = await fetch(
          `/api/courses/runs/${encodeURIComponent(runId)}/material-notes`,
          {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              itemId: input.itemId,
              // Sent for the route's benefit; it re-derives the real week from
              // the run's own week docs and ignores this (see the collection's
              // module comment), so nothing here depends on it being right.
              weekNumber: input.weekNumber,
              note,
            }),
          },
        );
        const body = await readBody<Record<string, never>>(res);
        if (!res.ok || !body?.ok) {
          return { ok: false, error: body?.error ?? `That note didn't save (${res.status}).` };
        }
        // Refetch rather than append locally: the stored note carries a
        // server-resolved name and timestamp this client would have to invent,
        // and an invented one that disagrees with the next load is worse than a
        // beat of latency.
        reload();
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: messageFrom(e) };
      }
    },
    [runId, reload],
  );

  const fresh = store.key === runId;
  return {
    data: fresh ? store.data : null,
    loading: !idle && !fresh,
    refreshing: !idle && settled !== stamp,
    error: fresh ? store.error : null,
    reload,
    addNote,
  };
}

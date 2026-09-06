import { slugId } from "./slugId";
import type { CourseWeekDoc } from "./courses";
import type { CourseMaterialNoteDoc } from "./courseMaterialNotes";

/**
 * `courseTemplates/{templateId}` + `courseTemplates/{templateId}/weeks/{wNN}`
 * — FROZEN CURRICULUM SNAPSHOTS (v2 decision 2), and the retrospective
 * evidence a snapshot carries with it (decision 3).
 *
 * ## Append-only. There is no update path for template weeks.
 *
 * Saving a finished cohort CREATES a new snapshot; it never overwrites the
 * one it was derived from. `courseTemplateId()` mints a fresh id on every
 * save (slug + random suffix), so two saves labelled "Autumn 2026 final" are
 * two rows, not one row written twice. The template DOC accepts a label edit
 * and a delete, both admin-only and both through routes; the WEEKS
 * subcollection accepts nothing at all — no route writes it after the
 * snapshot batch, and `firestore.rules` denies every client write to both
 * (pinned by `scripts/rules-tests/tests/course-templates.test.mjs`).
 *
 * That immutability is the whole value of the collection. A template is what
 * a cohort was ACTUALLY taught; a template you can edit afterwards is just a
 * second, worse copy of the run.
 *
 * ## Ids are preserved, always. This is the platform invariant.
 *
 * A snapshot copies week doc ids ("w01".."w60") verbatim, and every
 * `material.id` / `exercise.id` / `checklist.id` inside them. So does
 * applying a template back into a run. Member progress is keyed on those ids
 * — `courseProgress/{runId}__{uid}__{itemId}` and
 * `courseExerciseResponses/{runId}__{uid}__{weekId}__{exerciseId}` — so a copy
 * that re-minted ids would silently orphan every check-off and submission the
 * moment the same material was taught again. `templateWeekFields()` below is
 * the one function both directions of the copy go through, and NOTHING in
 * this module generates an id except `courseTemplateId`, which names the
 * snapshot itself. (`tests/course-templates.test.mjs` asserts the round trip.)
 *
 * The same property is why the copy is a plain field carry-over rather than a
 * re-author: see `clone-weeks/route.ts`, whose id-preserving copy this
 * mirrors deliberately.
 *
 * ## Retrospective lives here too, on purpose
 *
 * `aggregateRetrospective()` powers BOTH
 * `GET /api/courses/runs/[runId]/retrospective` (the read view) and the
 * `retrospective` summary stamped onto a snapshot at save time. One module
 * owning both is what stops the number on the snapshot card disagreeing with
 * the table an admin read the minute before they pressed save — and, more
 * importantly, keeps the anonymity floor in ONE place.
 *
 * This module is deliberately isomorphic (no `server-only`, no
 * `firebase-admin`): the admin client imports the types and the normaliser,
 * the routes do their own Firestore reads and hand the rows in.
 */

export const COURSE_TEMPLATES_COLLECTION = "courseTemplates";

/**
 * Field budgets for snapshot metadata. The routes are the security boundary
 * (clients cannot write this collection at all), so these are a cost ceiling
 * plus the client counter.
 */
export const TEMPLATE_LIMITS = {
  label: 80,
  /** Mirrors COURSE_FIELD_LIMITS.maxWeekPlanEntries — a run cannot exceed it. */
  maxWeeks: 60,
} as const;

// ---------------------------------------------------------------------------
// The snapshot document
// ---------------------------------------------------------------------------

/**
 * The evidence a snapshot carries: what the cohort behind it looked like.
 * Deliberately three scalars and no per-member anything — a template row is
 * shown in a picker, and the detail lives in the run's retrospective view.
 */
export type TemplateRetrospective = {
  /** The source run's human label, e.g. "Autumn 2026". */
  runLabel: string;
  /** Active enrolments on the source run when the snapshot was taken. */
  memberCount: number;
  /** How many materials carried at least one rating. */
  ratedMaterialCount: number;
};

export type CourseTemplateDoc = {
  /** Firestore doc id: `courseTemplateId(courseTitle, label)`. */
  id: string;
  courseId: string;
  /** Denormalised so the nested picker renders without a second read. */
  courseTitle: string;
  /** Admin-given version label, e.g. "Autumn 2026 final". */
  label: string;
  sourceRunId: string;
  /**
   * Which copy of the curriculum was snapshotted. `null` = the RUN CANONICAL
   * weeks, which is the only thing that exists today.
   *
   * Reserved for V2-3, where each group gets its own copy of the content and
   * an admin saving a snapshot picks which diverged copy to freeze. The field
   * is in the stored shape from day one so a V2-3 snapshot and a V2-2 one are
   * the same document type — adding it later would mean every existing row
   * reading `undefined` where the picker expects a decision. The save route
   * refuses a non-null value until that lands, rather than storing `null`
   * over a caller who asked for a group.
   */
  sourceGroupId: string | null;
  savedAt: Date | null;
  savedByUid: string;
  /** Display name, never an email — see the PII note on the routes. */
  savedByName: string;
  weekCount: number;
  /** Null when the source run had no cohort and no ratings to speak of. */
  retrospective: TemplateRetrospective | null;
};

/**
 * Wire shape for `GET /api/courses/[courseId]/templates` — the document with
 * `savedAt` as ISO 8601, because JSON has no Timestamp and the client
 * re-zones nothing. No field is dropped: nothing in a snapshot is PII.
 */
export type CourseTemplateRow = Omit<CourseTemplateDoc, "savedAt"> & {
  savedAt: string | null;
};

/**
 * Mint a snapshot id: `slugId(courseTitle + ' ' + label)`.
 *
 * The random suffix is what makes the collection APPEND-ONLY in practice —
 * saving twice under the same label yields two ids, so a save can never
 * clobber the snapshot it was derived from even if the admin reuses the
 * wording. (Deliberately unlike `courseRuns`, where the label IS the
 * identity: a run is a thing that happens once, a template version is a
 * frozen copy and there can be many.)
 */
export function courseTemplateId(courseTitle: string, label: string): string {
  return slugId(`${courseTitle} ${label}`);
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function asRetrospective(v: unknown): TemplateRetrospective | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Raw;
  return {
    runLabel: str(raw.runLabel),
    memberCount: count(raw.memberCount),
    ratedMaterialCount: count(raw.ratedMaterialCount),
  };
}

export function normalizeCourseTemplate(id: string, data: Raw): CourseTemplateDoc {
  const sourceGroupId = data.sourceGroupId;
  return {
    id,
    courseId: str(data.courseId),
    courseTitle: str(data.courseTitle),
    label: str(data.label).slice(0, TEMPLATE_LIMITS.label),
    sourceRunId: str(data.sourceRunId),
    // Absent and null both mean "run canonical" — see the field comment.
    sourceGroupId:
      typeof sourceGroupId === "string" && sourceGroupId ? sourceGroupId : null,
    savedAt: tsToDate(data.savedAt),
    savedByUid: str(data.savedByUid),
    savedByName: str(data.savedByName),
    weekCount: count(data.weekCount),
    retrospective: asRetrospective(data.retrospective),
  };
}

export function toTemplateRow(doc: CourseTemplateDoc): CourseTemplateRow {
  const { savedAt, ...rest } = doc;
  return { ...rest, savedAt: savedAt ? savedAt.toISOString() : null };
}

/** Newest first — a picker's default reading order for versions. */
export function templateRowOrder(a: CourseTemplateRow, b: CourseTemplateRow): number {
  // Rows with no savedAt sort last rather than first: an undated snapshot is
  // a legacy/hand-made row, not the freshest thing an admin should reach for.
  if (a.savedAt && b.savedAt) return b.savedAt.localeCompare(a.savedAt);
  if (a.savedAt) return -1;
  if (b.savedAt) return 1;
  return a.label.localeCompare(b.label);
}

// ---------------------------------------------------------------------------
// The id-preserving week copy
// ---------------------------------------------------------------------------

/**
 * The stored content of ONE week, in the EXACT `CourseWeekDoc` shape, ready
 * to `set()` under the SAME doc id it came from.
 *
 * Both directions of the copy go through here — run → template (the
 * snapshot) and template → run (apply-template) — which is what makes the id
 * invariant checkable in one place instead of two. Every id inside the week
 * (`material.id`, `exercise.id`, `checklist.id`) rides along untouched
 * because the arrays are carried over wholesale from a `normalizeCourseWeek`
 * result; the caller supplies the DOC id from `snap.id`, never from
 * `weekDocId(...)`, so a run whose week numbering differs from its doc ids
 * cannot have its ids rewritten by a copy. See the module comment for why an
 * id-minting copy would orphan member work.
 *
 * `id`, `updatedAt` and `updatedByUid` are deliberately NOT returned: the doc
 * id is the caller's to place, and the audit stamp belongs to whoever is
 * doing the writing (the snapshot batch stamps `savedAt` on the parent; the
 * apply batch stamps `updatedAt`/`updatedByUid` per week, exactly as the week
 * editor and clone-weeks do).
 */
export function templateWeekFields(week: CourseWeekDoc): Record<string, unknown> {
  return {
    weekNumber: week.weekNumber,
    title: week.title,
    summary: week.summary,
    guideBlocks: week.guideBlocks,
    materials: week.materials,
    exercises: week.exercises,
    checklist: week.checklist,
    estimatedMinutes: week.estimatedMinutes,
    // Carried verbatim, the clone-weeks convention: a snapshot is a faithful
    // copy of authored state, and publication is scoped to whatever run the
    // content ends up in.
    published: week.published,
  };
}

// ---------------------------------------------------------------------------
// Retrospective aggregation
// ---------------------------------------------------------------------------

/**
 * SMALL-COHORT SUPPRESSION FLOOR. Below this many ratings on a material, the
 * average is withheld (`avgRating: null`) and only the count is shown.
 *
 * WHAT THIS BUYS, EXACTLY. It defeats a SINGLE READ of the table: "average
 * 1.0 from 1 rating" names a person to anyone who knows who did the reading
 * that week, and the audience for this view is precisely the facilitators and
 * track leads who do know. Two ratings are barely better — an average of 1.5
 * tells a reader both scores. Three is the conventional floor for aggregate
 * release and is the smallest number where one glance stops being invertible.
 *
 * WHAT IT DOES NOT BUY, and this is not a gap to be closed by raising the
 * number: it does not survive DIFFERENCING ACROSS READS. A reader who saw
 * "4.0 from 3 ratings" and reloads to find "4.25 from 4" has recovered the
 * newcomer's rating exactly (4 x 4.25 − 3 x 4.0 = 5), and no floor prevents
 * that, because the leak is in the pair of observations rather than in either
 * one of them. Closing it would take per-reader noise or a frozen release
 * schedule — machinery out of proportion to a staff-tier view of a cohort of
 * twelve, read by the people who run it.
 *
 * So the floor is a SUPPRESSION RULE, not an anonymity guarantee, and the
 * copy on the surfaces that render these rows must say "shown only in
 * aggregate" rather than promise anonymity (see RetrospectiveView). The
 * differencing limitation is accepted, on the record, and named here so the
 * next reader does not mistake this constant for a stronger property than it
 * has.
 *
 * The COUNT is never suppressed: "2 ratings, no average yet" identifies
 * nobody on its own and is the honest reason the average is missing. And no
 * row anywhere in this module carries a uid — the only names in a
 * retrospective belong to facilitators writing notes in their staff capacity.
 */
export const RETRO_ANONYMITY_FLOOR = 3;

/**
 * Cap on the progress rows one retrospective read will pull. ONE query per
 * run, grouped in memory — no per-material query, no per-member query.
 *
 * Sized for a real cohort (12 weeks x ~10 items x ~40 members ≈ 4 800 rows).
 * Past it the payload reports `truncated: true` rather than quietly averaging
 * a prefix: a cohort that outgrows this needs a precomputed rollup, and the
 * honest failure is the thing that tells us so.
 */
export const RETRO_PROGRESS_LIMIT = 5000;

/** Cap on facilitator notes pulled for one run. Bounded by staff headcount. */
export const RETRO_NOTES_LIMIT = 500;

export type RetroFacilitatorNote = {
  byName: string;
  note: string;
  /** ISO 8601, or null on a row with no timestamp. */
  at: string | null;
};

/**
 * One material's evidence, across the whole run.
 *
 * NOTE WHAT IS ABSENT: no uid, no email, no per-member anything. Ratings and
 * completions arrive here already reduced to counts, and the only names are
 * the facilitators'. Keep it that way — this row is rendered to every track
 * lead and drafter on the platform.
 */
export type MaterialRetroRow = {
  itemId: string;
  weekNumber: number;
  title: string;
  /** Withheld (null) below RETRO_ANONYMITY_FLOOR ratings. */
  avgRating: number | null;
  ratingCount: number;
  completedCount: number;
  /** Denominator: active enrolments on the run. Same on every row. */
  enrolledCount: number;
  facilitatorNotes: RetroFacilitatorNote[];
};

/**
 * The slice of a `courseProgress` row the aggregation needs. Routes fetch it
 * with a field mask (`select`) rather than whole documents — nothing else on
 * a progress row belongs anywhere near this view, `privateNote` least of all.
 */
export type RetroProgressRow = {
  itemId: string;
  rating?: number | null;
  completed?: boolean;
};

function isRating(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 5;
}

/**
 * Fold a run's progress rows and facilitator notes into one row per MATERIAL.
 *
 * Rows are built from the run's CURRENT week definitions, never from the
 * progress rows themselves (v2 decision 6: "denominators always computed from
 * the current week definition"). Two consequences, both wanted:
 *
 *  - a material deleted from the curriculum disappears from the retrospective
 *    even though its progress rows survive — orphans are tolerated, not
 *    resurrected;
 *  - a material nobody has touched still appears, with zeroes, which is
 *    itself the finding an author is looking for.
 *
 * Checklist items are excluded deliberately: they are the member's own
 * to-do projection (they mirror into My Work), not curriculum whose quality
 * is under review. `courseProgress` stores both kinds in one collection, so
 * keying on the week's `materials` array is what separates them.
 */
export function aggregateRetrospective(input: {
  weeks: CourseWeekDoc[];
  progress: RetroProgressRow[];
  notes: CourseMaterialNoteDoc[];
  enrolledCount: number;
}): MaterialRetroRow[] {
  const { weeks, progress, notes, enrolledCount } = input;

  // Curriculum order: week number, then the authored order inside the week.
  // First definition wins if an id somehow appears twice (a hand-edited week,
  // or a copy gone wrong) — one row per material id, always.
  const order: string[] = [];
  const meta = new Map<string, { weekNumber: number; title: string }>();
  for (const week of [...weeks].sort(
    (a, b) => a.weekNumber - b.weekNumber || a.id.localeCompare(b.id),
  )) {
    for (const material of week.materials) {
      if (meta.has(material.id)) continue;
      meta.set(material.id, { weekNumber: week.weekNumber, title: material.title });
      order.push(material.id);
    }
  }

  const ratingSum = new Map<string, number>();
  const ratingCount = new Map<string, number>();
  const completedCount = new Map<string, number>();
  for (const row of progress) {
    if (!meta.has(row.itemId)) continue;
    if (isRating(row.rating)) {
      ratingSum.set(row.itemId, (ratingSum.get(row.itemId) ?? 0) + row.rating);
      ratingCount.set(row.itemId, (ratingCount.get(row.itemId) ?? 0) + 1);
    }
    if (row.completed === true) {
      completedCount.set(row.itemId, (completedCount.get(row.itemId) ?? 0) + 1);
    }
  }

  const notesByItem = new Map<string, RetroFacilitatorNote[]>();
  for (const note of notes) {
    if (!meta.has(note.itemId) || !note.note) continue;
    const list = notesByItem.get(note.itemId) ?? [];
    list.push({
      byName: note.byName || "NAISI facilitator",
      note: note.note,
      at: note.at ? note.at.toISOString() : null,
    });
    notesByItem.set(note.itemId, list);
  }
  // Oldest first — a material's notes read as a thread across terms.
  for (const list of notesByItem.values()) {
    list.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  }

  return order.map((itemId) => {
    const info = meta.get(itemId) as { weekNumber: number; title: string };
    const ratings = ratingCount.get(itemId) ?? 0;
    return {
      itemId,
      weekNumber: info.weekNumber,
      title: info.title,
      avgRating:
        ratings >= RETRO_ANONYMITY_FLOOR
          ? // Two decimals: enough to rank materials, not enough to invite
            // reading significance into a cohort of twelve.
            Math.round(((ratingSum.get(itemId) ?? 0) / ratings) * 100) / 100
          : null,
      ratingCount: ratings,
      completedCount: completedCount.get(itemId) ?? 0,
      enrolledCount,
      facilitatorNotes: notesByItem.get(itemId) ?? [],
    };
  });
}

/**
 * The three scalars a snapshot freezes alongside its weeks. Computed from the
 * SAME rows the read view renders, so a template card and the retrospective
 * table can never tell two stories about one cohort.
 *
 * Returns null when there is nothing to attest — no members and no ratings —
 * because a snapshot of a curriculum that was never delivered carries no
 * evidence, and a row of zeroes reads as evidence of failure rather than
 * absence of data.
 */
export function summarizeRetrospective(
  rows: MaterialRetroRow[],
  runLabel: string,
  memberCount: number,
): TemplateRetrospective | null {
  const ratedMaterialCount = rows.filter((r) => r.ratingCount > 0).length;
  if (memberCount <= 0 && ratedMaterialCount === 0) return null;
  return { runLabel, memberCount, ratedMaterialCount };
}

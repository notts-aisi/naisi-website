/**
 * `courseMaterialNotes/{runId}__{itemId}__{uid}` — one facilitator's note on
 * one piece of curriculum material, for one run: "how did this land".
 *
 * The FACILITATOR half of the retrospective loop (v2 decision 3). The other
 * half — ratings and completion — is aggregated anonymously out of
 * `courseProgress`; this collection is deliberately the ONLY place in the
 * retrospective where a name appears, and the name belongs to a member of
 * staff writing in their staff capacity, never to a learner.
 *
 * ALL WRITES GO THROUGH `POST /api/courses/runs/[runId]/material-notes`
 * (`allow write: if false` in rules), for three reasons rules cannot express:
 *
 *  - **Authority is a query.** "A facilitator of any group in this run" is
 *    resolved by reading the run's groups; a rule could only do it with a
 *    per-row `get()` in a write path that would also have to guess which
 *    group.
 *  - **`weekNumber` is SERVER-DERIVED.** The route finds the week doc whose
 *    `materials` actually contain `itemId` and stores that week's number,
 *    ignoring the client's. A client-chosen number would let a note be filed
 *    against a week the material is not in, where the retrospective (which
 *    builds its rows from the CURRENT week definitions) would never show it —
 *    a note silently lost is worse than a note refused.
 *  - **`byName` must be resolved, not asserted.** It is read off the author's
 *    user doc, so a note can never carry a name its author picked.
 *
 * Reads are staff-tier (admin / approveCourse / draftCourse / the run's track
 * leads), matching the retrospective route exactly — see firestore.rules.
 *
 * Note bodies are plain `string`, capped, rendered as text nodes only. Same
 * XSS boundary as every other human-authored field in the courses feature:
 * never `Block[]`.
 */

export const COURSE_MATERIAL_NOTES_COLLECTION = "courseMaterialNotes";

/**
 * Length budget for a note body. The route is the security boundary; this
 * powers the client counter and is mirrored in firestore.rules only as far as
 * "no client writes at all".
 */
export const MATERIAL_NOTE_LIMITS = {
  note: 1000,
} as const;

export type CourseMaterialNoteDoc = {
  /** Firestore doc id: `courseMaterialNoteId(runId, itemId, uid)`. */
  id: string;
  runId: string;
  /** The `Material.id` this note is about. Materials only — not checklist. */
  itemId: string;
  /**
   * The week the material was found in, resolved SERVER-SIDE from the run's
   * week docs (see the module comment). Display only — the retrospective keys
   * everything on `itemId`.
   */
  weekNumber: number;
  /** The facilitator who wrote it. */
  uid: string;
  /** Display name, resolved from the user doc. NEVER an email address. */
  byName: string;
  /** Plain text, capped at MATERIAL_NOTE_LIMITS.note. */
  note: string;
  at: Date | null;
};

/**
 * Deterministic doc id — one note per (run, material, facilitator). That is
 * what makes "edit my note" an upsert of a known path rather than a query,
 * and what makes a facilitator structurally unable to address anyone else's
 * note.
 *
 * CONSTRUCT-ONLY — NEVER PARSE, the `courseProgress` / `courseExerciseResponses`
 * convention: every part is stored as a field, and splitting on `__` is
 * ambiguous because `slugId`-minted run ids already contain `__`.
 */
export function courseMaterialNoteId(
  runId: string,
  itemId: string,
  uid: string,
): string {
  return `${runId}__${itemId}__${uid}`;
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

export function normalizeCourseMaterialNote(
  id: string,
  data: Raw,
): CourseMaterialNoteDoc {
  return {
    id,
    runId: str(data.runId),
    itemId: str(data.itemId),
    weekNumber:
      typeof data.weekNumber === "number" && Number.isFinite(data.weekNumber)
        ? Math.floor(data.weekNumber)
        : 0,
    uid: str(data.uid),
    byName: str(data.byName),
    // Capped on the way OUT as well as in: a row written before a cap change
    // must not be able to blow up a retrospective payload.
    note: str(data.note).slice(0, MATERIAL_NOTE_LIMITS.note),
    at: tsToDate(data.at),
  };
}

export type MaterialNoteWriteInput = {
  runId: string;
  itemId: string;
  /** Server-derived (see the module comment), not the client's claim. */
  weekNumber: number;
  uid: string;
  byName: string;
  note: string;
  /** Pass the Admin SDK's `serverTimestamp()` sentinel (or a Date). */
  at?: unknown;
};

/**
 * Build the stored payload. The ONE place a note body is trimmed and capped,
 * so the route and any future caller cannot disagree about what "1000
 * characters" means.
 *
 * Returns the note trimmed to empty when the input is blank — the route reads
 * that as "clear my note" and deletes the row rather than storing an empty
 * one, so an empty note never reaches Firestore.
 */
export function buildMaterialNoteWrite(
  input: MaterialNoteWriteInput,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    runId: input.runId,
    itemId: input.itemId,
    weekNumber: Math.floor(input.weekNumber),
    uid: input.uid,
    byName: input.byName,
    note: (input.note ?? "").trim().slice(0, MATERIAL_NOTE_LIMITS.note),
  };
  if (input.at !== undefined) doc.at = input.at;
  return doc;
}

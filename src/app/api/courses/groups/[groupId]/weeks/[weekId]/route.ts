import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { groupWeekRef } from "@/lib/courses/groupResolve";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  normalizeCourseGroup,
  normalizeGroupWeek,
} from "@/lib/firestore/courseGroups";
import {
  COURSE_FIELD_LIMITS,
  normalizeCourseRun,
  sanitizeChecklist,
  sanitizeExercises,
  sanitizeMaterials,
  validateSubmissionUrl,
  type ChecklistItem,
  type Exercise,
  type Material,
} from "@/lib/firestore/courses";
import { sanitizeBlocks } from "@/lib/firestore/newsletterBlocks";

/**
 * EDIT ONE FORKED WEEK — the facilitator editing surface of v2 decisions 4-6.
 *
 * PATCHes `courseGroups/{groupId}/weeks/{weekId}`, and ONLY that: this route
 * never touches the run canonical, and it REFUSES (409, `needsFork: true`)
 * while the fork does not exist. Forking is the sibling POST's job — two
 * explicit steps, no auto-fork-on-save, so a facilitator splits their group
 * off the canonical curriculum knowingly or not at all.
 *
 * ── THE FACILITATOR TRUST BOUNDARY (decision 5), SERVER-ENFORCED ────────────
 * Facilitators may edit TEXT-SAFE fields including links: `materials`,
 * `exercises`, `checklist`, `summary`, `estimatedMinutes`, `published`.
 * `guideBlocks` — the `dangerouslySetInnerHTML` surface — is NEVER accepted
 * from a facilitator: a request carrying the key is REFUSED outright (403),
 * not silently stripped, because a probe at a trust boundary deserves an
 * answer the sender can see. Admins and the run's track leads edit forks
 * through this same route WITH `guideBlocks` — the handler branches on role,
 * so the boundary holds against a crafted request whatever the UI offers.
 * `title` and `weekNumber` are accepted from nobody here: the week's name and
 * number stay canonical-shaped so the rail, the mirror ids and the register
 * columns keep addressing one week doctrine (`weekDocId(n)`).
 *
 * Member-facing strings stay PLAIN TEXT rendered as text nodes; every URL a
 * facilitator can store passes `validateSubmissionUrl` — the same machinery
 * the exercise submit route trusts, embedded-credential check included.
 *
 * ── DELETE WARNINGS (decision 6): COUNTED IN THE WRITE TRANSACTION ──────────
 * For every material / exercise / checklist id the patch REMOVES, the route
 * counts the live `courseProgress` / `courseExerciseResponses` rows that
 * reference it, and REFUSES (409, `needsAcknowledge: true`, the per-item
 * counts attached) unless the request carries `acknowledgeOrphans: true` — so
 * the UI shows real numbers ("3 members already answered this") and the
 * facilitator deletes with the cost in view. Orphaned rows are then
 * TOLERATED, per the locked decision: denominators are always recomputed from
 * the group's current week definition.
 *
 * The counts run as `tx.get(aggregate)` INSIDE the same transaction as the
 * week write — the apply-template precedent (V2-2), for the same reason:
 * `courseProgress` is a DIRECT CLIENT WRITE (an enrolled member ticking a box
 * needs no route), so a count taken before the transaction is a
 * time-of-check/time-of-use hole with a member on the other side. Inside it,
 * a racing check-off either serialises before (and is counted) or after (and
 * references whatever the fork then holds). Bounded work: the arrays cap at
 * 30+15+15 ids, so at most 60 aggregations, and only for ids actually removed.
 *
 * SCOPE OF THE NUMBERS, honestly: the counts are RUN-WIDE, because item ids
 * are shared with the canonical week (the id-preserving invariant) and
 * progress rows carry no groupId. For a multi-group run the figure is an
 * upper bound on THIS group's orphans — it can only over-warn, never
 * under-warn — and it is exact when the run has one group. A per-group count
 * would cost a roster×items document fan-out inside the transaction for a
 * number that changes no decision an honest facilitator makes.
 *
 * ── WHO MAY EDIT ────────────────────────────────────────────────────────────
 * A facilitator of THIS group while it is LIVE, ∪ the parent run's track
 * leads (live group, trusted tier), ∪ admins (trusted tier, archived
 * included). AUTHORIZATION BEFORE EXISTENCE: missing, archived and
 * someone-else's group collapse onto ONE indistinguishable 403.
 *
 * All writes to group weeks are server-routed (`allow write: if false` in
 * rules) — this route and the fork POST are the only two doors.
 */

const LIMITS = COURSE_FIELD_LIMITS;

/** Same one-path-segment guard as the sibling group routes. */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

const WEEK_ID = /^w[0-9][0-9]$/;

/** The closed set of keys a PATCH body may carry. Anything else is a 400. */
const ALLOWED_KEYS = new Set([
  "summary",
  "estimatedMinutes",
  "published",
  "materials",
  "exercises",
  "checklist",
  "guideBlocks",
  "acknowledgeOrphans",
]);

/**
 * Refusals travel out of the transaction as a typed sentinel and are mapped
 * back in the catch — the ApplyRefusedError shape from apply-template: a
 * refusal is a decision, not a failure, and its sentence (and its counts)
 * have to reach the facilitator intact.
 */
class PatchRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PatchRefusedError";
  }
}

/** Per-removed-item receipt: the live rows that reference it, by lane. */
type OrphanCount = { itemId: string; progress: number; responses: number };

function fieldError(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Refuse duplicate ids — removal detection and progress keys both key on them. */
function hasDuplicateIds(items: ReadonlyArray<{ id: string }>): boolean {
  return new Set(items.map((i) => i.id)).size !== items.length;
}

/**
 * Validate one sanitized material against the field budgets and the URL
 * rules. Returns an error sentence, or null. `sanitizeMaterials` has already
 * enforced the STRUCTURE (and YouTube-parseability for videos); this layer is
 * the length caps and `validateSubmissionUrl`, which the client-direct
 * canonical path leaves to rules and this server-routed path must own itself.
 */
function materialError(m: Material): string | null {
  if (!m.id) return "A material is missing its id.";
  if (m.title.length > LIMITS.materialTitle) {
    return `Material titles must be ${LIMITS.materialTitle} characters or fewer.`;
  }
  if (m.type === "note") {
    if (m.body.length > LIMITS.materialNoteBody) {
      return `Material notes must be ${LIMITS.materialNoteBody} characters or fewer.`;
    }
    return null;
  }
  const urlError = validateSubmissionUrl(m.url, LIMITS.materialUrl);
  if (urlError) return `"${m.title || m.id}": ${urlError}`;
  if (m.type === "reading" && (m.author ?? "").length > LIMITS.materialAuthor) {
    return `Material authors must be ${LIMITS.materialAuthor} characters or fewer.`;
  }
  if (m.type === "link" && (m.description ?? "").length > LIMITS.materialDescription) {
    return `Link descriptions must be ${LIMITS.materialDescription} characters or fewer.`;
  }
  return null;
}

function exerciseError(x: Exercise): string | null {
  if (!x.id) return "An exercise is missing its id.";
  if (x.prompt.length > LIMITS.exercisePrompt) {
    return `Exercise prompts must be ${LIMITS.exercisePrompt} characters or fewer.`;
  }
  if ((x.helpText ?? "").length > LIMITS.exerciseHelpText) {
    return `Exercise help text must be ${LIMITS.exerciseHelpText} characters or fewer.`;
  }
  return null;
}

function checklistError(c: ChecklistItem): string | null {
  if (!c.id) return "A checklist item is missing its id.";
  if (c.title.length > LIMITS.checklistTitle) {
    return `Checklist titles must be ${LIMITS.checklistTitle} characters or fewer.`;
  }
  if ((c.detail ?? "").length > LIMITS.checklistDetail) {
    return `Checklist details must be ${LIMITS.checklistDetail} characters or fewer.`;
  }
  return null;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ groupId: string; weekId: string }> },
) {
  const { groupId, weekId } = await ctx.params;
  if (!isAddressableId(groupId) || !WEEK_ID.test(weekId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE — and before the body is parsed, so an
  // unauthorized caller learns neither whether the group exists nor what a
  // valid payload looks like. The parent run is read only when a live group
  // exists, because that is where the track-lead lane is named.
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  let isLead = false;
  if (group && !group.archived && group.runId) {
    const runSnap = await db.collection("courseRuns").doc(group.runId).get();
    const run = runSnap.exists
      ? normalizeCourseRun(runSnap.id, runSnap.data() ?? {})
      : null;
    isLead = Boolean(run && run.trackLeadUids.includes(actor.uid));
  }
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !isLead && !facilitatesLiveGroup) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  if (!group.runId) {
    return NextResponse.json(
      { error: "Group is not attached to a run" },
      { status: 400 },
    );
  }

  // The trusted tier may author rich guide blocks; facilitators may not.
  const trusted = isAdmin || isLead;

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fieldError("Expected a JSON object body.");
    }
    body = raw as Record<string, unknown>;
  } catch {
    return fieldError("Expected a JSON object body.");
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      return fieldError(`Unknown field "${key}".`);
    }
  }

  // THE TRUST BOUNDARY, before any validation of the field's content: a
  // facilitator sending `guideBlocks` at all is refused, loudly (see header).
  if ("guideBlocks" in body && !trusted) {
    return NextResponse.json(
      { error: "Guide content is authored by admins and track leads." },
      { status: 403 },
    );
  }

  const acknowledgeOrphans = body.acknowledgeOrphans === true;

  // ---- Validate every provided field OUTSIDE the transaction. -------------
  // The patch is built once; the transaction below only re-reads and writes.
  const patch: Record<string, unknown> = {};
  const incoming: {
    materials?: Material[];
    exercises?: Exercise[];
    checklist?: ChecklistItem[];
  } = {};

  if ("summary" in body) {
    if (typeof body.summary !== "string") return fieldError("summary must be text.");
    if (body.summary.length > LIMITS.weekSummary) {
      return fieldError(
        `The summary must be ${LIMITS.weekSummary} characters or fewer.`,
      );
    }
    patch.summary = body.summary;
  }

  if ("estimatedMinutes" in body) {
    const v = body.estimatedMinutes;
    if (v === null) {
      patch.estimatedMinutes = null;
    } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      patch.estimatedMinutes = Math.round(v);
    } else {
      return fieldError("estimatedMinutes must be a positive number or null.");
    }
  }

  if ("published" in body) {
    if (typeof body.published !== "boolean") {
      return fieldError("published must be true or false.");
    }
    patch.published = body.published;
  }

  if ("materials" in body) {
    if (!Array.isArray(body.materials)) return fieldError("materials must be a list.");
    if (body.materials.length > LIMITS.maxMaterials) {
      return fieldError(`A week holds at most ${LIMITS.maxMaterials} materials.`);
    }
    const materials = sanitizeMaterials(body.materials);
    // The sanitizer FILTERS malformed entries rather than erroring; a payload
    // that shrank in the wash is a payload this route did not understand, and
    // silently storing the survivors would delete the rest without a warning.
    if (materials.length !== body.materials.length) {
      return fieldError("One or more materials are malformed.");
    }
    if (hasDuplicateIds(materials)) return fieldError("Duplicate material ids.");
    for (const m of materials) {
      const err = materialError(m);
      if (err) return fieldError(err);
    }
    incoming.materials = materials;
    patch.materials = materials;
  }

  if ("exercises" in body) {
    if (!Array.isArray(body.exercises)) return fieldError("exercises must be a list.");
    if (body.exercises.length > LIMITS.maxExercises) {
      return fieldError(`A week holds at most ${LIMITS.maxExercises} exercises.`);
    }
    const exercises = sanitizeExercises(body.exercises);
    if (exercises.length !== body.exercises.length) {
      return fieldError("One or more exercises are malformed.");
    }
    if (hasDuplicateIds(exercises)) return fieldError("Duplicate exercise ids.");
    for (const x of exercises) {
      const err = exerciseError(x);
      if (err) return fieldError(err);
    }
    incoming.exercises = exercises;
    patch.exercises = exercises;
  }

  if ("checklist" in body) {
    if (!Array.isArray(body.checklist)) return fieldError("checklist must be a list.");
    if (body.checklist.length > LIMITS.maxChecklistItems) {
      return fieldError(
        `A week holds at most ${LIMITS.maxChecklistItems} checklist items.`,
      );
    }
    const checklist = sanitizeChecklist(body.checklist);
    if (checklist.length !== body.checklist.length) {
      return fieldError("One or more checklist items are malformed.");
    }
    if (hasDuplicateIds(checklist)) return fieldError("Duplicate checklist ids.");
    for (const c of checklist) {
      const err = checklistError(c);
      if (err) return fieldError(err);
    }
    incoming.checklist = checklist;
    patch.checklist = checklist;
  }

  if ("guideBlocks" in body) {
    // Trusted tier only — refused above for facilitators. Same sanitizer the
    // canonical authoring surfaces trust.
    if (!Array.isArray(body.guideBlocks)) {
      return fieldError("guideBlocks must be a list.");
    }
    if (body.guideBlocks.length > LIMITS.maxGuideBlocks) {
      return fieldError(`A week holds at most ${LIMITS.maxGuideBlocks} guide blocks.`);
    }
    patch.guideBlocks = sanitizeBlocks(body.guideBlocks);
  }

  if (Object.keys(patch).length === 0) {
    return fieldError("Nothing to update.");
  }

  const runId = group.runId;
  const forkRef = groupWeekRef(db, groupId, weekId);

  let removed: OrphanCount[] = [];
  try {
    removed = await db.runTransaction(async (tx) => {
      // ---- READS. Every one of them, before the first write. --------------
      const forkSnap = await tx.get(forkRef);
      if (!forkSnap.exists) {
        // The copy-on-write gate: editing an unforked week is refused, and
        // the client offers the explicit Fork step instead (see header).
        throw new PatchRefusedError(
          "This week still tracks the run's canonical content. Fork it for your group first.",
          409,
          { needsFork: true },
        );
      }
      const current = normalizeGroupWeek(forkSnap.id, forkSnap.data() ?? {});

      // Ids the patch REMOVES, per lane. Only lanes the body provided can
      // remove anything — an omitted array is left exactly as it stands.
      const removedProgressIds: string[] = [];
      const removedExerciseIds: string[] = [];
      if (incoming.materials) {
        const keep = new Set(incoming.materials.map((m) => m.id));
        for (const m of current.materials) {
          if (!keep.has(m.id)) removedProgressIds.push(m.id);
        }
      }
      if (incoming.checklist) {
        const keep = new Set(incoming.checklist.map((c) => c.id));
        for (const c of current.checklist) {
          if (!keep.has(c.id)) removedProgressIds.push(c.id);
        }
      }
      if (incoming.exercises) {
        const keep = new Set(incoming.exercises.map((x) => x.id));
        for (const x of current.exercises) {
          if (!keep.has(x.id)) removedExerciseIds.push(x.id);
        }
      }

      // THE DELETE-WARNING COUNTS, live, inside the transaction (see header
      // for why: the V2-2 apply-template precedent — `courseProgress` is a
      // client-direct write, so counting outside the transaction is a TOCTOU
      // hole). Aggregations, not document reads: a yes/no with a number
      // attached, and `tx.get(aggregate)` locks what the query matches.
      const counts: OrphanCount[] = [];
      for (const itemId of removedProgressIds) {
        const agg = await tx.get(
          db
            .collection("courseProgress")
            .where("runId", "==", runId)
            .where("itemId", "==", itemId)
            .count(),
        );
        counts.push({ itemId, progress: agg.data().count, responses: 0 });
      }
      for (const exerciseId of removedExerciseIds) {
        const agg = await tx.get(
          db
            .collection("courseExerciseResponses")
            .where("runId", "==", runId)
            .where("weekId", "==", weekId)
            .where("exerciseId", "==", exerciseId)
            .count(),
        );
        counts.push({ itemId: exerciseId, progress: 0, responses: agg.data().count });
      }

      const orphaning = counts.filter((c) => c.progress > 0 || c.responses > 0);
      if (orphaning.length > 0 && !acknowledgeOrphans) {
        const total = orphaning.reduce((n, c) => n + c.progress + c.responses, 0);
        throw new PatchRefusedError(
          `Members have already recorded work on ${orphaning.length === 1 ? "an item" : `${orphaning.length} items`} this change removes (${total} row${total === 1 ? "" : "s"}). Confirm to remove anyway — their work stays stored but drops off the week.`,
          409,
          { needsAcknowledge: true, orphans: orphaning },
        );
      }

      // ---- WRITES. Nothing above this line may follow one. ----------------
      tx.update(forkRef, {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
      });
      return counts;
    });
  } catch (err) {
    if (err instanceof PatchRefusedError) {
      return NextResponse.json(
        { error: err.message, ...err.detail },
        { status: err.status },
      );
    }
    console.error("[courses group week patch] transaction failed", groupId, weekId, err);
    return NextResponse.json(
      { error: "That save didn't go through — nothing was changed." },
      { status: 500 },
    );
  }

  // The receipt: what was saved, and — when removals were acknowledged — the
  // same counts the warning showed, so the client can render "removed, 3
  // answers kept on record" without re-deriving anything.
  return NextResponse.json({
    ok: true,
    weekId,
    updated: Object.keys(patch),
    removed,
  });
}

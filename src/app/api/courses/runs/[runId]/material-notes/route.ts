import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";
import { COURSE_FIELD_LIMITS, normalizeCourseWeek } from "@/lib/firestore/courses";
import {
  COURSE_MATERIAL_NOTES_COLLECTION,
  MATERIAL_NOTE_LIMITS,
  buildMaterialNoteWrite,
  courseMaterialNoteId,
} from "@/lib/firestore/courseMaterialNotes";

/**
 * "How did this land" — one facilitator's note on one piece of material, for
 * one run. The FACILITATOR half of the retrospective loop (v2 decision 3);
 * the anonymous ratings half comes out of `courseProgress`.
 *
 * WHO MAY WRITE: admins ∪ this run's track leads ∪ its `runFacilitatorUids`
 * ∪ anyone facilitating ANY GROUP in the run. The last clause is why this is
 * a route and not a rule: "facilitator of some group in this run" is a query
 * over `courseGroups`, and Firestore rules cannot run one.
 *
 * Refusals are a single indistinguishable 403 — a caller who is none of the
 * above learns nothing about whether the run exists.
 *
 * ## Two things the client does not get to decide
 *
 *  - **`weekNumber` is server-derived.** The route locates the week doc whose
 *    `materials` actually contain `itemId` and stores THAT week's number. A
 *    client-chosen number could file a note against a week the material is
 *    not in, where the retrospective — which builds its rows from the current
 *    week definitions — would never render it. A note silently lost is worse
 *    than a note refused, so an unknown `itemId` is a 400.
 *  - **`byName` is resolved from the author's user doc**, never taken from
 *    the body, and it is a DISPLAY NAME: the retrospective is the one place a
 *    name appears, and it must be a name, never an address.
 *
 * Materials only. Checklist items are the member's own to-do projection (they
 * mirror into My Work), not curriculum whose quality is under review — the
 * retrospective has no row for one, so a note on one would be unreachable.
 *
 * An empty note CLEARS the row rather than storing an empty string: the doc
 * id is `(run, item, author)`, so "delete my note" is the natural meaning of
 * saving a blank one, and an empty note in the collection would render as a
 * ghost line in every future retrospective.
 */

/** Cost ceiling on the group-facilitator lookup. A run has tens of groups. */
const MAX_GROUPS_SCANNED = 50;

/**
 * Display-name fallback chain: what the member asked to be called, then their
 * account name, then a neutral placeholder — NEVER an email address.
 * (Duplicated per the repo's route convention; see the applications route.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI facilitator"
  );
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { itemId?: unknown; weekNumber?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
  if (!itemId) {
    return NextResponse.json({ error: "Which material?" }, { status: 400 });
  }
  // Accepted and validated for shape, then DISCARDED — the stored value comes
  // from the week the material is actually in (see the module comment).
  const claimedWeek = body.weekNumber;
  if (
    typeof claimedWeek !== "number" ||
    !Number.isInteger(claimedWeek) ||
    claimedWeek < 1 ||
    claimedWeek > COURSE_FIELD_LIMITS.maxWeekPlanEntries
  ) {
    return NextResponse.json({ error: "Invalid week number" }, { status: 400 });
  }
  if (typeof body.note !== "string") {
    return NextResponse.json({ error: "Invalid note" }, { status: 400 });
  }
  const note = body.note.trim();
  if (note.length > MATERIAL_NOTE_LIMITS.note) {
    return NextResponse.json(
      { error: `Notes are limited to ${MATERIAL_NOTE_LIMITS.note} characters.` },
      { status: 400 },
    );
  }

  // ---- Authority -----------------------------------------------------------
  // The run and its groups in one round trip. `runId` alone on courseGroups is
  // served by the automatic single-field index; the alternative — pairing it
  // with an `array-contains` on facilitatorUids — would need a composite index
  // to answer a question a ≤50-doc field-masked scan answers for free.
  const [runSnap, groupSnap] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    db
      .collection("courseGroups")
      .where("runId", "==", runId)
      .select("facilitatorUids")
      .limit(MAX_GROUPS_SCANNED)
      .get(),
  ]);

  const runRaw = runSnap.exists ? (runSnap.data() ?? {}) : {};
  const isGroupFacilitator = groupSnap.docs.some((d) =>
    asUidList((d.data() ?? {}).facilitatorUids).includes(actor.uid),
  );
  const allowed =
    runSnap.exists &&
    (actor.role === "admin" ||
      asUidList(runRaw.trackLeadUids).includes(actor.uid) ||
      asUidList(runRaw.runFacilitatorUids).includes(actor.uid) ||
      isGroupFacilitator);
  if (!allowed) {
    // ONE refusal, whether the run is missing or the caller has no standing.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (runRaw.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and can't be edited." },
      { status: 409 },
    );
  }

  // ---- Resolve the material to a real week --------------------------------
  // A run holds at most 60 week docs and a note is a human-paced action, so
  // one collection read is the cheap way to make the stored `weekNumber` a
  // fact rather than a claim. Materials live inside the week doc, so there is
  // nothing a field mask could save here.
  const weekSnap = await db
    .collection("courseRuns")
    .doc(runId)
    .collection("weeks")
    .get();
  let weekNumber = 0;
  let found = false;
  for (const d of weekSnap.docs) {
    const week = normalizeCourseWeek(d.id, d.data() ?? {});
    if (week.materials.some((m) => m.id === itemId)) {
      weekNumber = week.weekNumber;
      found = true;
      break;
    }
  }
  if (!found) {
    return NextResponse.json(
      { error: "That material isn't in this run's curriculum." },
      { status: 400 },
    );
  }

  const ref = db
    .collection(COURSE_MATERIAL_NOTES_COLLECTION)
    .doc(courseMaterialNoteId(runId, itemId, actor.uid));

  // Blank clears. See the module comment.
  if (!note) {
    await ref.delete();
    return NextResponse.json({ ok: true, cleared: true });
  }

  const actorSnap = await db.collection("users").doc(actor.uid).get();
  await ref.set(
    buildMaterialNoteWrite({
      runId,
      itemId,
      weekNumber,
      uid: actor.uid,
      byName: displayNameOf(actorSnap.data() ?? {}),
      note,
      at: FieldValue.serverTimestamp(),
    }),
  );

  return NextResponse.json({ ok: true, cleared: false, weekNumber });
}

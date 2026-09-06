import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { groupWeekRef, runWeekRef } from "@/lib/courses/groupResolve";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseWeek } from "@/lib/firestore/courses";
import { templateWeekFields } from "@/lib/firestore/courseTemplates";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * FORK ONE WEEK into this group — the copy-on-write moment of v2 decision 4.
 *
 * Copies the run's canonical week into `courseGroups/{groupId}/weeks/{wNN}`
 * IF ABSENT. From then on this group's members read the fork (through
 * `groupResolve.ts`) and admin refinements to the canonical week no longer
 * reach them. Nothing ever merges back.
 *
 * ── TWO EXPLICIT STEPS, NEVER AUTO-FORK-ON-SAVE ─────────────────────────────
 * This route only COPIES. Edits go through the sibling PATCH, which REFUSES
 * while the fork is absent — so a facilitator forks knowingly, with the UI
 * spelling out what forking means, and can never split their group off the
 * canonical curriculum as a side effect of pressing Save.
 *
 * ── THE COPY IS ID-PRESERVING. THE PLATFORM INVARIANT. ──────────────────────
 * The week's doc id and every `material.id` / `exercise.id` / `checklist.id`
 * ride across verbatim through `templateWeekFields()` — the ONE function both
 * directions of the template copy already go through (the V2-2 precedent, see
 * `courseTemplates.ts`). Member progress is keyed on those ids
 * (`courseProgress/{runId}__{uid}__{itemId}`,
 * `courseExerciseResponses/{runId}__{uid}__{weekId}__{exerciseId}`), so a
 * fork that re-minted ids would orphan every check-off and answer the moment
 * a group personalised a week. Nothing in this file may generate an id.
 *
 * ── IDEMPOTENT VIA `create()` ───────────────────────────────────────────────
 * Two facilitators pressing Fork together race on a `create()`, and the loser
 * gets ALREADY_EXISTS — reported as `ok: true, alreadyForked: true`, because
 * the state they asked for is the state that holds. No transaction needed:
 * `create()` is the atomicity (the sync-tasks precedent).
 *
 * ── WHO MAY FORK ────────────────────────────────────────────────────────────
 * A facilitator of THIS group while it is LIVE, ∪ admins — the group email
 * route's gate, down to the ordering: AUTHORIZATION BEFORE EXISTENCE, so a
 * missing group, an archived group and someone else's group collapse onto ONE
 * indistinguishable 403. Run facilitators, track leads and admissions
 * reviewers get nothing here: forking is an act of running THIS room. (Track
 * leads edit forks through the PATCH — editing content is their lane;
 * splitting a group off canonical is the facilitator's or an admin's call.)
 *
 * ── PROVENANCE ──────────────────────────────────────────────────────────────
 * `forkedAt` / `forkedByUid` stamp the split; `forkedFromRunWeekAt` records
 * the canonical week's `updatedAt` AT COPY TIME (null when it carried none),
 * so "has canonical moved on since this group forked" stays answerable.
 */

/** Same one-path-segment guard as the sibling group routes. */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/** Week doc ids are "w01".."w60" — anything else addresses nothing. */
const WEEK_ID = /^w[0-9][0-9]$/;

/** ALREADY_EXISTS out of `.create()` — the sync-tasks idiom, verbatim. */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ groupId: string; weekId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId, weekId } = await ctx.params;
  if (!isAddressableId(groupId) || !WEEK_ID.test(weekId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE (the group email route's ordering): the
  // group doc carries the facilitator list, so it is read either way, and an
  // unauthorized caller learns nothing about whether their guess named a group.
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
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

  const canonicalSnap = await runWeekRef(db, group.runId, weekId).get();
  if (!canonicalSnap.exists) {
    return NextResponse.json(
      { error: "That week has no canonical content to fork yet." },
      { status: 404 },
    );
  }
  const canonicalRaw = canonicalSnap.data() ?? {};
  const canonical = normalizeCourseWeek(canonicalSnap.id, canonicalRaw);

  try {
    // The SNAPSHOT's doc id, the snapshot's item ids — `templateWeekFields`
    // carries the arrays over wholesale from a `normalizeCourseWeek` result
    // and returns no id of its own (see its V2-2 contract).
    await groupWeekRef(db, groupId, weekId).create({
      ...templateWeekFields(canonical),
      forkedAt: FieldValue.serverTimestamp(),
      forkedByUid: actor.uid,
      // Point-in-time copy of the canonical's audit stamp — raw Timestamp or
      // null, never a re-derived "now": this field answers "what did we copy",
      // not "when did we copy it" (forkedAt already does).
      forkedFromRunWeekAt:
        canonicalRaw.updatedAt instanceof Timestamp ? canonicalRaw.updatedAt : null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      // The state the caller asked for already holds — including when another
      // facilitator won the race a moment ago. Never an overwrite: whatever
      // edits the existing fork carries are left exactly as they stand.
      return NextResponse.json({ ok: true, weekId, alreadyForked: true });
    }
    console.error("[courses group fork] create failed", groupId, weekId, err);
    return NextResponse.json(
      { error: "That fork didn't go through — nothing was changed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, weekId, alreadyForked: false });
}

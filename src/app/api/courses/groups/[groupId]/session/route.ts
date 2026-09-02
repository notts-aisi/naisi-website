import { NextResponse } from "next/server";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  GROUP_SESSION_MODES,
  normalizeCourseGroup,
  type GroupSessionMode,
} from "@/lib/firestore/courseGroups";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * SET HOW ONE WEEK MEETS — the virtual/in-person switch of v2 decision 7,
 * per (group, week), binary, facilitator-set.
 *
 * PATCH `{ weekId, mode }` writes the group doc's server-owned `sessionModes`
 * map (`{ w03: "virtual" }`), which `normalizeCourseGroup` folds into
 * `sessionOverrides[weekId].mode` for every reader — "virtual" shows the
 * meeting link and suppresses the location, "in-person" the reverse, absent
 * shows both (the legacy state). `mode: null` CLEARS the entry rather than
 * storing a value, because "never set" and "explicitly in person" are
 * different states and `sessionModeForWeek` reports the difference.
 *
 * ── WHY A ROUTE AND NOT THE CLIENT-DIRECT SESSION EDIT ──────────────────────
 * The mode is pinned in rules like `memberCount` (the non-admin client lanes
 * cannot move `sessionModes`), so the flip always comes through here — where
 * the client pairs it with the room-notice composer's prefilled "we're online
 * tonight" message. A silent client-direct flip would change what the week
 * page shows without anything prompting the humans to be told; the gap
 * between "the site is correct" and "the group knows" is where people travel
 * to an empty room.
 *
 * ── WHO MAY FLIP ────────────────────────────────────────────────────────────
 * The pace route's twin, verbatim: a facilitator of THIS group while it is
 * LIVE, ∪ admins. AUTHORIZATION BEFORE EXISTENCE — missing, archived and
 * someone-else's group collapse onto ONE indistinguishable 403. Same closed
 * body ("unknown field is a 400").
 */

/** Same one-path-segment guard as the sibling group routes. */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

const WEEK_ID = /^w[0-9][0-9]$/;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE, before the body is parsed (the group
  // email route's ordering, shared by the whole sibling set).
  const groupRef = db.collection("courseGroups").doc(groupId);
  const groupSnap = await groupRef.get();
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

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  }
  for (const key of Object.keys(body)) {
    if (key !== "weekId" && key !== "mode") {
      return NextResponse.json({ error: `Unknown field "${key}".` }, { status: 400 });
    }
  }

  const weekId = typeof body.weekId === "string" ? body.weekId : "";
  if (!WEEK_ID.test(weekId)) {
    return NextResponse.json(
      { error: "weekId must be a week id like \"w03\"." },
      { status: 400 },
    );
  }

  let mode: GroupSessionMode | null;
  if (body.mode === null) {
    mode = null;
  } else if (GROUP_SESSION_MODES.includes(body.mode as GroupSessionMode)) {
    mode = body.mode as GroupSessionMode;
  } else {
    return NextResponse.json(
      { error: 'mode must be "in-person", "virtual", or null to clear.' },
      { status: 400 },
    );
  }

  // ONE map entry moves — `FieldPath` segments rather than a dotted string,
  // the house convention for map keys, and `delete()` on clear so an unset
  // week stays ABSENT (never a stored null the normaliser would ignore).
  try {
    await groupRef.update(
      new FieldPath("sessionModes", weekId),
      mode ?? FieldValue.delete(),
      new FieldPath("updatedAt"),
      FieldValue.serverTimestamp(),
    );
  } catch (err) {
    console.error("[courses group session] update failed", groupId, weekId, err);
    return NextResponse.json(
      { error: "That change didn't go through — nothing was changed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, weekId, mode });
}

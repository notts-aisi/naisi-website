import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";

/**
 * Per-event collaborators: committee members the author or an admin grants
 * edit access to one specific event (see EventDoc.collaboratorUids).
 *
 * GET  - returns the pickable committee/admin members plus the current list.
 *        The author may be a non-SU committee member who cannot read the
 *        `users` collection directly, so this route resolves names for them.
 * POST - replaces collaboratorUids with a validated list.
 *
 * Both are gated to the event's author and admins. The Admin SDK is used so
 * the picker keeps working on a published event (client writes are blocked).
 */

const MAX_COLLABORATORS = 20;

type Candidate = { uid: string; displayName: string; role: string };

function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/** Committee + admin members, the only people eligible to be collaborators. */
async function loadCandidates(
  db: Firestore,
  excludeUid: string,
): Promise<Candidate[]> {
  const snap = await db
    .collection("users")
    .where("role", "in", ["committee", "admin"])
    .get();
  return snap.docs
    .filter((d) => d.id !== excludeUid)
    .map((d) => {
      const data = d.data() ?? {};
      return {
        uid: d.id,
        displayName: displayNameOf(data),
        role: typeof data.role === "string" ? data.role : "committee",
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const snap = await db.collection("events").doc(id).get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const event = snap.data() ?? {};

  if (!(actor.role === "admin" || event.authorUid === actor.uid)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const candidates = await loadCandidates(db, event.authorUid ?? "");
  return NextResponse.json({
    candidates,
    collaboratorUids: asUidList(event.collaboratorUids),
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { collaboratorUids?: unknown };
  try {
    body = (await req.json()) as { collaboratorUids?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ref = db.collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const event = snap.data() ?? {};

  if (!(actor.role === "admin" || event.authorUid === actor.uid)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only committee/admin members may be collaborators. Intersect the requested
  // list with the eligible set so a stale or forged uid can never be written.
  const requested = asUidList(body.collaboratorUids);
  const eligible = new Set((await loadCandidates(db, event.authorUid ?? "")).map((c) => c.uid));
  const cleaned = requested
    .filter((uid) => eligible.has(uid))
    .slice(0, MAX_COLLABORATORS);

  await ref.update({
    collaboratorUids: cleaned,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, collaboratorUids: cleaned });
}

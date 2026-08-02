import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Live email-verification status for a set of collaborator uids, read straight
 * from Firebase Auth (the source of truth) so the admin Collaborators list can
 * never show a stale value — `emailVerified` is Auth-owned and is deliberately
 * NOT mirrored onto the collaborators doc. Admin-only.
 *
 * Cost note: this is a Firebase Auth call (getUsers), NOT a Firestore read — it
 * consumes zero Firestore read quota. getUsers caps at 100 identifiers/call, so
 * we chunk; once the admin list is paginated it only needs the visible page.
 */
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { uids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const uids = Array.isArray(body.uids)
    ? body.uids.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];

  const auth = getAdminAuth();
  if (!auth) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const verified: Record<string, boolean> = {};
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100).map((uid) => ({ uid }));
    if (chunk.length === 0) continue;
    const res = await auth.getUsers(chunk);
    for (const u of res.users) verified[u.uid] = Boolean(u.emailVerified);
  }

  return NextResponse.json({ verified });
}

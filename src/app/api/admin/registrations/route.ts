import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { uidsWithProfile } from "@/lib/firestore/registrationProfiles";
import { REGISTRATIONS_COLLECTION, toRegistrationView } from "@/lib/firestore/registrations";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Paginated, admin-only list of signup/registration rows for the admin tracker.
 *
 * Read through a server route (Admin SDK) rather than a client onSnapshot —
 * registration rows hold email PII and this collection accumulates benign
 * orphans without bound, so it's exactly the read-cost hotspot to keep off the
 * client. Always limited (≤100/page) with cursor pagination, so opening the tab
 * never scans the whole collection.
 *
 * EVERY ROW IS CHECKED AGAINST THE PROFILE IT CLAIMS. A row's own flags are a
 * mirror the browser updates, and its stored `status` word predates the rule
 * that only a profile completes a registration, so neither is shown as it
 * stands: the page's uids are looked up in `users` and `collaborators`, and
 * the status each row carries out of here is derived from that answer. One
 * batched read per page, on a screen one admin opens.
 *
 * There is no status filter here, and that is deliberate. A filter would have
 * to select on the stored word, which is the one field on the row that can be
 * wrong; the screen filters the rows it has loaded, by the status derived
 * above, and the summary route carries the whole-collection counts.
 *
 * Query params:
 *   cursor = doc id of the last row of the previous page (optional)
 *   limit  = page size, 1..100                            (default 25)
 */
export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const coll = db.collection(REGISTRATIONS_COLLECTION);
  // Newest first, on the automatic single-field createdAt index. Every creator
  // writes createdAt, so no row is dropped by the ordering.
  let query = coll.orderBy("createdAt", "desc");

  // Cursor = the previous page's last doc id; re-fetch it to startAfter the
  // snapshot (robust to createdAt ties, unlike a bare value cursor).
  if (cursor) {
    const cursorSnap = await coll.doc(cursor).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  // Over-fetch by one to detect whether another page exists.
  const snap = await query.limit(pageSize + 1).get();
  const pageDocs = snap.docs.slice(0, pageSize);
  const profiled = await uidsWithProfile(
    db,
    pageDocs.map((d) => d.id),
  );
  const rows = pageDocs.map((d) =>
    toRegistrationView(d.id, d.data(), { hasProfile: profiled.has(d.id) }),
  );
  const nextCursor =
    snap.docs.length > pageSize && pageDocs.length > 0
      ? pageDocs[pageDocs.length - 1].id
      : null;

  return NextResponse.json({ rows, nextCursor });
}

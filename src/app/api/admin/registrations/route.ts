import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ORPHAN_STATUSES,
  REGISTRATIONS_COLLECTION,
  REGISTRATION_STATUSES,
  toRegistrationView,
  type RegistrationStatus,
} from "@/lib/firestore/registrations";

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
 * Query params:
 *   filter = "all" | "orphans" | <RegistrationStatus>   (default "all")
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
  const filter = url.searchParams.get("filter") ?? "all";
  const cursor = url.searchParams.get("cursor");
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const coll = db.collection(REGISTRATIONS_COLLECTION);
  // All variants order by createdAt desc. The status / orphan filters need the
  // composite index {status ASC, createdAt DESC} (firestore.indexes.json); "all"
  // uses the automatic single-field createdAt index.
  let query =
    filter === "orphans"
      ? coll.where("status", "in", ORPHAN_STATUSES)
      : REGISTRATION_STATUSES.includes(filter as RegistrationStatus)
        ? coll.where("status", "==", filter)
        : coll;
  query = query.orderBy("createdAt", "desc");

  // Cursor = the previous page's last doc id; re-fetch it to startAfter the
  // snapshot (robust to createdAt ties, unlike a bare value cursor).
  if (cursor) {
    const cursorSnap = await coll.doc(cursor).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  // Over-fetch by one to detect whether another page exists.
  const snap = await query.limit(pageSize + 1).get();
  const pageDocs = snap.docs.slice(0, pageSize);
  const rows = pageDocs.map((d) => toRegistrationView(d.id, d.data()));
  const nextCursor =
    snap.docs.length > pageSize && pageDocs.length > 0
      ? pageDocs[pageDocs.length - 1].id
      : null;

  return NextResponse.json({ rows, nextCursor });
}

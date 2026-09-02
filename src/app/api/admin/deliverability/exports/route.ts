import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  DATA_EXPORTS_COLLECTION,
  dataExportKindLabel,
  isDataExportKind,
  normalizeDataExport,
} from "@/lib/firestore/dataExports";

/**
 * Admin-only: list the most recent `dataExports` rows for the Exports tab on
 * the deliverability dashboard.
 *
 * A ROUTE, not a client query, and that is the whole design. `dataExports` is
 * `allow read, write: if false` in firestore.rules: the actor of a logged
 * export is usually an admin, so an admin-readable and admin-writable log is
 * a log its own subject can rewrite. The Admin SDK reads it here instead,
 * exactly as the sibling `sends` route already reads the server-only
 * `emailSends` collection.
 *
 * A GET that writes nothing, which matters for this collection in particular:
 * the export routes that WRITE rows are POSTs precisely so a prefetch or a
 * retry cannot fill the log with phantom entries. Reading is the safe verb
 * and stays one.
 */

type SerialisedExport = {
  id: string;
  kind: string;
  /** Server-rendered so the client bundle never imports the Admin SDK. */
  kindLabel: string;
  kindKnown: boolean;
  actorUid: string;
  actorName: string;
  scope: Record<string, string>;
  rowCount: number;
  filename: string;
  at: string | null;
  viaImpersonation: boolean;
};

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
  const parsed = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
  // `kind` is validated against the known set rather than passed through: an
  // unknown value would return an empty list that reads as "no exports", and
  // the composite index this query rides on is (kind ASC, at DESC).
  const kind = url.searchParams.get("kind");
  const filterKind = isDataExportKind(kind) ? kind : null;

  let query = db.collection(DATA_EXPORTS_COLLECTION).orderBy("at", "desc").limit(limit);
  if (filterKind) {
    query = db
      .collection(DATA_EXPORTS_COLLECTION)
      .where("kind", "==", filterKind)
      .orderBy("at", "desc")
      .limit(limit);
  }

  const snap = await query.get();
  const items: SerialisedExport[] = snap.docs.map((d) => {
    const row = normalizeDataExport(d.id, d.data());
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: dataExportKindLabel(row.kind),
      kindKnown: row.kindKnown,
      actorUid: row.actorUid,
      actorName: row.actorName,
      scope: { ...row.scope },
      rowCount: row.rowCount,
      filename: row.filename,
      at: row.at ? row.at.toISOString() : null,
      viaImpersonation: row.viaImpersonation,
    };
  });

  return NextResponse.json({ items });
}

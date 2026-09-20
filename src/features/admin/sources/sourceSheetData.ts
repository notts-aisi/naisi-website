"use client";

import { collection, doc, getDoc, getDocs, orderBy, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeSourceSheet, type SourceSheetDoc } from "@/lib/firestore/sourceSheets";

/**
 * The admin editor's reads. Client-direct, under an admin-only rule, the way
 * the Projects tab reads `projects`: no API route stands between the editor
 * and the collection, because `firestore.rules` already says admins and
 * nobody else, in both directions.
 *
 * Both reads live in this one module on purpose. Every client-SDK read in
 * `src` owes an entry in `scripts/rules-tests/tests/client-queries.registry.mjs`
 * keyed by (file, path, clauses), and keeping the pair together keeps the
 * registry to one entry per SHAPE rather than one per call site.
 */

/**
 * Every entry, drafts included, newest edit first.
 *
 * Ordered by `updatedAt` rather than `publishedAt`. `publishedAt` is SPARSE
 * here by design (its absence is what "draft" means, and unpublishing deletes
 * it), and Firestore drops every document missing the ordered field: an
 * `orderBy("publishedAt")` on this list would silently hide every draft, which
 * is most of what the page exists to show. `updatedAt` is written on create
 * and on every save, so it is never absent.
 */
export async function listSourceSheets(): Promise<SourceSheetDoc[]> {
  const db = getClientDb();
  const q = query(collection(db, "sourceSheets"), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeSourceSheet(d.id, d.data()));
}

/**
 * One entry by slug, or null when the slug names nothing.
 *
 * Used twice: the editor loads the entry it is about to edit, and the create
 * form checks a proposed slug is free before writing. The second is why this
 * returns null rather than throwing: "no document here" is the good answer on
 * the create path.
 */
export async function loadSourceSheet(slug: string): Promise<SourceSheetDoc | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, "sourceSheets", slug));
  if (!snap.exists()) return null;
  return normalizeSourceSheet(snap.id, snap.data());
}

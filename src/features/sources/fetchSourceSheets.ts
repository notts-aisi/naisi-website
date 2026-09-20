import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeSourceSheet,
  renderableSourceUrl,
  sourceHostname,
  SOURCE_SLUG_PATTERN,
  type SourceSheetDoc,
} from "@/lib/firestore/sourceSheets";

/**
 * The public read path for `/sources`.
 *
 * `sourceSheets` is admin-only in `firestore.rules`, in BOTH directions, so
 * nothing in a browser reads the collection: the public pages come through
 * here, on the Admin SDK, on the server. That is not the shape `news` uses
 * (`allow read: if true`) and the difference is deliberate. A news slug has to
 * be guessed; a source sheet's slug is PRINTED ON THE POSTER, so a client-side
 * read rule would put an unpublished entry one `getDoc` away from everybody
 * holding one.
 *
 * Everything below PROJECTS. The page gets the fields it renders and nothing
 * else: no `createdByUid`, no storage paths, no counter. That matters more
 * here than on most surfaces because these pages are served to signed-out
 * visitors, and whatever reaches a component reaches the HTML.
 */

export type PublicSourceRow = {
  /** The number printed on the material. Rendered explicitly, never counted. */
  n: number;
  name: string;
  /** Null when the stored link does not pass validation: the row is text. */
  href: string | null;
  /** Host shown beside the name, so a reader sees where a link goes. */
  host: string;
  /** Present only when the admin wrote one. An empty note renders nothing. */
  comment?: string;
};

export type PublicSourceSheet = {
  slug: string;
  title: string;
  context: string;
  summary: string;
  image: { url: string; alt: string } | null;
  file: { url: string; filename: string; sizeBytes: number } | null;
  items: PublicSourceRow[];
  /** ISO string; the pages format it through `formatSiteDate`. */
  publishedAt: string;
};

export type PublicSourceSummary = {
  slug: string;
  title: string;
  context: string;
  summary: string;
  sourceCount: number;
  image: { url: string; alt: string } | null;
  hasFile: boolean;
  publishedAt: string;
};

/**
 * One row, with its link decided HERE rather than in the page.
 *
 * `renderableSourceUrl` is the same validator the editor runs on save, applied
 * a second time at render. A row saved before that validator existed, or typed
 * straight into the Firestore console, degrades to plain text instead of
 * putting an unchecked scheme behind an anchor on a public page.
 */
function projectRow(item: SourceSheetDoc["items"][number]): PublicSourceRow {
  const href = renderableSourceUrl(item.url);
  const row: PublicSourceRow = {
    n: item.n,
    name: item.name,
    href,
    host: href ? sourceHostname(item.url) : "",
  };
  // `comment` is public when it has text and absent when it does not, so the
  // page never has to render an empty node to keep a shape.
  const comment = (item.comment ?? "").trim();
  if (comment) row.comment = comment;
  return row;
}

/**
 * The image's description.
 *
 * Falls back to the entry's title when the admin left the alt field empty.
 * `alt=""` tells a screen reader the picture is decorative and can be skipped,
 * and this one is not: it is the poster the reader has in their hand. The
 * title describes the material, so it is a truthful description rather than an
 * invented one.
 */
function imageAlt(sheet: SourceSheetDoc): string {
  return sheet.image?.alt.trim() || sheet.title;
}

function projectSheet(sheet: SourceSheetDoc): PublicSourceSheet {
  return {
    slug: sheet.slug,
    title: sheet.title,
    context: sheet.context,
    summary: sheet.summary,
    image: sheet.image ? { url: sheet.image.url, alt: imageAlt(sheet) } : null,
    file: sheet.file
      ? {
          url: sheet.file.url,
          filename: sheet.file.filename,
          sizeBytes: sheet.file.sizeBytes,
        }
      : null,
    items: sheet.items.map(projectRow),
    publishedAt: sheet.publishedAt ? sheet.publishedAt.toISOString() : "",
  };
}

/**
 * Every published entry, newest first.
 *
 * The query shape copies `news` exactly: a single field, so it needs no
 * composite index and `firestore.indexes.json` stays untouched. Published-ness
 * IS the presence of `publishedAt`, and unpublishing deletes the field, so a
 * withdrawn entry drops out of this list without a second status to keep in
 * step with it.
 */
export async function listPublishedSourceSheets(): Promise<PublicSourceSummary[]> {
  const db = getAdminDb();
  if (!db) return [];

  const snap = await db
    .collection("sourceSheets")
    .where("publishedAt", "!=", null)
    .orderBy("publishedAt", "desc")
    .limit(100)
    .get();

  return snap.docs.map((d) => {
    const sheet = normalizeSourceSheet(d.id, d.data());
    return {
      slug: sheet.slug,
      title: sheet.title,
      context: sheet.context,
      summary: sheet.summary,
      sourceCount: sheet.items.length,
      image: sheet.image ? { url: sheet.image.url, alt: imageAlt(sheet) } : null,
      hasFile: sheet.file !== null,
      publishedAt: sheet.publishedAt ? sheet.publishedAt.toISOString() : "",
    };
  });
}

/**
 * One entry, or null.
 *
 * Null means the same thing for an unpublished entry and for a slug that names
 * nothing, and the page renders the same words for both. Two reasons, and they
 * point the same way: the reader is standing in front of a poster they just
 * scanned, for whom a 404 is a worse answer than "not published yet"; and
 * telling the two cases apart would be an existence oracle on a collection
 * whose draft titles are not public.
 */
export async function getPublishedSourceSheet(
  slug: string,
): Promise<PublicSourceSheet | null> {
  const db = getAdminDb();
  if (!db) return null;

  // The slug arrives from the URL, and `doc()` takes a PATH: a value carrying
  // a separator would address something else entirely. Checked against the
  // same grammar the editor enforces, before the read rather than after it, so
  // a hand-typed address falls into the not-published-yet page like any other
  // slug that names nothing.
  if (!SOURCE_SLUG_PATTERN.test(slug)) return null;

  const doc = await db.collection("sourceSheets").doc(slug).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!data?.publishedAt) return null;
  return projectSheet(normalizeSourceSheet(doc.id, data));
}

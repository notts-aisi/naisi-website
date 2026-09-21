import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  defaultLinksPage,
  normalizeLinksPage,
  publicLinksPage,
  type LinksPageContent,
} from "@/lib/firestore/linksPage";

/**
 * The public read path for what /links says.
 *
 * `linksPage` is admin-only in `firestore.rules`, so nothing in a browser
 * reads it: the page comes through here, on the Admin SDK, on the server, the
 * way /sources does. What goes back is PROJECTED: the rows and the three
 * application buttons, validated, and nothing else. No `updatedByUid`, no
 * timestamps, no hidden rows. These pages are served to signed-out visitors,
 * and whatever reaches a component reaches the HTML.
 *
 * It cannot fail. /links is where most printed QR codes land, so a missing
 * document, a damaged one, a slow database and no database at all each give
 * the built-in page from `src/content/links.ts`. A deadline, because the page
 * regenerates in the background of a real visit and that visit should never
 * wait on this.
 */
export const LINKS_PAGE_DOC = "linksPage/main";

const READ_DEADLINE_MS = 2500;

export async function fetchLinksPage(): Promise<LinksPageContent> {
  const fallback = publicLinksPage(defaultLinksPage());
  const db = getAdminDb();
  if (!db) return fallback;
  try {
    const snap = await Promise.race([
      db.doc(LINKS_PAGE_DOC).get(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no answer in ${READ_DEADLINE_MS}ms`)), READ_DEADLINE_MS),
      ),
    ]);
    if (!snap.exists) return fallback;
    const stored = normalizeLinksPage(snap.data());
    if (!stored) return fallback;
    const page = publicLinksPage(stored);
    // An edit that hid or broke every row is not a page. Show the built-in one.
    return page.groups.length > 0 ? page : fallback;
  } catch (err) {
    console.error("[links] fetchLinksPage failed, serving the built-in page", err);
    return fallback;
  }
}

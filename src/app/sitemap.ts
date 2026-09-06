import type { MetadataRoute } from "next";
import { listCourseSitemapRows } from "@/features/courses/fetchCourses";
import { baseUrl } from "@/lib/events/rsvpToken";

/**
 * The sitemap, currently the COURSES tree.
 *
 * ## Why courses and not the whole site
 *
 * The programme pages are the only public surface where discovery matters and
 * where the URLs are not otherwise reachable in one hop: a course's week pages
 * are linked from the sample-week section and from each other, which is a
 * chain a crawler has to walk rather than a list it can read. The rest of the
 * public site (home, news, events, resources) is linked from the header and
 * the footer on every page, so it needs no help being found and a hand-listed
 * copy of it here would be a second thing to keep in step with the nav.
 *
 * The two roots are included because a sitemap whose every entry hangs off an
 * unlisted parent is a sitemap missing its own tree.
 *
 * ## What is NOT in here, deliberately
 *
 *  - Unpublished courses and unpublished weeks. `fetchCourses.ts` filters on
 *    both, and this file inherits that obligation: a sitemap is a published
 *    list of URLs, so leaking a draft course's id here would be worse than
 *    leaking it on a page, not better.
 *  - `/apply` and `/applications`. They are personal, they change with a
 *    round's window, and there is nothing for a crawler to index behind them.
 *  - `/admin` and every authed surface, which `robots.ts` does not need to
 *    exclude precisely because nothing links or lists them.
 *
 * Errors are swallowed to an empty list rather than thrown: a sitemap that
 * 500s is a worse outcome than a sitemap that is briefly short, and this runs
 * against the Admin SDK, which is absent in a build with no credentials.
 *
 * ## Its own fetcher
 *
 * `listCourseSitemapRows()` rather than the catalogue's entry builder. That
 * one exists to draw cards: it runs two site-wide run queries, scans every
 * admission round and batches `coursePages` for the artwork, and the sitemap
 * then added one `getPublishedCourse` per course on top of it for the weeks.
 * A crawler wants ids and week numbers, so it asks for ids and week numbers.
 */
/**
 * Rendered PER REQUEST, not at build.
 *
 * Without this Next prerenders `sitemap.xml` as static content, and the build
 * runs with no Admin SDK credentials: `listPublishedCourses()` returns an
 * empty list, the empty result is frozen into the deployment, and the sitemap
 * would then never mention a course again however many are published. A
 * sitemap is fetched by a crawler a few times a day, so the cost of building
 * it live is nothing and the cost of getting it wrong is the whole feature.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = baseUrl();
  const roots: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/courses`, changeFrequency: "weekly", priority: 0.9 },
  ];

  let rows: Awaited<ReturnType<typeof listCourseSitemapRows>> = [];
  try {
    rows = await listCourseSitemapRows();
  } catch {
    return roots;
  }

  const courses: MetadataRoute.Sitemap = [];
  for (const row of rows) {
    const id = row.courseId;
    courses.push({
      url: `${base}/courses/${encodeURIComponent(id)}`,
      lastModified: row.updatedAt ?? undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    });

    // The week pages, filtered on `published` by the fetcher exactly as the
    // pages themselves are, so a week that 404s can never be listed here.
    for (const weekNumber of row.weekNumbers) {
      courses.push({
        url: `${base}/courses/${encodeURIComponent(id)}/weeks/${weekNumber}`,
        changeFrequency: "monthly",
        priority: 0.5,
      });
    }
  }

  return [...roots, ...courses];
}

import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { listPublishedSourceSheets } from "@/features/sources/fetchSourceSheets";
import { formatSiteDate } from "@/lib/datetime/siteTime";
import styles from "./sources.module.css";

export const metadata: Metadata = {
  title: "Sources",
  description:
    "Where the claims on our posters, flyers and posts come from. Each piece of material has its own numbered list of sources, with links.",
};

export const dynamic = "force-dynamic";

/**
 * The index of published material.
 *
 * A Server Component with no client component under it, so nothing about a
 * sheet is serialised into the page beyond what is drawn. The projection in
 * `fetchSourceSheets.ts` already drops everything else, and
 * `tests/public-client-props.test.mjs` keeps this page from growing a client
 * child that takes a whole document.
 */
export default async function SourcesIndex() {
  const sheets = await listPublishedSourceSheets();

  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.intro}>
          <Badge>Where our claims come from</Badge>
          <h1 className={styles.title}>Sources</h1>
          <p className={styles.lede}>
            Our posters, flyers and posts carry small numbers next to the things
            they claim. Each piece of material has a page here listing what
            those numbers refer to, with a link to every source.
          </p>
        </div>

        {sheets.length === 0 ? (
          <Card padding="lg">
            <p className={styles.empty}>
              Nothing is listed here yet. If you have scanned a code on one of
              our posters and landed on this page, the sources for it are on
              their way. The address printed under the code will keep working.
            </p>
          </Card>
        ) : (
          <div className={styles.list}>
            {sheets.map((sheet) => (
              <Link
                key={sheet.slug}
                href={`/sources/${sheet.slug}`}
                className={styles.cardLink}
              >
                <Card padding="lg" interactive>
                  <div className={styles.row}>
                    {sheet.image && (
                      /* Firebase Storage image on a public page. next/image
                         breaks the Turbopack production build in this repo
                         (the default import resolves to an object), so every
                         image on the site is a plain tag. */
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={sheet.image.url}
                        alt={sheet.image.alt}
                        className={styles.thumb}
                      />
                    )}
                    <div className={styles.body}>
                      <div className={styles.meta}>
                        {sheet.publishedAt && (
                          <time dateTime={sheet.publishedAt}>
                            {formatSiteDate(new Date(sheet.publishedAt), {
                              day: "numeric",
                              month: "long",
                              year: "numeric",
                            })}
                          </time>
                        )}
                        <span>
                          {sheet.sourceCount}{" "}
                          {sheet.sourceCount === 1 ? "source" : "sources"}
                        </span>
                        {sheet.hasFile && <span>PDF available</span>}
                      </div>
                      <h2 className={styles.cardTitle}>{sheet.title}</h2>
                      {sheet.context && (
                        <p className={styles.summary}>{sheet.context}</p>
                      )}
                      {sheet.summary && (
                        <p className={styles.summary}>{sheet.summary}</p>
                      )}
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

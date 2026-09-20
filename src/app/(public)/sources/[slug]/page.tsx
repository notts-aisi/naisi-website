import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import Badge from "@/components/ui/Badge";
import { getPublishedSourceSheet } from "@/features/sources/fetchSourceSheets";
import { formatSiteDate } from "@/lib/datetime/siteTime";
import styles from "./sourceSheet.module.css";

type Props = { params: Promise<{ slug: string }> };

/**
 * One read shared by `generateMetadata` and the render, the way the news
 * article page does it. `params` is a Promise in this version of Next and has
 * to be awaited in both.
 */
const loadSheet = cache(async (slug: string) => getPublishedSourceSheet(slug));

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const sheet = await loadSheet(slug);
  if (!sheet) {
    // The same answer an unknown slug gets. `noindex` because the page says
    // nothing worth indexing and the address may be republished later with
    // real content behind it.
    return { title: "Sources", robots: { index: false, follow: true } };
  }

  const description =
    sheet.summary ||
    `The sources behind ${sheet.title}, with a link to each one.`;

  return {
    title: `Sources: ${sheet.title}`,
    description,
    openGraph: {
      title: `Sources: ${sheet.title}`,
      description,
      type: "article",
      publishedTime: sheet.publishedAt || undefined,
      images: sheet.image ? [{ url: sheet.image.url }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: `Sources: ${sheet.title}`,
      description,
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The page a scanned QR code opens.
 *
 * NEVER `notFound()`. An unpublished entry and a slug that names nothing get
 * the same calm page, because the reader is standing in front of the poster
 * that sent them here and a 404 tells them the society printed a broken
 * address. The fetcher makes the two cases indistinguishable so the page
 * cannot accidentally become an existence oracle for drafts.
 *
 * A Server Component with no client child: every prop handed to a client
 * component on a public page ends up in the HTML, and the projection above is
 * what keeps that from mattering here.
 */
export default async function SourceSheetPage({ params }: Props) {
  const { slug } = await params;
  const sheet = await loadSheet(slug);

  if (!sheet) {
    return (
      <article className={styles.article}>
        <div className={`container ${styles.wrap}`}>
          <Badge>Sources</Badge>
          <h1 className={styles.title}>Sources for this aren&apos;t published yet</h1>
          <p className={styles.placeholder}>
            The address you scanned is right, and it will keep working. The
            numbered list of sources for this piece has not gone up yet, so
            there is nothing to read here for the moment. It is worth trying
            again in a day or two.
          </p>
          <div className={styles.placeholderLinks}>
            <Link href="/sources" className={styles.placeholderLink}>
              All published sources
            </Link>
            <Link href="/" className={styles.placeholderLink}>
              NAISI home
            </Link>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={styles.article}>
      <div className={`container ${styles.wrap}`}>
        <Link href="/sources" className={styles.back}>
          ← All sources
        </Link>
        <Badge>Sources</Badge>
        <h1 className={styles.title}>{sheet.title}</h1>

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
          {sheet.context && <span>{sheet.context}</span>}
        </div>

        {sheet.summary && <p className={styles.summary}>{sheet.summary}</p>}

        {sheet.image && (
          <figure className={styles.figure}>
            {/* Plain tag rather than next/image: the optimiser's default import
                resolves to an object under this repo's Turbopack build. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sheet.image.url}
              alt={sheet.image.alt}
              className={styles.image}
            />
          </figure>
        )}

        {sheet.file && (
          /* `download` is inert here: Firebase Storage serves the file from
             another origin and a cross-origin anchor ignores the attribute.
             What actually makes this download rather than open in a tab is the
             `contentDisposition: attachment` the uploader writes into the
             object's own metadata. The attribute is kept because it costs
             nothing and states the intent. */
          <a
            className={styles.download}
            href={sheet.file.url}
            download={sheet.file.filename}
            rel="noreferrer noopener"
          >
            <span aria-hidden="true">⬇</span>
            <span className={styles.downloadText}>
              <span className={styles.downloadName}>{sheet.file.filename}</span>
              <span className={styles.downloadMeta}>
                Download the full material
                {formatBytes(sheet.file.sizeBytes)
                  ? ` · ${formatBytes(sheet.file.sizeBytes)}`
                  : ""}
              </span>
            </span>
          </a>
        )}

        <h2 className={styles.listHeading}>Sources</h2>

        {sheet.items.length === 0 ? (
          <p className={styles.noSources}>
            No sources have been listed for this one yet.
          </p>
        ) : (
          <ol className={styles.list}>
            {sheet.items.map((item) => (
              /* `value` is what makes the marker the number printed on the
                 material. Without it the browser counts 1..N and a deleted row
                 shifts every later citation onto the wrong superscript. */
              <li key={`${item.n}-${item.name}`} value={item.n} className={styles.item}>
                <span className={styles.itemName}>
                  {item.href ? (
                    <a
                      className={styles.itemLink}
                      href={item.href}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {item.name}
                    </a>
                  ) : (
                    item.name
                  )}
                </span>
                {item.host && <span className={styles.itemHost}>{item.host}</span>}
                {item.comment && <p className={styles.itemComment}>{item.comment}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  );
}

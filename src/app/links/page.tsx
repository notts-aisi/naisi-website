import type { Metadata } from "next";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import { LINK_GROUPS, isOffsite } from "@/content/links";
import { listPublishedEvents } from "@/features/events/fetchEvents";
import { formatSiteDate } from "@/lib/datetime/siteTime";
import { publicLocationText } from "@/lib/events/location";
import LinksSignup from "./LinksSignup";
import styles from "./links.module.css";

/*
  /links: every link in one place, and where a printed QR code lands.

  NOT in the (public) route group, on purpose. That group's <main> is rendered
  with an inline opacity of 0 and only becomes visible once JavaScript has
  hydrated (see PublicMain), which is right for the marketing pages and wrong
  for this one: it is opened on a phone, at a stall, on whatever signal a
  sports hall has, and it has to read from the first HTML that arrives. So it
  sits at the top level under the root layout alone and carries its own small
  brand link home. Internal rows are next/link with prefetch off: the anchor
  it renders works before any script arrives, and a page of a dozen links
  should not fetch a dozen routes over a sports hall's signal.

  Static with a ten-minute revalidate, like the home page. The `?q=<slug>` a
  scanned code leaves in the address bar is never read here: the subscribe
  form reads it in the browser at the moment of submitting, so every code
  shares one cached page.
*/

export const revalidate = 600;

export const metadata: Metadata = {
  title: "Links",
  description:
    "Every NAISI link in one place: the mailing list, upcoming events, our courses, Instagram and how to join.",
  openGraph: {
    title: "NAISI: every link in one place",
    description:
      "The mailing list, upcoming events, our courses, Instagram and how to join the Nottingham AI Safety Initiative.",
  },
};

async function upcomingEvents() {
  let events;
  try {
    events = await listPublishedEvents();
  } catch {
    return [];
  }
  // "Upcoming" is relative to when this page was last regenerated, which the
  // revalidate above keeps within ten minutes.
  const now = Date.now();
  return events
    .filter(
      (e) =>
        e.visibility === "public" &&
        !e.archived &&
        e.startAt &&
        e.startAt.getTime() >= now,
    )
    .slice(0, 3);
}

export default async function LinksPage() {
  const upcoming = await upcomingEvents();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" prefetch={false} className={styles.brand} aria-label="NAISI home">
          <BrandMark size={40} />
        </Link>
        <h1 className={styles.title}>Nottingham AI Safety Initiative</h1>
        <p className={styles.lede}>
          The AI safety student community at the University of Nottingham.
        </p>
      </header>

      <LinksSignup>
        {upcoming.length > 0 && (
          <section className={styles.section} aria-labelledby="links-coming-up">
            <h2 id="links-coming-up" className={styles.sectionHeading}>
              Coming up
            </h2>
            <ul className={styles.rows}>
              {upcoming.map((e) => {
                const start = e.startAt!;
                // Through the one module that decides what a location says to
                // a stranger. Never the event's own fields.
                const place = publicLocationText(e) || "Location to be announced";
                return (
                  <li key={e.id}>
                    <Link href={`/events/${e.id}`} prefetch={false} className={styles.row}>
                      <span className={styles.rowLabel}>{e.title}</span>
                      <span className={styles.rowSub}>
                        <time dateTime={start.toISOString()}>
                          {formatSiteDate(start, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        {" · "}
                        {place}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </LinksSignup>

      {LINK_GROUPS.map((group) => (
        <section key={group.heading} className={styles.section}>
          <h2 className={styles.sectionHeading}>{group.heading}</h2>
          <ul className={styles.rows}>
            {group.rows.map((row) => (
              <li key={row.key}>
                {row.soon ? (
                  <div className={styles.row} data-soon="true">
                    <span className={styles.rowLabel}>
                      {row.label}
                      <span className={styles.soon}>Opens soon</span>
                    </span>
                    <span className={styles.rowSub}>{row.sub}</span>
                  </div>
                ) : isOffsite(row.href) ? (
                  <a
                    href={row.href}
                    className={styles.row}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className={styles.rowLabel}>{row.label}</span>
                    <span className={styles.rowSub}>{row.sub}</span>
                  </a>
                ) : (
                  <Link href={row.href} prefetch={false} className={styles.row}>
                    <span className={styles.rowLabel}>{row.label}</span>
                    <span className={styles.rowSub}>{row.sub}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import styles from "./calendar.module.css";

/**
 * What the add-to-calendar page says when its event is not there.
 *
 * This page is where a printed QR code lands, so "not there" does not mean a
 * mistyped address. It means somebody is holding a poster whose event has been
 * deleted or unpublished since it was printed. The site's general "page not
 * found" reads as if they did something wrong and sends them away from the two
 * places that would help, so this says what happened in plain words and offers
 * what is on instead.
 *
 * RENDERED BY THE PAGE, NOT BY `notFound()`, and that is the point of it. For a
 * route that matches and then calls `notFound()`, Next answers 404 with an
 * EMPTY body and draws the not-found screen in the browser once its scripts
 * have arrived (measured on a production build: the body is one hidden div).
 * This page is opened on a phone, at a stall, on whatever signal the hall has.
 * A blank screen until the JavaScript lands is the one thing it cannot be, so
 * the page returns this as ordinary server-rendered HTML, the way /sources
 * answers a slug that is not published. `tests/calendar-event-missing.test.mjs`
 * keeps `notFound()` out of the page.
 *
 * The cost is a 200 where a 404 would be more correct. The page is `noindex`
 * either way, and the reader is a person holding a poster, not a crawler.
 */
export function EventNotListed() {
  return (
    <main className={styles.page}>
      <div className="container">
        <Link href="/" prefetch={false} className={styles.brand} aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
        <div className={styles.sheet}>
          <p className={styles.kicker}>Add to calendar</p>
          <h1 className={styles.title}>This event is no longer listed</h1>
          <p className={styles.note}>
            The code you scanned is for an event that has been taken down or has moved. Nothing is
            wrong with your phone or with the code. Here is what is on.
          </p>
          <div className={styles.actions}>
            <Link
              href="/events"
              prefetch={false}
              className={`${styles.action} ${styles.actionPrimary}`}
            >
              <span className={styles.actionLabel}>See upcoming events</span>
              <span className={styles.actionHint}>Socials, talks and sessions, with dates and places</span>
            </Link>
            <Link href="/links" prefetch={false} className={styles.action}>
              <span className={styles.actionLabel}>Everything else in one place</span>
              <span className={styles.actionHint}>The mailing list, courses, Instagram and how to join</span>
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

import Link from "next/link";
import Reveal from "./Reveal";
import { listPublishedEvents } from "@/features/events/fetchEvents";
import styles from "./UpcomingEvents.module.css";

/*
  UpcomingEvents — server-rendered strip of the next 2-3 published, public
  events. Reuses listPublishedEvents() and filters down. If none, the
  section returns null.
*/
export default async function UpcomingEvents() {
  let events;
  try {
    events = await listPublishedEvents();
  } catch {
    return null;
  }
  const now = Date.now();
  const upcoming = events
    .filter(
      (e) =>
        e.visibility === "public" &&
        !e.archived &&
        e.startAt &&
        e.startAt.getTime() >= now,
    )
    .slice(0, 3);

  if (upcoming.length === 0) return null;

  const fmtDay = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric" });
  const fmtMonth = (d: Date) =>
    d.toLocaleDateString("en-GB", { month: "short" });
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <Reveal variant="mask-wipe" as="h2" className={styles.heading}>
          Upcoming.
        </Reveal>
        <Reveal variant="tilt-in" staggerChildren staggerMs={110} as="ul" className={styles.list}>
          {upcoming.map((e) => {
            const start = e.startAt!;
            const locationLine =
              e.locationHidden && e.locationPublicText
                ? e.locationPublicText
                : e.location || "Location TBA";
            return (
              <li key={e.id} className={styles.cardWrap}>
                <Link href={`/events/${e.id}`} className={styles.card}>
                  <div className={styles.dateBlock}>
                    <span className={styles.day}>{fmtDay(start)}</span>
                    <span className={styles.month}>{fmtMonth(start)}</span>
                  </div>
                  <div className={styles.body}>
                    <h3 className={styles.title}>{e.title}</h3>
                    <p className={styles.meta}>
                      {fmtTime(start)} · {locationLine}
                    </p>
                  </div>
                  <span className={styles.arrow} aria-hidden="true">→</span>
                </Link>
              </li>
            );
          })}
        </Reveal>
        <p className={styles.footer}>
          <Link href="/events" className={styles.allLink}>
            See all events →
          </Link>
        </p>
      </div>
    </section>
  );
}

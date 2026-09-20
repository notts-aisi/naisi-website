import type { Metadata } from "next";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import BlockView from "@/features/events/BlockView";
import CoverImage from "@/features/events/CoverImage";
import { getPublishedEvent } from "@/features/events/fetchEvents";
import { publicFoodLine } from "@/features/events/foodLine";
import { formatSiteDate, isSameSiteDay } from "@/lib/datetime/siteTime";
import {
  googleCalendarUrl,
  outlookLiveUrl,
  outlookOfficeUrl,
} from "@/lib/events/ics";
import { publicLocationLine, publicLocationText } from "@/lib/events/location";
import { FOOD_TAG_LABEL, type EventDoc } from "@/lib/firestore/events";
import { EventNotListed } from "./EventNotListed";
import styles from "./calendar.module.css";

/**
 * The landing page a printed QR code points at: add this event to a calendar,
 * and nothing else.
 *
 * ## Why it is its own page
 *
 * A fresher scans a poster at a stall, on a phone, on a hall network. What
 * they need first is the date, the time, the room and one tap, and on the
 * event page all four sit under a cover image and beside a signup panel.
 * Here the four come first and the organiser's own description follows them,
 * so somebody who scanned a film poster can read what is on without losing
 * the button they came for. Freshers' events are open, so this page asks for
 * nothing: no signup form and no call to action for one.
 *
 * ## What is above the buttons, and why it is plain text
 *
 * Every button here needs the network at the moment it is tapped, so on a
 * congested hall network the durable artefact is the text: title, when and
 * where, selectable, so a screenshot is a usable fallback. That is also why
 * the dates go through `formatSiteDate` rather than a bare `toLocaleString`:
 * this renders on a UTC, en-US container, and a screenshot of the wrong start
 * time is worse than no page.
 *
 * ## Why it is outside the (public) route group
 *
 * The URL is `/events/<id>/calendar` either way, because a route group adds
 * nothing to a path. What the group adds is its layout, and that layout's
 * `<main>` is rendered at opacity 0 until JavaScript has hydrated (see
 * `PublicMain`). That is right for the marketing pages and wrong here: on a
 * hall network the script can take many seconds, and the reader would be
 * looking at a blank screen with the date already downloaded. So this page
 * sits under the root layout alone, like `/links`, reads from the first HTML
 * that arrives, and carries its own small brand link home in place of the
 * site header.
 *
 * ## Which events it serves
 *
 * Exactly what `/events/[id]` serves, by the same read: a published or
 * cancelled event, archived or not, members-only or not. Nothing here widens
 * disclosure by one field, and the location goes through the one module
 * allowed to decide what a location says.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await getPublishedEvent(id);
  if (!event) return { title: "Event not found", robots: { index: false, follow: true } };
  return {
    title: `Add to calendar: ${titleOf(event)}`,
    description: "Add this NAISI event to Apple Calendar, Google Calendar or Outlook.",
    // This page repeats what the event page already says, so it is kept out of
    // search results: a printed code is the only entrance it is meant to have.
    robots: { index: false, follow: true },
  };
}

export default async function AddEventToCalendarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getPublishedEvent(id);
  // Returned, never `notFound()`: that would answer with an empty body until
  // the scripts arrive. See EventNotListed for why that matters here.
  if (!event) return <EventNotListed />;

  const title = titleOf(event);
  // A cancelled event has nothing to add, and an undated one has nothing to
  // add it to. Both are what the .ics route already answers 404 for, so the
  // page says so plainly rather than offering a button that downloads an
  // error.
  const startAt = event.status === "cancelled" ? null : event.startAt;
  const links = startAt
    ? {
        title,
        description: notesFor(event),
        // The payload carries the public TEXT while the page prints the
        // public LINE: an event with no venue should say so on screen and
        // carry no location at all into the calendar entry, which is what the
        // .ics route already does, so all three buttons agree.
        location: publicLocationText(event) || undefined,
        startAt,
        endAt: event.endAt,
      }
    : null;

  const foodLine = publicFoodLine(event);
  const dietaryTags = event.dietaryTags ?? [];
  // What the poster is actually about, in the organiser's own words. It sits
  // BELOW the buttons on purpose: the reader scanned a code to get this event
  // into their calendar, and a cover image above the fold would push the one
  // tap they came for off the screen.
  const hasDetails =
    Boolean(event.posterUrl) || Boolean(foodLine) || event.blocks.length > 0;

  return (
    <main className={styles.page}>
      <div className="container">
        <Link href="/" prefetch={false} className={styles.brand} aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
        <div className={styles.sheet}>
          <p className={styles.kicker}>Add to calendar</p>
          <h1 className={styles.title}>{title}</h1>
          {/* The event page says this with a badge. It matters here too:
              somebody about to put this in their calendar should know who it
              is for before they turn up. */}
          {event.visibility === "members" && (
            <p className={styles.audience}>This event is for NAISI members.</p>
          )}

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>When</dt>
              <dd className={styles.factValue}>
                {event.startAt ? (
                  <time dateTime={event.startAt.toISOString()}>
                    {whenLine(event.startAt, event.endAt)}
                  </time>
                ) : (
                  "Date to be confirmed"
                )}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Where</dt>
              <dd className={styles.factValue}>{publicLocationLine(event)}</dd>
            </div>
          </dl>

          {links ? (
            <>
              <div className={styles.actions}>
                {/*
                  Anchors styled as buttons, never a Button inside an anchor:
                  the primitive renders a real <button>, and that nesting is
                  invalid interactive content whose tap behaviour is unreliable
                  in iOS Safari, which is most of this page's traffic.

                  The .ics is same-origin and served with
                  `Content-Disposition: attachment`, so no `download`
                  attribute: on iOS that attribute biases the file towards the
                  Files app rather than a handoff to Calendar.
                */}
                <a
                  className={`${styles.action} ${styles.actionPrimary}`}
                  href={`/api/events/${event.id}/calendar.ics`}
                >
                  <span className={styles.actionLabel}>Apple Calendar</span>
                  <span className={styles.actionHint}>
                    Downloads a calendar file most apps can open
                  </span>
                </a>
                <a
                  className={styles.action}
                  href={googleCalendarUrl(links)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className={styles.actionLabel}>Google Calendar</span>
                </a>
              </div>

              <details className={styles.more}>
                <summary className={styles.summary}>Outlook</summary>
                <div className={styles.moreBody}>
                  <div className={styles.actions}>
                    <a
                      className={styles.action}
                      href={outlookLiveUrl(links)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className={styles.actionLabel}>Outlook.com</span>
                    </a>
                    <a
                      className={styles.action}
                      href={outlookOfficeUrl(links)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className={styles.actionLabel}>
                        Microsoft 365, university or work account
                      </span>
                    </a>
                  </div>
                  <p className={styles.note}>
                    If you are not already signed in, Outlook&rsquo;s sign-in
                    redirect replaces the spaces in the title with plus signs.
                    The date, the time and the place still arrive correctly.
                  </p>
                </div>
              </details>
            </>
          ) : (
            <p className={styles.notice}>
              {event.status === "cancelled"
                ? "This event has been cancelled, so there is nothing to add to your calendar."
                : "This event has no date yet, so there is nothing to add to your calendar."}{" "}
              <Link className={styles.inlineLink} href="/events" prefetch={false}>
                See what else is on
              </Link>
              .
            </p>
          )}

          {hasDetails && (
            <div className={styles.details}>
              {event.posterUrl && (
                // The fields the cover needs, never the document: every prop a
                // client component takes from a Server Component is serialised
                // into the public HTML.
                <CoverImage
                  url={event.posterUrl}
                  alt={title}
                  branding={event.coverBranding}
                  logoColor={event.coverLogoColor}
                  stripSize={event.coverStripSize}
                  logoPosition={event.coverLogoPosition}
                  logoScale={event.coverLogoScale}
                  logoX={event.coverLogoX}
                  logoY={event.coverLogoY}
                  logoBackdrop={event.coverLogoBackdrop}
                  logoShadow={event.coverLogoShadow}
                />
              )}

              {foodLine && (
                <div className={styles.food}>
                  <span className={styles.foodLabel}>Food</span>
                  <p className={styles.foodText}>{foodLine}</p>
                  {dietaryTags.length > 0 && (
                    <p className={styles.foodTags}>
                      {dietaryTags.map((tag) => FOOD_TAG_LABEL[tag]).join(" · ")}
                    </p>
                  )}
                </div>
              )}

              {/* The same blocks the event page renders, through the same
                  component, so a screening's description reads identically in
                  both places. */}
              {event.blocks.length > 0 && <BlockView blocks={event.blocks} />}
            </div>
          )}

          {/*
            Both internal links opt out of viewport prefetching: this page is
            opened once, from a printed code, on whatever the hall network is
            that day, and the bytes belong to the tap the reader makes.
          */}
          <Link
            className={styles.detailsLink}
            href={`/events/${event.id}`}
            prefetch={false}
          >
            Event details
          </Link>
        </div>
      </div>
    </main>
  );
}

function titleOf(event: EventDoc): string {
  return event.title.trim() || "NAISI event";
}

/**
 * The when line. An end on the same London day is a time; an end on another
 * day repeats the date, because "until 14:00" on a two-day event says the
 * wrong thing. London civil time either way: `isSameSiteDay` compares civil
 * dates rather than `getDate()`, which would read the container's zone.
 */
function whenLine(startAt: Date, endAt: Date | null): string {
  const base = formatSiteDate(startAt, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!endAt) return base;
  if (isSameSiteDay(startAt, endAt)) {
    return `${base} until ${formatSiteDate(endAt, { hour: "2-digit", minute: "2-digit" })}`;
  }
  const endFull = formatSiteDate(endAt, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${base} until ${endFull}`;
}

/** What the calendar entry's notes carry: the food line, then a link back. */
function notesFor(event: EventDoc): string | undefined {
  const parts: string[] = [];
  const food = event.foodText?.trim();
  if (food) parts.push(`Food: ${food}`);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) parts.push(`${appUrl}/events/${event.id}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

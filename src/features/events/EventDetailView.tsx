import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import BlockView from "./BlockView";
import CoverImage from "./CoverImage";
import RsvpForm from "./RsvpForm";
import {
  FOOD_PROVENANCE_BADGE,
  FOOD_TAG_LABEL,
  type EventDoc,
} from "@/lib/firestore/events";
import { googleCalendarUrl } from "@/lib/events/ics";
import styles from "./EventDetailView.module.css";

/**
 * Shared event detail layout for the public /events/[id] page and the authed
 * preview page. An optional cover banner, then a two-column grid: a single
 * details card (title, when, where, capacity) followed by the food callout and
 * description on the left, with a sticky RSVP panel on the right.
 */
export default function EventDetailView({
  event,
  previewMode,
}: {
  event: EventDoc;
  previewMode?: boolean;
}) {
  const isCancelled = event.status === "cancelled";
  const dietaryTags = event.dietaryTags ?? [];
  const foodDisplay = event.foodText?.trim() || legacyFoodLine(event);
  const whereText = event.locationHidden ? event.locationPublicText : event.location;
  const calendarStart = isCancelled ? null : event.startAt;

  return (
    <div className={styles.page}>
      {event.posterUrl ? (
        <CoverImage
          url={event.posterUrl}
          alt={event.title}
          branding={event.coverBranding}
          logoColor={event.coverLogoColor}
          stripSize={event.coverStripSize}
          logoPosition={event.coverLogoPosition}
        />
      ) : null}

      <div className={styles.layout}>
        <div className={styles.main}>
          <Card padding="lg">
            <div className={styles.badgeRow}>
              {event.visibility === "members" && (
                <Badge tone="neutral">Members only</Badge>
              )}
              {isCancelled && <Badge tone="danger">Cancelled</Badge>}
              {dietaryTags.map((tag) => (
                <Badge key={tag} tone="accent">
                  {FOOD_TAG_LABEL[tag]}
                </Badge>
              ))}
            </div>

            <h1 className={styles.title}>{event.title || "(no title)"}</h1>

            <div className={styles.factList}>
              <div className={styles.fact}>
                <span className={styles.factIcon}>
                  <CalendarIcon />
                </span>
                <span className={styles.factBody}>
                  <span className={styles.factLabel}>When</span>
                  <span className={styles.factValue}>
                    {event.startAt ? (
                      <>
                        <time dateTime={event.startAt.toISOString()}>
                          {formatDateTime(event.startAt)}
                        </time>
                        {event.endAt && (
                          <>
                            {" until "}
                            <time dateTime={event.endAt.toISOString()}>
                              {formatTime(event.endAt)}
                            </time>
                          </>
                        )}
                      </>
                    ) : (
                      "Date to be confirmed"
                    )}
                  </span>
                </span>
              </div>

              {whereText && (
                <div className={styles.fact}>
                  <span className={styles.factIcon}>
                    <PinIcon />
                  </span>
                  <span className={styles.factBody}>
                    <span className={styles.factLabel}>Where</span>
                    <span className={styles.factValue}>{whereText}</span>
                    {event.locationHidden && (
                      <span className={styles.factNote}>
                        Exact location shared once your RSVP is approved.
                      </span>
                    )}
                  </span>
                </div>
              )}

              {event.capacity !== null && (
                <div className={styles.fact}>
                  <span className={styles.factIcon}>
                    <UsersIcon />
                  </span>
                  <span className={styles.factBody}>
                    <span className={styles.factLabel}>Capacity</span>
                    <span className={styles.factValue}>
                      {event.capacity} places · {event.rsvpCountConfirmed ?? 0}{" "}
                      confirmed
                    </span>
                    {event.waitlistEnabled && (
                      <span className={styles.factNote}>
                        Waitlist opens once full.
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {calendarStart && (
              <div className={styles.calendar}>
                <span className={styles.calendarLabel}>Add to calendar</span>
                <div className={styles.calendarLinks}>
                  <a
                    href={googleCalendarUrl({
                      title: event.title || "NAISI event",
                      description: calendarDescription(event),
                      location: whereText || undefined,
                      startAt: calendarStart,
                      endAt: event.endAt,
                    })}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <Button variant="ghost">Google Calendar</Button>
                  </a>
                  <a href={`/api/events/${event.id}/calendar.ics`} download>
                    <Button variant="ghost">Apple, Outlook (.ics)</Button>
                  </a>
                </div>
              </div>
            )}
          </Card>

          {foodDisplay && (
            <div className={styles.foodCallout}>
              <span className={styles.foodCalloutLabel}>Food</span>
              <p className={styles.foodCalloutText}>{foodDisplay}</p>
            </div>
          )}

          <Card padding="lg">
            {event.blocks.length > 0 ? (
              <BlockView blocks={event.blocks} />
            ) : (
              <p className={styles.descriptionEmpty}>No description yet.</p>
            )}
          </Card>
        </div>

        <div className={styles.aside}>
          {isCancelled ? (
            <Card padding="lg">
              <h2 className={styles.cancelledTitle}>This event has been cancelled.</h2>
              <p className={styles.cancelledText}>
                Apologies for the late notice. Keep an eye on the events page for the
                next one.
              </p>
            </Card>
          ) : (
            <RsvpForm event={event} previewMode={previewMode} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Calendar-entry notes: the food line, if any, and a link back to the event. */
function calendarDescription(event: EventDoc): string | undefined {
  const parts: string[] = [];
  if (event.foodText?.trim()) parts.push(`Food: ${event.foodText.trim()}`);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) parts.push(`${appUrl}/events/${event.id}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** foodText is the primary description; fall back to the legacy provenance for old events. */
function legacyFoodLine(event: EventDoc): string | null {
  if (event.foodProvenance === "none") return null;
  const badge = FOOD_PROVENANCE_BADGE[event.foodProvenance];
  const note = event.foodProvenanceNote?.trim();
  return note ? `${badge}: ${note}` : badge;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function CalendarIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

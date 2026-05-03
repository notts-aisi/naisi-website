import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { listPublishedEvents } from "@/features/events/fetchEvents";

export const metadata: Metadata = {
  title: "Events",
  description:
    "Upcoming NAISI events. Socials, talks, fellowship sessions. RSVP to save a spot.",
};

export const dynamic = "force-dynamic";

function formatWhen(d: Date | null): string {
  if (!d) return "Date TBD";
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function PublicEventsIndex() {
  const events = await listPublishedEvents();
  const now = Date.now();
  const upcoming = events.filter(
    (e) => !e.startAt || e.startAt.getTime() >= now,
  );
  const past = events.filter((e) => e.startAt && e.startAt.getTime() < now);

  return (
    <section style={{ padding: "var(--space-16) 0" }}>
      <div className="container">
        <div style={{ maxWidth: "40rem", marginBottom: "var(--space-10)" }}>
          <Badge>What&apos;s on</Badge>
          <h1 style={{ marginTop: "var(--space-4)" }}>Events</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
            Upcoming socials, talks, and sessions. Click through to save a spot.
          </p>
        </div>

        {upcoming.length === 0 && past.length === 0 ? (
          <Card padding="lg">
            <p style={{ color: "var(--color-text-muted)" }}>
              No events on the calendar right now. Check back soon.
            </p>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            {upcoming.length > 0 && (
              <div>
                <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>
                  Upcoming
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                  {upcoming.map((e) => (
                    <EventRow key={e.id} event={e} />
                  ))}
                </div>
              </div>
            )}
            {past.length > 0 && (
              <div>
                <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>
                  Past
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                  {past.slice(0, 20).map((e) => (
                    <EventRow key={e.id} event={e} dimmed />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EventRow({
  event,
  dimmed,
}: {
  event: Awaited<ReturnType<typeof listPublishedEvents>>[number];
  dimmed?: boolean;
}) {
  const full =
    event.capacity !== null &&
    typeof event.rsvpCountConfirmed === "number" &&
    event.rsvpCountConfirmed >= event.capacity;
  return (
    <Link
      href={`/events/${event.id}`}
      style={{ textDecoration: "none", opacity: dimmed ? 0.7 : 1 }}
    >
      <Card padding="lg" interactive>
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            alignItems: "center",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            marginBottom: "var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {event.startAt && (
            <time dateTime={event.startAt.toISOString()}>{formatWhen(event.startAt)}</time>
          )}
          {event.location && <span>· {event.location}</span>}
          {event.visibility === "members" && <Badge tone="neutral">Members only</Badge>}
          {full && event.waitlistEnabled && <Badge tone="warning">Full · waitlist open</Badge>}
          {full && !event.waitlistEnabled && <Badge tone="danger">Full</Badge>}
        </div>
        <h2 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
          {event.title || "(no title)"}
        </h2>
      </Card>
    </Link>
  );
}

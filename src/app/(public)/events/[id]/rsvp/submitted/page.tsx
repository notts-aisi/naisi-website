import type { Metadata } from "next";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { getPublishedEvent } from "@/features/events/fetchEvents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "RSVP submitted" };

/**
 * Confirmation page an attendee lands on after submitting an RSVP. A dedicated
 * page so the "we've got it" message can't be scrolled past or missed.
 */
export default async function RsvpSubmittedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getPublishedEvent(id);

  return (
    <section style={{ padding: "var(--space-16) 0" }}>
      <div className="container" style={{ maxWidth: "34rem" }}>
        <Card padding="lg">
          {/* Addressed by the browser end-to-end suite: this headline is how a
              guest knows the RSVP landed, so it is what the spec waits for. */}
          <h1
            data-testid="rsvp-submitted"
            style={{ fontSize: "var(--text-2xl, 1.5rem)", margin: "0 0 var(--space-3)" }}
          >
            Your RSVP is in
          </h1>
          <p style={{ color: "var(--color-text)", lineHeight: 1.6, margin: "0 0 var(--space-2)" }}>
            {event
              ? `Thanks. Your RSVP for ${event.title} has been submitted.`
              : "Thanks. Your RSVP has been submitted."}
          </p>
          <p
            style={{
              color: "var(--color-text-muted)",
              lineHeight: 1.6,
              margin: "0 0 var(--space-5)",
            }}
          >
            A NAISI organiser will review it and email you once your spot is
            confirmed. Keep an eye on that inbox, and your spam folder just in
            case.
          </p>
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            {event && (
              <Link href={`/events/${id}`}>
                <Button variant="ghost">Back to the event</Button>
              </Link>
            )}
            <Link href="/events">
              <Button>See all events</Button>
            </Link>
          </div>
        </Card>
      </div>
    </section>
  );
}

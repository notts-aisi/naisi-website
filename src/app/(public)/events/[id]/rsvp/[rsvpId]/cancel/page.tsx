import Card from "@/components/ui/Card";
import SelfCancelForm from "@/features/events/SelfCancelForm";
import { getEventForPreview } from "@/features/events/fetchEvents";
import { verifyRsvpToken } from "@/lib/events/rsvpToken";
import { getAdminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string; rsvpId: string }>;
type Search = Promise<{ t?: string | string[] }>;

export default async function CancelRsvpPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id: eventId, rsvpId } = await params;
  const q = await searchParams;
  const token = typeof q.t === "string" ? q.t : "";

  const db = getAdminDb();
  const rsvpSnap = db ? await db.collection("eventRsvps").doc(rsvpId).get() : null;
  const event = await getEventForPreview(eventId);

  const shell = (body: React.ReactNode) => (
    <section style={{ padding: "var(--space-12) 0" }}>
      <div className="container" style={{ maxWidth: "34rem" }}>
        {body}
      </div>
    </section>
  );

  if (!event || !rsvpSnap?.exists) {
    return shell(
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Link no longer valid
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          We couldn&apos;t find this RSVP — it may already have been cancelled, or the event
          has been removed.
        </p>
      </Card>,
    );
  }

  const rsvp = rsvpSnap.data() ?? {};
  const email = typeof rsvp.email === "string" ? rsvp.email : "";
  const ok = token && email && verifyRsvpToken(rsvpId, email, token);
  if (!ok || rsvp.eventId !== eventId) {
    return shell(
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Link no longer valid
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          This cancel link has expired or doesn&apos;t match this event. If you still need to
          cancel, reply to your confirmation email and we&apos;ll sort it out.
        </p>
      </Card>,
    );
  }

  if (rsvp.status === "cancelled") {
    return shell(
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Already cancelled
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          This RSVP was cancelled already — no action needed.
        </p>
      </Card>,
    );
  }

  return shell(
    <SelfCancelForm
      eventId={eventId}
      rsvpId={rsvpId}
      token={token}
      name={typeof rsvp.name === "string" ? rsvp.name : ""}
      eventTitle={event.title}
    />,
  );
}

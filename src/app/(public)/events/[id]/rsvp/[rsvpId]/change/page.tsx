import Card from "@/components/ui/Card";
import ChangeRequestForm from "@/features/events/ChangeRequestForm";
import { getEventForPreview } from "@/features/events/fetchEvents";
import { verifyRsvpToken } from "@/lib/events/rsvpToken";
import { getAdminDb } from "@/lib/firebase/admin";
import type { RsvpAnswer } from "@/lib/firestore/events";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string; rsvpId: string }>;
type Search = Promise<{ t?: string | string[] }>;

export default async function ChangeRequestPage({
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
      <div className="container" style={{ maxWidth: "40rem" }}>
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
          We couldn&apos;t find this RSVP. If you need to change your details, reply to
          your confirmation email and an organiser will help.
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
          This change-request link has expired or doesn&apos;t match this event. Reply to
          your confirmation email and we&apos;ll sort it out.
        </p>
      </Card>,
    );
  }

  if (rsvp.status === "cancelled" || rsvp.status === "denied") {
    return shell(
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          No active RSVP to change
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          This RSVP is {rsvp.status}. If you want to re-register, visit the event page.
        </p>
      </Card>,
    );
  }

  if (event.signupForm.length === 0) {
    return shell(
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Nothing to update
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          This event doesn&apos;t have any signup questions, so there&apos;s nothing here to
          change.
        </p>
      </Card>,
    );
  }

  const pending = rsvp.pendingAnswers as Record<string, RsvpAnswer> | undefined;
  const current = (rsvp.answers as Record<string, RsvpAnswer> | undefined) ?? {};

  return shell(
    <ChangeRequestForm
      eventId={eventId}
      rsvpId={rsvpId}
      token={token}
      eventTitle={event.title}
      name={typeof rsvp.name === "string" ? rsvp.name : ""}
      questions={event.signupForm}
      initialAnswers={pending ?? current}
      hasPending={!!pending}
    />,
  );
}

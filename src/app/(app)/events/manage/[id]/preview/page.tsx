import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EventDetailView from "@/features/events/EventDetailView";
import { getEventForPreview } from "@/features/events/fetchEvents";
import { EVENT_STATUS_LABEL } from "@/lib/firestore/events";
import { getCurrentUser } from "@/lib/firebase/session";

export const dynamic = "force-dynamic";

export default async function EventPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await getCurrentUser();
  if (!viewer) redirect("/login");
  // The preview shows the public event view (no attendee PII), so it matches
  // the events-area gate: the whole committee, plus draft/approve holders.
  const allowed =
    viewer.role === "admin" ||
    viewer.role === "committee" ||
    viewer.permissions.draftEvent ||
    viewer.permissions.approveEvent;
  if (!allowed) redirect("/dashboard");

  const event = await getEventForPreview(id);
  if (!event) notFound();

  return (
    <section style={{ padding: "var(--space-8) 0" }}>
      <div className="container">
        <Card padding="md">
          <div
            style={{
              display: "flex",
              gap: "var(--space-3)",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
            }}
          >
            <div>
              <strong>Preview</strong>
              <p style={{ margin: "var(--space-1) 0 0", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                This is how the event looks to a visitor. Current status:{" "}
                <strong>{EVENT_STATUS_LABEL[event.status]}</strong>. RSVPs submitted here
                are saved for real, so it&apos;s useful for end-to-end testing before publish.
              </p>
            </div>
            <Link href={`/events/manage/${event.id}`}>
              <Button variant="ghost">Back to editor</Button>
            </Link>
          </div>
        </Card>

        <div style={{ marginTop: "var(--space-8)" }}>
          <EventDetailView event={event} previewMode />
        </div>
      </div>
    </section>
  );
}

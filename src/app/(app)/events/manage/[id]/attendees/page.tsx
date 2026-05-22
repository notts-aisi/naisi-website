import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Button from "@/components/ui/Button";
import AttendeeDashboard from "@/features/events/AttendeeDashboard";
import { getEventForPreview } from "@/features/events/fetchEvents";
import { getCurrentUser } from "@/lib/firebase/session";

export const dynamic = "force-dynamic";

export default async function AttendeesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Attendee PII is for SU-recognised committee and admins only. The events
  // area is open to all committee members, but the attendee list is not.
  const viewer = await getCurrentUser();
  if (!viewer) redirect("/login");
  const canSeeAttendees =
    viewer.role === "admin" ||
    (viewer.role === "committee" && viewer.suRecognised);
  if (!canSeeAttendees) redirect(`/events/manage/${id}`);

  const event = await getEventForPreview(id);
  if (!event) notFound();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {event.title || "Untitled event"}
          </div>
          <h2 style={{ fontSize: "var(--text-2xl)", margin: "var(--space-1) 0 0" }}>
            Attendees
          </h2>
        </div>
        <Link href={`/events/manage/${event.id}`}>
          <Button variant="ghost">Back to editor</Button>
        </Link>
      </div>

      <AttendeeDashboard event={event} />
    </div>
  );
}

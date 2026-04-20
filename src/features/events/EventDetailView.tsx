import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import BlockView from "./BlockView";
import RsvpForm from "./RsvpForm";
import { FOOD_PROVENANCE_BADGE, type EventDoc } from "@/lib/firestore/events";

/**
 * Shared event detail layout used by both the public /events/[id] page and
 * the authed preview page. The preview variant passes `previewMode` so the
 * RSVP form can flag test submissions and show a banner.
 */
export default function EventDetailView({
  event,
  previewMode,
}: {
  event: EventDoc;
  previewMode?: boolean;
}) {
  const isCancelled = event.status === "cancelled";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8)",
        maxWidth: "44rem",
      }}
    >
      <header>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
          {event.visibility === "members" && <Badge tone="neutral">Members only</Badge>}
          {isCancelled && <Badge tone="danger">Cancelled</Badge>}
          {event.foodProvenance !== "none" && (
            <Badge tone="accent">{FOOD_PROVENANCE_BADGE[event.foodProvenance]}</Badge>
          )}
        </div>
        <h1 style={{ fontSize: "var(--text-3xl)", margin: 0 }}>
          {event.title || "(no title)"}
        </h1>
        <div
          style={{
            color: "var(--color-text-muted)",
            marginTop: "var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            fontSize: "var(--text-md, 1rem)",
          }}
        >
          <div>
            <strong style={{ color: "var(--color-text)" }}>When:</strong>{" "}
            {event.startAt ? (
              <time dateTime={event.startAt.toISOString()}>
                {event.startAt.toLocaleString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            ) : (
              "TBD"
            )}
            {event.endAt && event.startAt && (
              <>
                {" — "}
                <time dateTime={event.endAt.toISOString()}>
                  {event.endAt.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </>
            )}
          </div>
          {(event.locationHidden ? event.locationPublicText : event.location) && (
            <div>
              <strong style={{ color: "var(--color-text)" }}>Where:</strong>{" "}
              {event.locationHidden ? event.locationPublicText : event.location}
              {event.locationHidden && (
                <span style={{ marginLeft: "var(--space-2)", fontStyle: "italic" }}>
                  (exact location shared once your RSVP is approved)
                </span>
              )}
            </div>
          )}
          {event.capacity !== null && (
            <div>
              <strong style={{ color: "var(--color-text)" }}>Capacity:</strong>{" "}
              {event.capacity} — {event.rsvpCountConfirmed ?? 0} confirmed
              {event.waitlistEnabled ? " (waitlist open)" : ""}
            </div>
          )}
          {event.foodProvenance !== "none" && (
            <div>
              <strong style={{ color: "var(--color-text)" }}>Food:</strong>{" "}
              {FOOD_PROVENANCE_BADGE[event.foodProvenance]}
              {event.foodProvenanceNote ? ` — ${event.foodProvenanceNote}` : ""}
            </div>
          )}
        </div>
      </header>

      {event.blocks.length > 0 && (
        <Card padding="lg">
          <BlockView blocks={event.blocks} />
        </Card>
      )}

      {isCancelled ? (
        <Card padding="lg">
          <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
            This event has been cancelled.
          </h2>
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            Apologies for the late notice — keep an eye on the events page for the next one.
          </p>
        </Card>
      ) : (
        <RsvpForm event={event} previewMode={previewMode} />
      )}
    </div>
  );
}

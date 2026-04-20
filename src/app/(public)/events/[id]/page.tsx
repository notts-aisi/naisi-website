import type { Metadata } from "next";
import { notFound } from "next/navigation";
import EventDetailView from "@/features/events/EventDetailView";
import { getPublishedEvent } from "@/features/events/fetchEvents";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await getPublishedEvent(id);
  if (!event) return { title: "Event not found" };
  return {
    title: event.title,
    description: `NAISI event on ${event.startAt?.toDateString() ?? "a date to be confirmed"}.`,
  };
}

export default async function PublicEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getPublishedEvent(id);
  if (!event) notFound();

  return (
    <section style={{ padding: "var(--space-12) 0" }}>
      <div className="container">
        <EventDetailView event={event} />
      </div>
    </section>
  );
}

import EventEditor from "@/features/events/EventEditor";

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EventEditor eventId={id} />;
}

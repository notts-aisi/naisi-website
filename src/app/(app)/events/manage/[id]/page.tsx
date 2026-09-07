import EventEditor from "@/features/events/EventEditor";
import { getAdminDb } from "@/lib/firebase/admin";
import { announcementQueueEnabled } from "@/lib/scheduler/announcementQueue";

/**
 * The editor is a client component (it wants `onSnapshot`), and the switch it
 * needs for one sentence of copy lives in `config/scheduler`, which is closed
 * to every client. So the answer is read here, on the server, and handed down.
 *
 * A read that fails falls back to `false`, which is the wording for the inline
 * path: an announcement described as immediate that turns out to take fifteen
 * minutes is a smaller surprise than the reverse.
 */
export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAdminDb();
  let announcementsQueued = false;
  if (db) {
    try {
      announcementsQueued = await announcementQueueEnabled(db);
    } catch (err) {
      console.error("[events manage] could not read the announcement switch", err);
    }
  }
  return <EventEditor eventId={id} announcementsQueued={announcementsQueued} />;
}

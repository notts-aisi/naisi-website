import { NextResponse } from "next/server";
import { getPublishedEvent } from "@/features/events/fetchEvents";
import { buildEventIcs } from "@/lib/events/ics";

export const dynamic = "force-dynamic";

/**
 * Public "add to calendar" download for a published event. Uses the
 * public-safe location: when the exact location is hidden, the placeholder is
 * used so the file never leaks an address that hasn't been released yet. The
 * RSVP-approval email attaches its own .ics carrying the exact location.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const event = await getPublishedEvent(id);
  if (!event || !event.startAt || event.status === "cancelled") {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const eventUrl = appUrl ? `${appUrl}/events/${event.id}` : undefined;
  const location = event.locationHidden
    ? event.locationPublicText ?? ""
    : event.location;

  const descriptionParts: string[] = [];
  if (event.foodText) descriptionParts.push(`Food: ${event.foodText}`);
  if (eventUrl) descriptionParts.push(eventUrl);

  const ics = buildEventIcs({
    uid: event.id,
    title: event.title || "NAISI event",
    description: descriptionParts.join("\n") || undefined,
    location: location || undefined,
    url: eventUrl,
    startAt: event.startAt,
    endAt: event.endAt,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="naisi-event.ics"',
      "Cache-Control": "no-store",
    },
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/firebase/session";
import { deleteSubscriptionByEndpoint } from "@/lib/push/store";

/*
 * Removes a device's subscription row. The store helper only deletes when
 * the row's uid matches the caller, so one member cannot silence another's
 * device by guessing endpoints. The client also unsubscribes locally; this
 * removes the server's half so nothing keeps pushing at a dead endpoint
 * until the 410 prune would have caught it.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not authorised" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return NextResponse.json({ error: "Bad endpoint" }, { status: 400 });
  }
  await deleteSubscriptionByEndpoint(endpoint, user.uid);
  return NextResponse.json({ ok: true });
}

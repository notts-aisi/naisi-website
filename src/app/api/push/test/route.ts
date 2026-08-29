import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/firebase/session";
import { isPushConfigured } from "@/lib/push/config";
import { sendPushToUid } from "@/lib/push/send";

/*
 * Sends a test notification to the CALLER's own devices, nobody else's.
 * Self-serve on purpose: "did enabling actually work" is a question every
 * member should be able to answer from their own profile without an admin,
 * and a send that can only target yourself needs no further authorisation.
 */
export async function POST() {
  if (!isPushConfigured()) {
    return NextResponse.json({ error: "Push is not configured" }, { status: 503 });
  }
  const user = await getCurrentUser();
  if (!user || user.role === "pending" || user.role === "rejected") {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }
  // retryFresh: the common case for this route is a tap seconds after
  // "Enable notifications", inside the window where the push service still
  // answers 410 for a live subscription (see send.ts). Waiting it out here
  // is what makes the first test succeed instead of reporting nothing sent.
  const counts = await sendPushToUid(
    user.uid,
    {
      title: "NAISI notifications are working",
      body: "This device will now receive notifications from NAISI.",
      url: "/profile",
    },
    { retryFresh: true },
  );
  return NextResponse.json({ ok: true, ...counts });
}

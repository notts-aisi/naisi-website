import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { signToken } from "@/lib/signedTokens";
import { isSuppressed } from "@/lib/firestore/suppression";
import { sendEmail } from "@/lib/email/send";
import { emailDocId, normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  isValidChannel,
  subscribe,
  subscriptionDocId,
} from "@/lib/firestore/subscriptions";
import SubscriptionConfirmEmail from "@/emails/SubscriptionConfirmEmail";
import SubscriptionAddedEmail from "@/emails/SubscriptionAddedEmail";

/**
 * Subscribe an email to a channel. Used by:
 *  - Public homepage forms (guest path) — anonymous POST, double-opt-in for
 *    first-time emails, single-click for emails that have any prior
 *    confirmed row (i.e. the inbox is already proven).
 *  - Signed-in members hitting the same endpoint, which shortcuts to
 *    confirmed because their session cookie is itself proof of inbox
 *    control. (Member settings UI uses /api/subscriptions/sync instead,
 *    which applies the full prefs object as deltas.)
 *
 * Anti-enumeration discipline: every non-validation outcome returns
 * `{ ok: true, status: 200 }`. The caller cannot tell the difference between
 * "fresh signup", "already subscribed", "in cooldown", or "address is on the
 * suppression list" — all return identical bodies. Validation failures still
 * return 400 (so the form can show an inline error), since malformed input
 * isn't an enumeration risk.
 */

const COOLDOWN_SECONDS = 60;
const CONFIRM_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year — public unsub links should be long-lived
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LEN = 200;

type Body = {
  email?: unknown;
  channel?: unknown;
  source?: unknown;
  /**
   * Optional first / preferred name. Stored on the subscription row for
   * admin visibility and used by the welcome and "added" emails to greet
   * the recipient by name. Trimmed and length-capped before storage.
   */
  name?: unknown;
};

const NAME_MAX_LEN = 80;

export async function POST(req: Request) {
  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const rawEmail = typeof parsed.email === "string" ? parsed.email : "";
  const email = normaliseEmail(rawEmail);
  if (
    !email ||
    email.length > MAX_EMAIL_LEN ||
    !EMAIL_RE.test(email)
  ) {
    return NextResponse.json(
      { error: "That doesn't look like a valid email." },
      { status: 400 },
    );
  }

  const channel = typeof parsed.channel === "string" ? parsed.channel : "";
  if (!isValidChannel(channel)) {
    return NextResponse.json(
      { error: "Invalid subscription channel." },
      { status: 400 },
    );
  }

  const source =
    typeof parsed.source === "string" && parsed.source.length > 0 && parsed.source.length <= 80
      ? parsed.source
      : "unknown";

  const rawName = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const name = rawName.length > 0 && rawName.length <= NAME_MAX_LEN ? rawName : undefined;

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json(
      { error: "Server not configured" },
      { status: 500 },
    );
  }

  // Suppression list — silently succeed. We do NOT differentiate this case;
  // exposing "your address bounced previously" via a distinct status would
  // leak which addresses have prior interaction history with us.
  if (await isSuppressed(db, email)) {
    return NextResponse.json({ ok: true });
  }

  // Per-email cooldown floor. The subscribe() helper would itself bump the
  // counter, but checking BEFORE that lets us short-circuit re-sends on
  // mailbomb-style abuse — same address, repeated POSTs in seconds.
  const ref = db
    .collection("subscriptions")
    .doc(subscriptionDocId({ email, channel }));
  const before = await ref.get();
  if (before.exists) {
    const data = before.data() as { lastAttemptAt?: Timestamp } | undefined;
    const last = data?.lastAttemptAt;
    if (last && Timestamp.now().toMillis() - last.toMillis() < COOLDOWN_SECONDS * 1000) {
      return NextResponse.json({ ok: true });
    }
  }

  // Signed-in caller? Shortcut to confirmed, audience=user. Anonymous caller?
  // Guest flow with double-opt-in (or one-click if the email has any prior
  // confirmed row).
  const session = await getCurrentUser();
  const audience = session ? "user" : "guest";
  const audienceId = session ? session.uid : emailDocId(email);

  let result;
  try {
    result = await subscribe(db, {
      email,
      channel,
      audience,
      audienceId,
      source,
      name,
    });
  } catch (err) {
    console.error("[/api/subscriptions] subscribe failed", err);
    return NextResponse.json(
      { error: "Could not save subscription" },
      { status: 500 },
    );
  }

  // Nothing to do beyond the subscribe() call when the row is already in its
  // terminal state and no new channel was just attached. Silent success.
  if (
    result.status === "confirmed" &&
    !result.created &&
    !result.newlyAddedChannel
  ) {
    return NextResponse.json({ ok: true });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const replyTo = process.env.EMAIL_DEFAULT_REPLY_TO;

  // Pre-mint a per-channel unsubscribe token so the welcome / confirm /
  // added emails can include a one-click unsub from this exact channel.
  const unsubToken = signToken(
    { s: "unsubscribe", email, c: channel },
    UNSUB_TOKEN_TTL_SECONDS,
  );
  const unsubUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(unsubToken)}`;

  if (result.requiresConfirmation) {
    const confirmToken = signToken(
      { s: "public-confirm", e: email },
      CONFIRM_TOKEN_TTL_SECONDS,
    );
    const confirmUrl = `${appUrl}/api/subscriptions/confirm?t=${encodeURIComponent(confirmToken)}`;

    try {
      await sendEmail({
        to: email,
        subject: "Confirm your NAISI subscription",
        react: SubscriptionConfirmEmail({
          confirmUrl,
          channels: [channel],
          expiresInHours: Math.round(CONFIRM_TOKEN_TTL_SECONDS / 3600),
          unsubUrl,
          name,
        }),
        kind: "subscription-confirm",
        referenceId: emailDocId(email),
        listUnsubscribe: { url: unsubUrl, mailto: replyTo },
      });
    } catch (err) {
      console.error("[/api/subscriptions] confirm send failed", email, err);
      // Tell the form to retry — the row is in pending, but no confirm email
      // landed, so the user is stuck without intervention.
      return NextResponse.json(
        { error: "Couldn't send confirmation. Try again." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, kind: "confirmation-sent" });
  }

  // Confirmed path. Two sub-cases:
  //  - newlyAddedChannel: an already-confirmed email just picked up a new
  //    channel. Send the low-key "added" notice.
  //  - else: the channel was already confirmed-and-active for this address.
  //    Stay silent (no extra mail) — covered by the early return above.
  if (result.newlyAddedChannel) {
    try {
      await sendEmail({
        to: email,
        subject: `You're now subscribed to ${friendlyForKind(channel)}`,
        react: SubscriptionAddedEmail({ channel, unsubUrl, name }),
        kind: "subscription-added",
        referenceId: emailDocId(email),
        listUnsubscribe: { url: unsubUrl, mailto: replyTo },
      });
    } catch (err) {
      // Don't propagate — the row is already saved as confirmed. Worst case
      // they just don't get a receipt, which is fine.
      console.warn("[/api/subscriptions] added-notice send failed", email, err);
    }
    return NextResponse.json({ ok: true, kind: "added" });
  }

  return NextResponse.json({ ok: true });
}

/** Used only as the SubscriptionAddedEmail subject line input. */
function friendlyForKind(channel: string): string {
  if (channel === "newsletter") return "the Sunday digest";
  if (channel === "events") return "event announcements";
  return channel;
}

import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { signToken } from "@/lib/signedTokens";
import { isSuppressed } from "@/lib/firestore/suppression";
import { sendEmail } from "@/lib/email/send";
import { emailDocId, normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  isServerManagedChannel,
  isValidChannel,
  subscribe,
  subscriptionDocId,
  type SubscriptionActor,
} from "@/lib/firestore/subscriptions";
import { getVerifiedEmails } from "@/lib/firestore/notifications";
import SubscriptionConfirmEmail from "@/emails/SubscriptionConfirmEmail";
import SubscriptionAddedEmail from "@/emails/SubscriptionAddedEmail";

/**
 * Subscribe an email to one or more channels in a single call. Used by:
 *  - Public homepage forms: anonymous POST, always double-opt-in. Every
 *    address earns its own confirmation click. There is no shortcut off a
 *    prior confirmed row: a logged-out caller typing an address has not
 *    proven they control it.
 *  - Signed-in members hitting the same endpoint: the row skips
 *    confirmation ONLY when the posted email is one of that member's own
 *    verified emails. A member subscribing any other address goes through
 *    the same double-opt-in as a guest. (Member settings UI uses
 *    /api/subscriptions/sync instead, which applies the prefs matrix as
 *    deltas over the member's verified emails.)
 *
 * Body shape (either form is accepted):
 *  - { email, channel: string, source?, name? }     // legacy single
 *  - { email, channels: string[], source?, name? }  // multi-channel
 *
 * The multi-channel form sends ONE confirmation email listing every
 * pending channel, so the user does not get N separate emails for one
 * sign-up that happened to tick N boxes.
 *
 * CHANNELS THIS ENDPOINT WILL WRITE: top-level lists only. Scoped channels
 * (`cohort:<runId>`, `track:<id>`) are server-managed membership claims and are
 * refused here whoever is asking — see `isServerManagedChannel` in
 * lib/firestore/subscriptions.ts, which carries the reasoning.
 *
 * Anti-enumeration discipline: every non-validation outcome returns
 * `{ ok: true, status: 200 }`. The caller cannot tell the difference
 * between fresh signup, already-subscribed, in-cooldown, or
 * suppressed-address, all return identical bodies. Validation failures
 * still return 400 (so the form can show an inline error), since
 * malformed input isn't an enumeration risk.
 */

const COOLDOWN_SECONDS = 60;
const CONFIRM_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year for public unsub links
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LEN = 200;
const NAME_MAX_LEN = 80;
const MAX_CHANNELS_PER_CALL = 10;

type Body = {
  email?: unknown;
  channel?: unknown;
  channels?: unknown;
  source?: unknown;
  /**
   * Optional first / preferred name. Stored on the subscription row for
   * admin visibility and used by the welcome and "added" emails to greet
   * the recipient by name. Trimmed and length-capped before storage.
   */
  name?: unknown;
};

type ApiResult =
  | { ok: true; kind?: "confirmation-sent" | "added" }
  | { error: string };

export async function POST(req: Request): Promise<NextResponse<ApiResult>> {
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

  // Coerce body's `channels` (preferred) or `channel` (legacy) into a
  // deduped, validated list. Reject empty / oversize lists.
  const channels = collectChannels(parsed);
  if (channels.length === 0) {
    return NextResponse.json(
      { error: "Pick at least one list to subscribe to." },
      { status: 400 },
    );
  }
  if (channels.length > MAX_CHANNELS_PER_CALL) {
    return NextResponse.json(
      { error: "Too many channels in one request." },
      { status: 400 },
    );
  }
  for (const c of channels) {
    // A server-managed channel (`cohort:<runId>`, `track:<id>`) is a MEMBERSHIP
    // CLAIM, and this endpoint is the one place in the estate that takes a
    // channel string from an unauthenticated stranger. Refused with the same
    // message a malformed channel gets, so the response says nothing about
    // which cohorts exist. See `isServerManagedChannel` for the full argument.
    if (!isValidChannel(c) || isServerManagedChannel(c)) {
      return NextResponse.json(
        { error: `Invalid subscription channel: ${c}` },
        { status: 400 },
      );
    }
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

  // Suppression list: silently succeed. We do NOT differentiate this case;
  // exposing "your address bounced previously" via a distinct status would
  // leak which addresses have prior interaction history with us.
  if (await isSuppressed(db, email)) {
    return NextResponse.json({ ok: true });
  }

  // Per-email cooldown floor across all channels in this call. We treat
  // any recent attempt on any of the requested rows as cooldown'd; this
  // stops mailbomb-style abuse where someone repeatedly POSTs the same
  // email + channel mix.
  const cooldownCutoffMs = Timestamp.now().toMillis() - COOLDOWN_SECONDS * 1000;
  for (const channel of channels) {
    const ref = db
      .collection("subscriptions")
      .doc(subscriptionDocId({ email, channel }));
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as { lastAttemptAt?: Timestamp } | undefined;
      const last = data?.lastAttemptAt;
      if (last && last.toMillis() > cooldownCutoffMs) {
        return NextResponse.json({ ok: true });
      }
    }
  }

  // Decide whether this caller has proven control of THIS email. True only
  // when a signed-in user is subscribing one of their own verified emails.
  // A logged-out caller, or a signed-in member subscribing some other
  // address, falls through to the guest double-opt-in flow. This is what
  // stops anyone confirming an address they don't control, and stops the
  // homepage form minting `audience: "user"` rows for emails that aren't
  // the user's (the source of stale "ghost" rows in the admin tab).
  const session = await getCurrentUser();
  let inboxProven = false;
  if (session) {
    const userSnap = await db.collection("users").doc(session.uid).get();
    const userData = userSnap.data() ?? {};
    const verified = getVerifiedEmails({
      email:
        typeof userData.email === "string" ? userData.email : session.email,
      profile: (userData.profile ?? {}) as {
        universityEmail?: unknown;
        uniEmailVerifiedAt?: unknown;
      },
    }).map((v) => v.email);
    inboxProven = verified.includes(email);
  }
  const audience: "user" | "guest" = inboxProven ? "user" : "guest";
  const audienceId =
    inboxProven && session ? session.uid : emailDocId(email);
  const actor: SubscriptionActor = session
    ? { kind: "member", uid: session.uid, label: "homepage signup form" }
    : { kind: "guest", label: "homepage signup form" };

  // Run subscribe() for each requested channel. Aggregate the results so
  // we can decide which emails to send.
  const channelsNeedingConfirmation: string[] = [];
  const channelsNewlyAddedConfirmed: string[] = [];
  for (const channel of channels) {
    let result;
    try {
      result = await subscribe(db, {
        email,
        channel,
        audience,
        audienceId,
        inboxProven,
        actor,
        source,
        name,
      });
    } catch (err) {
      console.error("[/api/subscriptions] subscribe failed", email, channel, err);
      return NextResponse.json(
        { error: "Could not save subscription" },
        { status: 500 },
      );
    }
    if (result.requiresConfirmation) {
      channelsNeedingConfirmation.push(channel);
    } else if (result.newlyAddedChannel) {
      channelsNewlyAddedConfirmed.push(channel);
    }
    // Otherwise: nothing changed (already-confirmed, already-subscribed),
    // silent success.
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const replyTo = process.env.EMAIL_DEFAULT_REPLY_TO;

  // Confirmation path: send ONE email listing every channel that needs
  // confirmation. Once they click, `confirmAllForEmail` flips every
  // pending row in one go.
  if (channelsNeedingConfirmation.length > 0) {
    const confirmToken = signToken(
      { s: "public-confirm", e: email },
      CONFIRM_TOKEN_TTL_SECONDS,
    );
    const confirmUrl = `${appUrl}/api/subscriptions/confirm?t=${encodeURIComponent(confirmToken)}`;

    // Use the first pending channel for the RFC 8058 List-Unsubscribe
    // header. The user can fully drop the address by clicking the per-
    // channel unsub links once they're confirmed.
    const headerChannel = channelsNeedingConfirmation[0];
    const headerUnsubToken = signToken(
      { s: "unsubscribe", email, c: headerChannel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const headerUnsubUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(headerUnsubToken)}`;

    try {
      await sendEmail({
        to: email,
        subject: "Confirm your NAISI subscription",
        react: SubscriptionConfirmEmail({
          confirmUrl,
          channels: channelsNeedingConfirmation,
          expiresInHours: Math.round(CONFIRM_TOKEN_TTL_SECONDS / 3600),
          unsubUrl: headerUnsubUrl,
          name,
        }),
        kind: "subscription-confirm",
        referenceId: emailDocId(email),
        listUnsubscribe: { url: headerUnsubUrl, mailto: replyTo },
      });
    } catch (err) {
      console.error("[/api/subscriptions] confirm send failed", email, err);
      return NextResponse.json(
        { error: "Couldn't send confirmation. Try again." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, kind: "confirmation-sent" });
  }

  // No confirmation needed (email already proven). For each channel that
  // was actually newly attached this call, send a low-key "added" notice.
  // Multiple sends here are rare in practice (only when a confirmed user
  // ticks several brand-new channels at once), so the simple per-channel
  // loop is fine.
  for (const channel of channelsNewlyAddedConfirmed) {
    const unsubToken = signToken(
      { s: "unsubscribe", email, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(unsubToken)}`;
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
      // Don't propagate. The row is already saved as confirmed; missing
      // a receipt email is acceptable degradation.
      console.warn("[/api/subscriptions] added-notice send failed", email, channel, err);
    }
  }

  if (channelsNewlyAddedConfirmed.length > 0) {
    return NextResponse.json({ ok: true, kind: "added" });
  }
  return NextResponse.json({ ok: true });
}

function collectChannels(body: Body): string[] {
  const out = new Set<string>();
  if (Array.isArray(body.channels)) {
    for (const c of body.channels) {
      if (typeof c === "string" && c.length > 0) out.add(c);
    }
  }
  if (typeof body.channel === "string" && body.channel.length > 0) {
    out.add(body.channel);
  }
  return Array.from(out);
}

/** Used only as the SubscriptionAddedEmail subject line input. */
function friendlyForKind(channel: string): string {
  if (channel === "newsletter") return "our newsletter";
  if (channel === "events") return "event announcements";
  return channel;
}

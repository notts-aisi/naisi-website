import { NextResponse } from "next/server";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { markSendStatus } from "@/lib/firestore/emailSends";
import { addSuppression } from "@/lib/firestore/suppression";
import { verifySnsMessage, type SnsMessage } from "@/lib/sns/verify";

/**
 * Look up users whose primary Google email OR self-declared university email
 * matches an affected address, then patch them. Returns the per-user patch
 * shape controlled by `withdrawConsent`:
 *   - `true` (Complaint): flip `profile.newsletter.subscribed = false` (legal
 *     consent withdrawal under GDPR/PECR) plus the uni-email-was-suppressed
 *     flag if matched on uni email
 *   - `false` (Bounce): just stamp the uni-email-was-suppressed flag so the
 *     user's next uni-email change triggers the 24h rate-limit lock. Bounces
 *     don't imply withdrawn consent, so subscription stays as-is.
 */
async function applyUserSuppressionEffects(
  db: Firestore,
  email: string,
  withdrawConsent: boolean,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  const [byPrimary, byUni] = await Promise.all([
    db.collection("users").where("email", "==", normalized).get(),
    db.collection("users").where("profile.universityEmail", "==", normalized).get(),
  ]);
  const seen = new Set<string>();
  const patches: Array<Promise<unknown>> = [];
  for (const snap of [...byPrimary.docs, ...byUni.docs]) {
    if (seen.has(snap.id)) continue;
    seen.add(snap.id);
    const data = snap.data();
    const uniMatches =
      (data.profile?.universityEmail as string | undefined)?.toLowerCase() === normalized;
    const patch: Record<string, unknown> = {};
    if (withdrawConsent) {
      patch["profile.newsletter.subscribed"] = false;
    }
    if (uniMatches) {
      patch["profile.universityEmailWasSuppressed"] = true;
    }
    if (Object.keys(patch).length === 0) continue;
    patches.push(snap.ref.update(patch));
  }
  await Promise.all(patches);
}

/**
 * SNS webhook for SES bounce + complaint + delivery-delay events.
 *
 * Flow:
 *   1. Verify the SNS signature (rejects anything not signed by an AWS SNS cert).
 *   2. Auto-confirm SubscriptionConfirmation by GETting the SubscribeURL.
 *   3. On Notification, parse the SES payload and suppress any permanently
 *      bounced or complained-about addresses in the `suppressedEmails`
 *      Firestore collection. Transient delays are logged, not suppressed.
 */
export async function POST(req: Request) {
  let msg: SnsMessage;
  try {
    const text = await req.text();
    msg = JSON.parse(text) as SnsMessage;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const valid = await verifySnsMessage(msg).catch((err) => {
    console.warn("[ses-events] signature verify threw:", err);
    return false;
  });
  if (!valid) {
    console.warn("[ses-events] rejected — signature invalid", msg.MessageId);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (msg.Type === "SubscriptionConfirmation") {
    if (!msg.SubscribeURL) {
      return NextResponse.json({ error: "Missing SubscribeURL" }, { status: 400 });
    }
    const res = await fetch(msg.SubscribeURL);
    if (!res.ok) {
      console.error("[ses-events] SubscribeURL fetch failed", res.status);
      return NextResponse.json({ error: "Confirmation fetch failed" }, { status: 502 });
    }
    console.log("[ses-events] subscription confirmed", msg.TopicArn);
    return NextResponse.json({ ok: true });
  }

  if (msg.Type === "UnsubscribeConfirmation") {
    console.log("[ses-events] unsubscribe confirmation", msg.TopicArn);
    return NextResponse.json({ ok: true });
  }

  if (msg.Type !== "Notification") {
    return NextResponse.json({ ok: true });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(msg.Message) as Record<string, unknown>;
  } catch {
    console.warn("[ses-events] bad inner Message JSON", msg.MessageId);
    return NextResponse.json({ error: "Invalid Message JSON" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // SES events use either `eventType` (Event Publishing) or `notificationType`
  // (legacy feedback notifications). Support both.
  const kind = (event.eventType ?? event.notificationType) as string | undefined;

  // `mail.messageId` on the bounce/complaint envelope is the same SES id we
  // stash on emailSends rows at send time — use it to mark the specific
  // originating send, not every past send to the same address.
  const mail = event.mail as { messageId?: string } | undefined;
  const sesMessageId = mail?.messageId;

  if (kind === "Bounce") {
    const bounce = event.bounce as
      | {
          bounceType?: string;
          bounceSubType?: string;
          bouncedRecipients?: Array<{ emailAddress?: string }>;
        }
      | undefined;
    // Only Permanent bounces are suppressed; Transient and Undetermined are
    // retried by SES itself and may still deliver.
    if (bounce?.bounceType === "Permanent") {
      for (const r of bounce.bouncedRecipients ?? []) {
        if (!r.emailAddress) continue;
        await addSuppression(db, {
          email: r.emailAddress,
          reason: "bounce",
          subReason: bounce.bounceSubType,
          source: "ses-sns",
        });
        if (sesMessageId) {
          await markSendStatus(
            db,
            { sesMessageId, recipient: r.emailAddress },
            "bounced",
            bounce.bounceSubType,
          );
        }
        // Bounce = stamp the "was suppressed" flag but don't withdraw consent.
        await applyUserSuppressionEffects(db, r.emailAddress, false);
        console.log("[ses-events] suppressed (bounce):", r.emailAddress);
      }
    } else {
      console.log("[ses-events] transient bounce ignored:", bounce?.bounceType);
    }
  } else if (kind === "Complaint") {
    const complaint = event.complaint as
      | {
          complaintFeedbackType?: string;
          complainedRecipients?: Array<{ emailAddress?: string }>;
        }
      | undefined;
    for (const r of complaint?.complainedRecipients ?? []) {
      if (!r.emailAddress) continue;
      await addSuppression(db, {
        email: r.emailAddress,
        reason: "complaint",
        subReason: complaint?.complaintFeedbackType,
        source: "ses-sns",
      });
      if (sesMessageId) {
        await markSendStatus(
          db,
          { sesMessageId, recipient: r.emailAddress },
          "complained",
          complaint?.complaintFeedbackType,
        );
      }
      // Complaint = withdrawal of consent: flip subscribed=false AND flag
      // post-suppression for rate-limiting.
      await applyUserSuppressionEffects(db, r.emailAddress, true);
      console.log("[ses-events] suppressed (complaint):", r.emailAddress);
    }
  } else if (kind === "DeliveryDelay") {
    console.log("[ses-events] delivery delay:", event.delivery);
  } else {
    console.log("[ses-events] unhandled event kind:", kind);
  }

  return NextResponse.json({ ok: true });
}

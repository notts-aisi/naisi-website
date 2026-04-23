import "server-only";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { addSuppression } from "@/lib/firestore/suppression";

const REPLAY_TOLERANCE_SECONDS = 5 * 60;

function verifySvixSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignatureHeader = headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignatureHeader) return false;

  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > REPLAY_TOLERANCE_SECONDS) return false;

  const secretKey = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header can carry multiple signatures separated by spaces during key rotation.
  const candidates = svixSignatureHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));

  for (const cand of candidates) {
    const candBuf = Buffer.from(cand);
    if (candBuf.length !== expectedBuf.length) continue;
    if (crypto.timingSafeEqual(candBuf, expectedBuf)) return true;
  }
  return false;
}

// Duplicated from the SES route's local helper — factor to a shared module
// once either path grows past a trivial footprint.
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

type ResendWebhookBody = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; subType?: string; message?: string };
    suppressed?: { type?: string; message?: string };
    failed?: { reason?: string };
  };
};

/**
 * Resend webhook for email.bounced, email.complained, email.suppressed,
 * email.failed, and email.delivery_delayed. Mirrors the write path of the
 * SES SNS handler — permanent bounces, complaints, and provider-side
 * suppressions land in `suppressedEmails` and patch affected user docs.
 * Our-side `email.failed` is logged but not suppressed (the address is
 * innocent); transient delivery delays are logged only.
 */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[resend-events] RESEND_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const rawBody = await req.text();
  if (!verifySvixSignature(rawBody, req.headers, secret)) {
    console.warn("[resend-events] rejected — signature invalid");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: ResendWebhookBody;
  try {
    event = JSON.parse(rawBody) as ResendWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const kind = event.type;
  const recipients = event.data?.to ?? [];

  if (kind === "email.bounced") {
    // Only Permanent bounces are suppressed; Transient/Undetermined may still deliver on retry.
    const bounceType = event.data?.bounce?.type;
    if (bounceType !== "Permanent") {
      console.log("[resend-events] transient bounce ignored:", bounceType);
      return NextResponse.json({ ok: true });
    }
    for (const email of recipients) {
      if (!email) continue;
      await addSuppression(db, {
        email,
        reason: "bounce",
        subReason: event.data?.bounce?.subType,
        source: "resend-webhook",
      });
      await applyUserSuppressionEffects(db, email, false);
      console.log("[resend-events] suppressed (bounce):", email);
    }
  } else if (kind === "email.complained") {
    for (const email of recipients) {
      if (!email) continue;
      await addSuppression(db, {
        email,
        reason: "complaint",
        source: "resend-webhook",
      });
      await applyUserSuppressionEffects(db, email, true);
      console.log("[resend-events] suppressed (complaint):", email);
    }
  } else if (kind === "email.suppressed") {
    // Pre-emptive block from Resend's account-level suppression list. Treat
    // equivalent to a bounce but preserve the provider classification in
    // subReason — consent isn't assumed withdrawn here.
    for (const email of recipients) {
      if (!email) continue;
      await addSuppression(db, {
        email,
        reason: "bounce",
        subReason: event.data?.suppressed?.type,
        source: "resend-webhook",
      });
      await applyUserSuppressionEffects(db, email, false);
      console.log(
        "[resend-events] provider-suppressed:",
        email,
        event.data?.suppressed?.type,
      );
    }
  } else if (kind === "email.failed") {
    // Our-side failure — address is innocent, don't suppress. Loud log so the
    // silent-drop failure mode is at least visible in Cloud Run logs.
    console.error("[resend-events] send failed:", {
      email_id: event.data?.email_id,
      to: recipients,
      reason: event.data?.failed?.reason,
    });
  } else if (kind === "email.delivery_delayed") {
    console.log("[resend-events] delivery delay:", event.data?.email_id);
  } else {
    console.log("[resend-events] unhandled event type:", kind);
  }

  return NextResponse.json({ ok: true });
}

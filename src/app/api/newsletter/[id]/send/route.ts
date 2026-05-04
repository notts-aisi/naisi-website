import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import NewsletterEmail from "@/emails/NewsletterEmail";
import {
  bodyMarkdownToBlocks,
  personaliseBlocks,
  sanitizeBlocks,
  type Block,
} from "@/lib/firestore/newsletterBlocks";
import { filterSuppressed } from "@/lib/firestore/suppression";
import {
  addressesForSend,
  normaliseNotifications,
} from "@/lib/firestore/notifications";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";
import { signToken } from "@/lib/signedTokens";

type Ctx = RouteContext<"/api/newsletter/[id]/send">;

const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

type SubscriberRow = {
  /**
   * For member rows, the user's uid (used for legacy-shape unsub tokens
   * `{ uid, c }`). For guest rows, the empty string — guests use email-shape
   * tokens `{ email, c }` instead.
   */
  uid: string;
  audience: "user" | "guest";
  preferredName: string;
  /** Primary email — Google email for members, the only email for guests. */
  primaryEmail: string;
  addresses: string[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const canApprove =
    actor.role === "admin" || actor.permissions.approveNewsletter === true;
  if (!canApprove) {
    return NextResponse.json(
      { error: "Only admins or designated approvers can send newsletters." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const draftRef = db.collection("newsletterDrafts").doc(id);
  const draftSnap = await draftRef.get();
  if (!draftSnap.exists) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  const draft = draftSnap.data()!;
  if (draft.status !== "approved") {
    return NextResponse.json(
      { error: `Only approved drafts can be sent (current status: ${draft.status}).` },
      { status: 400 },
    );
  }

  const subject = (draft.subject as string)?.trim() ?? "";
  let blocks: Block[] = sanitizeBlocks(draft.blocks);
  if (blocks.length === 0) {
    const legacyMarkdown = (draft.bodyMarkdown as string) ?? "";
    blocks = bodyMarkdownToBlocks(legacyMarkdown);
  }
  if (!subject || blocks.length === 0) {
    return NextResponse.json(
      { error: "Draft is missing subject or body." },
      { status: 400 },
    );
  }

  // Source of truth: the `subscriptions` junction collection. Each
  // confirmed row for `channel == "newsletter"` becomes one recipient.
  // For member rows we hydrate the user doc to apply the existing
  // gmail/uniEmail channel-routing rules; for guest rows we use the row's
  // email directly (guests have one address, no channel routing).
  const recipients = await findRecipientsForChannel(db, "newsletter");

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  // Hydrate user audience rows once per uid to avoid duplicate user-doc
  // reads when a member somehow has multiple newsletter rows (shouldn't
  // happen post-PR-1, but defensive).
  const userIds = Array.from(
    new Set(
      recipients.filter((r) => r.audience === "user").map((r) => r.audienceId),
    ),
  );
  const userDocs = userIds.length
    ? await db.getAll(...userIds.map((uid) => db.collection("users").doc(uid)))
    : [];
  const userById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (const snap of userDocs) {
    if (snap.exists) userById.set(snap.id, snap);
  }

  // Dedup at the recipient level so a user with both a "user" row and an
  // accidental "guest" row (e.g. before claim ran) doesn't get two emails.
  const seenAudienceKeys = new Set<string>();

  const subscribers: SubscriberRow[] = [];
  for (const r of recipients) {
    const dedupKey = `${r.audience}:${r.audienceId}`;
    if (seenAudienceKeys.has(dedupKey)) continue;
    seenAudienceKeys.add(dedupKey);

    if (r.audience === "user") {
      const userSnap = userById.get(r.audienceId);
      if (!userSnap) continue;
      const data = userSnap.data() ?? {};
      const profile = (data.profile ?? {}) as Record<string, unknown>;
      const prefs = normaliseNotifications(profile);
      const gmailEmail = (data.email as string) ?? null;
      const universityEmail =
        (profile.universityEmail as string | undefined) ?? null;
      const addresses = addressesForSend({
        prefs,
        category: "newsletter",
        gmailEmail,
        universityEmail,
        gmailOnlyMode: gmailOnly,
      });
      if (addresses.length === 0) continue;
      subscribers.push({
        uid: userSnap.id,
        audience: "user",
        preferredName:
          (profile.preferredName as string | undefined) ||
          (data.displayName as string | undefined) ||
          "there",
        primaryEmail: gmailEmail ?? r.email,
        addresses,
      });
    } else {
      // Guest. One address, no preferred name on file.
      subscribers.push({
        uid: "",
        audience: "guest",
        preferredName: "there",
        primaryEmail: r.email,
        addresses: [r.email],
      });
    }
  }

  if (subscribers.length === 0) {
    return NextResponse.json(
      { error: "No subscribers to send to." },
      { status: 400 },
    );
  }

  const planned = subscribers.flatMap((s) => s.addresses);
  const { suppressed: suppressedList } = await filterSuppressed(db, planned);
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));

  let sentCount = 0;
  let suppressedCount = 0;
  const reachedUids = new Set<string>();
  const failures: Array<{ uid: string; address: string; error: string }> = [];

  for (const sub of subscribers) {
    const personalisedBlocks = personaliseBlocks(blocks, {
      preferredName: sub.preferredName,
    });

    // Members: token targets the user — flips the newsletter row(s) for both
    // their google email and uni email when they click. Guests: token
    // targets the email, flipping just their single newsletter row.
    const unsubToken =
      sub.audience === "user"
        ? signToken(
            { s: "unsubscribe", uid: sub.uid, c: "newsletter" },
            UNSUB_TOKEN_TTL_SECONDS,
          )
        : signToken(
            { s: "unsubscribe", email: sub.primaryEmail, c: "newsletter" },
            UNSUB_TOKEN_TTL_SECONDS,
          );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(unsubToken)}`;

    const reachKey = sub.audience === "user" ? sub.uid : `guest:${sub.primaryEmail}`;

    for (const address of sub.addresses) {
      if (suppressedSet.has(address.toLowerCase())) {
        suppressedCount += 1;
        console.log("[newsletter send] suppressed:", reachKey, address);
        continue;
      }
      try {
        await sendEmail({
          to: address,
          subject,
          react: NewsletterEmail({
            subject,
            blocks: personalisedBlocks,
            recipientName: sub.preferredName,
            unsubscribeUrl,
          }),
          kind: "newsletter",
          actorUid: actor.uid,
          referenceId: id,
          listUnsubscribe: {
            url: unsubscribeUrl,
            mailto: process.env.EMAIL_DEFAULT_REPLY_TO,
          },
        });
        sentCount += 1;
        reachedUids.add(reachKey);
        await sleep(200);
      } catch (err) {
        console.error("[newsletter send]", reachKey, address, err);
        failures.push({
          uid: reachKey,
          address,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  const subscribersReached = reachedUids.size;

  await draftRef.update({
    status: "sent",
    sentAt: new Date(),
    sentCount,
    subscribersReached,
    failedCount: failures.length,
    suppressedCount,
    gmailOnlyMode: gmailOnly,
    updatedAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    sentCount,
    subscribersReached,
    failedCount: failures.length,
    suppressedCount,
    gmailOnlyMode: gmailOnly,
    failures: failures.slice(0, 10),
  });
}

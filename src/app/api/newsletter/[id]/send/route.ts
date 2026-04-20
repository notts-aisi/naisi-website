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

type Ctx = RouteContext<"/api/newsletter/[id]/send">;

type SubscriberRow = {
  uid: string;
  preferredName: string;
  gmailEmail: string | null;
  universityEmail: string | null;
  deliverToGmail: boolean;
  deliverToUniEmail: boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function fallbackAddresses(s: SubscriberRow): string[] {
  const out: string[] = [];
  if (s.deliverToGmail && s.gmailEmail) out.push(s.gmailEmail);
  if (s.deliverToUniEmail && s.universityEmail) out.push(s.universityEmail);
  // Edge case: subscribed but no delivery box set — default to gmail.
  if (out.length === 0 && s.gmailEmail) out.push(s.gmailEmail);
  return out;
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
    // Legacy path: draft was authored before the block editor existed.
    const legacyMarkdown = (draft.bodyMarkdown as string) ?? "";
    blocks = bodyMarkdownToBlocks(legacyMarkdown);
  }
  if (!subject || blocks.length === 0) {
    return NextResponse.json(
      { error: "Draft is missing subject or body." },
      { status: 400 },
    );
  }

  // Fetch subscribers (admin SDK, bypasses client rules).
  const subSnap = await db
    .collection("users")
    .where("profile.newsletter.subscribed", "==", true)
    .get();

  const subscribers: SubscriberRow[] = subSnap.docs.map((d) => {
    const data = d.data();
    const nl = data.profile?.newsletter ?? {};
    return {
      uid: d.id,
      preferredName:
        (data.profile?.preferredName as string) ||
        (data.displayName as string) ||
        "there",
      gmailEmail: (data.email as string) ?? null,
      universityEmail: (data.profile?.universityEmail as string) ?? null,
      deliverToGmail: Boolean(nl.deliverToGmail),
      deliverToUniEmail: Boolean(nl.deliverToUniEmail),
    };
  });

  if (subscribers.length === 0) {
    return NextResponse.json(
      { error: "No subscribers to send to." },
      { status: 400 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const unsubscribeUrl = `${appUrl}/profile`;

  // Send one email per (subscriber, opted-in address). Gmail Workspace rate limits
  // at roughly 150/min — a 200ms delay between sends is well under that even
  // if the subscriber list grows.
  let sentCount = 0; // total emails actually sent (addresses)
  const reachedUids = new Set<string>(); // distinct subscribers who got ≥1 email
  const failures: Array<{ uid: string; address: string; error: string }> = [];

  for (const sub of subscribers) {
    const personalisedBlocks = personaliseBlocks(blocks, sub.preferredName);

    for (const address of fallbackAddresses(sub)) {
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
        });
        sentCount += 1;
        reachedUids.add(sub.uid);
        await sleep(200);
      } catch (err) {
        console.error("[newsletter send]", sub.uid, address, err);
        failures.push({
          uid: sub.uid,
          address,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  const subscribersReached = reachedUids.size;

  // Mark as sent regardless of partial failures; the admin can see counts.
  await draftRef.update({
    status: "sent",
    sentAt: new Date(),
    sentCount,
    subscribersReached,
    failedCount: failures.length,
    updatedAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    sentCount,
    subscribersReached,
    failedCount: failures.length,
    failures: failures.slice(0, 10),
  });
}

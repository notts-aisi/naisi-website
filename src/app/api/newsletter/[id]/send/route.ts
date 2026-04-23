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
  wantsCategory,
} from "@/lib/firestore/notifications";
import { signToken } from "@/lib/signedTokens";

type Ctx = RouteContext<"/api/newsletter/[id]/send">;

const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

type SubscriberRow = {
  uid: string;
  preferredName: string;
  gmailEmail: string | null;
  universityEmail: string | null;
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

  // Pull every user; filter client-side. Filtering on the new notifications
  // shape via where() would miss un-migrated users, and the legacy-shape
  // where() would miss users saved under the new UI. One query + in-memory
  // normalise is simplest and stays correct across the migration window.
  const allUsers = await db.collection("users").get();

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  const subscribers: SubscriberRow[] = allUsers.docs.flatMap((d) => {
    const data = d.data();
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    const prefs = normaliseNotifications(profile);
    if (!wantsCategory(prefs, "newsletter")) return [];
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
    if (addresses.length === 0) return [];
    return [
      {
        uid: d.id,
        preferredName:
          (profile.preferredName as string | undefined) ||
          (data.displayName as string | undefined) ||
          "there",
        gmailEmail,
        universityEmail,
        addresses,
      },
    ];
  });

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

    // One unsubscribe token per (uid, newsletter). Reusing across recipient
    // inboxes for the same user is fine — the token targets the user, not
    // the address, and one-click unsub flips the category pref.
    const unsubToken = signToken(
      { s: "unsubscribe", uid: sub.uid, c: "newsletter" },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(unsubToken)}`;

    for (const address of sub.addresses) {
      if (suppressedSet.has(address.toLowerCase())) {
        suppressedCount += 1;
        console.log("[newsletter send] suppressed:", sub.uid, address);
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

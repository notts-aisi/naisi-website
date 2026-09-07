import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
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
import { sendPushToRowAudience } from "@/lib/push/rowAudience";
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
  // An early exit, not the gate: it saves resolving a whole mailing list for a
  // draft that cannot be sent. The claim transaction below re-reads the status
  // and is the only thing that decides whether this request sends.
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

  // A newsletter with nobody on its email list is a configuration error rather
  // than a send, so this stays a refusal. It does mean the PUSH leg never runs
  // on its own: the push audience is a different set of people, and there may
  // well be members holding the push cell while the mailing list is empty, but
  // a send that mailed nobody and notified forty phones would be reported as a
  // sent newsletter that most of its audience cannot read.
  if (subscribers.length === 0) {
    return NextResponse.json(
      { error: "No email subscribers to send to." },
      { status: 400 },
    );
  }

  /*
   * THE SEND CLAIM, and it is a claim rather than a check.
   *
   * The status gate at the top of this route reads `approved` and the write at
   * the bottom sets `sent`, with a send loop between them that takes minutes
   * and runs against App Hosting's 60s ceiling. Nothing joined those two, so
   * two approvers pressing Send at once both passed the gate and both mailed
   * the whole list, and a request killed part way through left the draft
   * `approved` with half the list already mailed, ready for a retry that
   * mailed them again. The push leg inherited both.
   *
   * So the draft is claimed the way `POST /api/events/[id]/publish` claims
   * `announcedAt`: one transaction re-reads it, requires `approved` and no
   * standing claim, and stamps `sendClaimedAt`. A second request loses that
   * race and is refused, whether it arrived a millisecond or an hour later.
   *
   * NO NEW STATUS. A `sending` state would have to be taught to
   * `firestore.rules`, the status union, the editor's badge and every list that
   * groups by status, for a window that lasts one request. A timestamp field is
   * invisible to all of them.
   *
   * A CLAIM THAT OUTLIVES ITS REQUEST IS DELIBERATELY STICKY. An interrupted
   * send leaves the field set and every retry refused, because the alternative
   * (expiring it after N minutes) is a rule that re-mails the list on the day a
   * send is slower than N. Clearing `sendClaimedAt` on the draft document is an
   * admin's decision, made once somebody has read the send log and knows who
   * already has the mail.
   */
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(draftRef);
    if (!snap.exists) return { ok: false as const, status: 404, error: "Draft not found" };
    const current = snap.data() ?? {};
    if (current.status !== "approved") {
      return {
        ok: false as const,
        status: 400,
        error: `Only approved drafts can be sent (current status: ${current.status}).`,
      };
    }
    if (current.sendClaimedAt) {
      return {
        ok: false as const,
        status: 409,
        error:
          "A send of this draft has already started, or was interrupted before it " +
          "finished. Ask an admin before trying again.",
      };
    }
    tx.update(draftRef, { sendClaimedAt: FieldValue.serverTimestamp() });
    return { ok: true as const };
  });
  if (!claim.ok) {
    return NextResponse.json({ error: claim.error }, { status: claim.status });
  }

  const planned = subscribers.flatMap((s) => s.addresses);
  const { suppressed: suppressedList } = await filterSuppressed(db, planned);
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));

  let sentCount = 0;
  let suppressedCount = 0;
  const reachedUids = new Set<string>();
  const failures: Array<{ uid: string; address: string; error: string }> = [];

  /*
   * THE PUSH LEG: the newsletter row's other column, and the notification the
   * cell on /profile has been storing an answer for since the grid landed.
   *
   * IT RUNS CONCURRENTLY WITH THE EMAIL LOOP, NOT AFTER IT, and that is a
   * budget decision rather than a tidiness one. The loop below is sequential
   * with a 200ms pause after every message, so it IS this request's wall
   * clock, and it already runs against App Hosting's `timeoutSeconds: 60`. A
   * push leg bolted on after it adds its own worst case (~34s at
   * `MAX_PUSH_ROWS`; `src/lib/push/rowAudience.ts` derives that figure and is
   * the authority for it) to the tightest number in the estate. Dispatched
   * alongside, the request costs the larger of the two rather than their sum.
   * The event announcement runs its two legs together for the same reason.
   *
   * ONCE PER SEND, UNDER THE CLAIM ABOVE. The push is inside the same claimed
   * window as the email, so the request that loses the race is refused before
   * either leg starts and an interrupted send's retry is refused with them.
   * The push has no claim and no retry path of its own, because it must not be
   * possible to re-notify without re-mailing or the other way round.
   *
   * A PUSH FAILURE MUST NEVER FAIL THE SEND. The helper swallows per-account
   * failures and now answers an unreadable collection with a refusal rather
   * than a rejection, so this catch is belt and braces: it costs one line and
   * it is what stands between an unforeseen throw and a delivered newsletter
   * reported as a 500 that invites somebody to send it again.
   */
  const pushLeg = sendPushToRowAudience(
    db,
    "newsletter",
    {
      title: "New NAISI newsletter",
      body: subject,
      // A newsletter has no web view: the only render of one is
      // `POST /api/newsletter/preview`, which is gated to drafters and
      // approvers, and /newsletter redirects a plain member to the dashboard.
      // So the destination is the member's own home rather than the message.
      // A subscription belongs to a browser profile and survives sign-out
      // (`lib/push/store.ts`), so the audience is devices whose last claimant
      // holds the cell, not signed-in sessions: a signed-out device lands on
      // the sign-in page. That is still this app and still the right door,
      // where the marketing homepage would say less and the drafter tool would
      // refuse them outright.
      url: "/dashboard",
    },
    { tag: "newsletter send", reference: id },
  ).catch((err) => {
    console.error("[newsletter send] push leg failed", id, err);
    return { pushed: 0, refusal: "The push notifications could not be sent." };
  });

  /**
   * The email leg, sequential and paced, exactly as it has always been.
   *
   * An arrow expression rather than a `function` declaration: a declaration is
   * hoisted, so TypeScript cannot know it runs after the sign-in check above
   * and `actor` reads as possibly null inside it.
   */
  const sendAllEmails = async (): Promise<void> => {
    for (const sub of subscribers) {
      const personalisedBlocks = personaliseBlocks(blocks, {
        preferredName: sub.preferredName,
      });

      // Members: token targets the user, so one click flips the newsletter
      // row(s) for both their google email and uni email. Guests: token targets
      // the email, flipping just their single newsletter row.
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
  };

  const [, push] = await Promise.all([sendAllEmails(), pushLeg]);

  const subscribersReached = reachedUids.size;

  await draftRef.update({
    status: "sent",
    sentAt: new Date(),
    sentCount,
    subscribersReached,
    // `pushedCount` beside `sentCount` on the draft and `pushed` in the
    // response body: each name matches the shape it sits in. Every counter
    // stored on a draft ends in `Count`, and `pushed` is what a push count is
    // called everywhere it is answered (`EventAnnouncementResult.pushed`,
    // which the publish route hands back verbatim).
    pushedCount: push.pushed,
    failedCount: failures.length,
    suppressedCount,
    gmailOnlyMode: gmailOnly,
    // The claim is spent the moment the status says `sent`, and `sent` is a
    // terminal state this route will not send from again. Deleting the field
    // rather than leaving the timestamp keeps one question answerable by
    // looking at the document: a draft carrying `sendClaimedAt` is a send that
    // never finished, and is the only case an admin has to decide about.
    sendClaimedAt: FieldValue.delete(),
    updatedAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    sentCount,
    subscribersReached,
    pushed: push.pushed,
    // Zero pushed has four meanings and only two of them are worth showing
    // (see `rowAudience.ts`), so the reason travels with the count instead of
    // the editor guessing from it.
    pushRefusal: push.refusal,
    failedCount: failures.length,
    suppressedCount,
    gmailOnlyMode: gmailOnly,
    failures: failures.slice(0, 10),
  });
}

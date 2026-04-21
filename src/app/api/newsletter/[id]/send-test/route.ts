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

type Ctx = RouteContext<"/api/newsletter/[id]/send-test">;

/**
 * Sends a test render of a draft to the signed-in editor's own mailboxes
 * (Firebase Auth email + Firestore profile.universityEmail). Bypasses
 * subscribe / delivery prefs — the editor asked to see both inboxes. Does
 * not flip the draft's status; safe to run repeatedly at any stage.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const allowed =
    actor.role === "admin" ||
    actor.permissions.draftNewsletter ||
    actor.permissions.approveNewsletter;
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const draftSnap = await db.collection("newsletterDrafts").doc(id).get();
  if (!draftSnap.exists) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  const draft = draftSnap.data()!;

  const subject = (draft.subject as string)?.trim() ?? "";
  let blocks: Block[] = sanitizeBlocks(draft.blocks);
  if (blocks.length === 0) {
    const legacyMarkdown = (draft.bodyMarkdown as string) ?? "";
    blocks = bodyMarkdownToBlocks(legacyMarkdown);
  }
  if (!subject || blocks.length === 0) {
    return NextResponse.json(
      { error: "Add a subject and at least one block before sending a test." },
      { status: 400 },
    );
  }

  const editorSnap = await db.collection("users").doc(actor.uid).get();
  const editor = editorSnap.data() ?? {};
  const preferredName =
    (editor.profile?.preferredName as string) ||
    actor.displayName ||
    "there";
  const personal = actor.email ?? (editor.email as string | null) ?? null;
  const university = (editor.profile?.universityEmail as string | null) ?? null;

  const addresses = [personal, university].filter(
    (a): a is string => typeof a === "string" && a.length > 0,
  );
  if (addresses.length === 0) {
    return NextResponse.json(
      {
        error:
          "No email addresses on file for your account. Add a university email to your profile or sign in with a Google account.",
      },
      { status: 400 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const unsubscribeUrl = `${appUrl}/profile`;
  const personalisedBlocks = personaliseBlocks(blocks, { preferredName });
  const testSubject = `[TEST] ${subject}`;

  const sentTo: string[] = [];
  const failures: Array<{ address: string; error: string }> = [];

  for (const address of addresses) {
    try {
      await sendEmail({
        to: address,
        subject: testSubject,
        react: NewsletterEmail({
          subject,
          blocks: personalisedBlocks,
          recipientName: preferredName,
          unsubscribeUrl,
        }),
      });
      sentTo.push(address);
    } catch (err) {
      console.error("[newsletter send-test]", address, err);
      failures.push({
        address,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  if (sentTo.length === 0) {
    return NextResponse.json(
      { error: "All test sends failed.", failures },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, sentTo, failures });
}

import { NextResponse } from "next/server";
import { render } from "@react-email/render";
import NewsletterEmail from "@/emails/NewsletterEmail";
import { sanitizeBlocks } from "@/lib/firestore/newsletterBlocks";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Renders the newsletter React Email template to HTML server-side and returns
 * it as text for the editor's iframe preview. Kept server-side deliberately —
 * pulling @react-email/render into the client bundle bogged down HMR and
 * broke evaluation on some refreshes.
 *
 * Gated to admins + drafters + approvers (same set as the editor itself).
 */
export async function POST(req: Request) {
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

  let payload: { subject?: string; blocks?: unknown; previewName?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subject = (payload.subject ?? "").toString() || "(no subject)";
  const blocks = sanitizeBlocks(payload.blocks);
  const previewName = (payload.previewName ?? "").toString() || "Alex";

  try {
    const html = await render(
      NewsletterEmail({
        subject,
        blocks,
        recipientName: previewName,
        unsubscribeUrl: "#",
        preheader: subject,
      }),
    );
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("[newsletter preview]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Render failed" },
      { status: 500 },
    );
  }
}

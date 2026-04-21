import { NextResponse } from "next/server";
import ApplicationEmail from "@/emails/ApplicationEmail";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  personaliseBlocks,
  personaliseString,
} from "@/lib/firestore/newsletterBlocks";
import {
  TEMPLATE_TRIGGER,
  buildTokens,
  isTemplateId,
  normalizeTemplate,
  resolveRecipients,
} from "@/lib/firestore/applicationEmails";

const CUSTOM_REASON_MAX = 2000;

/**
 * Unified transactional send route for application lifecycle emails. Body:
 *   { templateId, uid, customReason? }
 *
 * Auth branches by trigger:
 * - submitted: caller must be the applicant themselves (still 'pending')
 * - approved / rejected: caller must be an admin
 *
 * Errors are logged and returned but never block the user-facing flow —
 * callers are expected to fire-and-forget.
 */
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { templateId?: unknown; uid?: unknown; customReason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const templateId = body.templateId;
  const uid = body.uid;
  if (!isTemplateId(templateId)) {
    return NextResponse.json({ error: "Unknown template" }, { status: 400 });
  }
  if (typeof uid !== "string" || uid.length === 0) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }
  const customReason =
    typeof body.customReason === "string" ? body.customReason.slice(0, CUSTOM_REASON_MAX) : undefined;

  const trigger = TEMPLATE_TRIGGER[templateId];
  const isAdmin = actor.role === "admin";
  const isSelfSubmitted =
    trigger === "submitted" && actor.uid === uid && actor.role === "pending";
  if (!isAdmin && !isSelfSubmitted) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const [userSnap, templateSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("applicationEmailTemplates").doc(templateId).get(),
  ]);

  if (!userSnap.exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (!templateSnap.exists) {
    console.warn("[application-email send] template missing", templateId);
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const template = normalizeTemplate(templateSnap.id, templateSnap.data() ?? {});
  if (!template) {
    return NextResponse.json({ error: "Template is malformed" }, { status: 400 });
  }

  const userData = userSnap.data() ?? {};
  const profile = (userData.profile ?? {}) as {
    preferredName?: string;
    subject?: string;
    universityEmail?: string;
    status?: "employee" | "foundation" | "undergraduate" | "masters" | "phd" | "postdoc" | "other";
    statusOther?: string;
  };

  const recipients = resolveRecipients(
    {
      email: (userData.email as string | null | undefined) ?? null,
      profile: { universityEmail: profile.universityEmail ?? null },
    },
    template.recipients,
  );
  if (recipients.length === 0) {
    console.warn(
      "[application-email send] no deliverable address",
      templateId,
      uid,
    );
    return NextResponse.json(
      { ok: true, sentTo: [], failures: [{ reason: "no-address" }] },
      { status: 200 },
    );
  }

  const tokens = buildTokens(
    {
      email: (userData.email as string | null | undefined) ?? null,
      displayName: (userData.displayName as string | null | undefined) ?? null,
      profile,
    },
    customReason,
  );
  const subject = personaliseString(template.subject, tokens);
  const personalisedBlocks = personaliseBlocks(template.blocks, tokens);

  const sentTo: string[] = [];
  const failures: Array<{ address: string; error: string }> = [];

  for (const address of recipients) {
    try {
      await sendEmail({
        to: address,
        subject,
        react: ApplicationEmail({
          subject,
          blocks: personalisedBlocks,
          preheader: subject,
        }),
        fromName: template.fromName,
      });
      sentTo.push(address);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error("[application-email send]", templateId, uid, address, err);
      failures.push({
        address,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return NextResponse.json({ ok: true, sentTo, failures });
}

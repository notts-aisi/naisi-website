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
  buildTokens,
  isTemplateId,
  isValidTemplateDoc,
  normalizeTemplate,
} from "@/lib/firestore/applicationEmails";

type Ctx = RouteContext<"/api/admin/application-emails/[templateId]/send-test">;

/**
 * Sends the last-saved version of a template to the admin's own Google + uni
 * addresses. Bypasses the template's recipients modifier on purpose — the
 * admin wants to see both inboxes while iterating.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { templateId } = await ctx.params;
  if (!isTemplateId(templateId)) {
    return NextResponse.json({ error: "Unknown template" }, { status: 404 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const [templateSnap, actorSnap] = await Promise.all([
    db.collection("applicationEmailTemplates").doc(templateId).get(),
    db.collection("users").doc(actor.uid).get(),
  ]);

  if (!templateSnap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const template = normalizeTemplate(templateSnap.id, templateSnap.data() ?? {});
  if (!template || !isValidTemplateDoc(template)) {
    return NextResponse.json({ error: "Template is malformed" }, { status: 400 });
  }

  const actorData = actorSnap.data() ?? {};
  const profile = (actorData.profile ?? {}) as {
    preferredName?: string;
    subject?: string;
    universityEmail?: string;
    status?: "employee" | "foundation" | "undergraduate" | "masters" | "phd" | "postdoc" | "other";
    statusOther?: string;
  };

  const personal = actor.email ?? (actorData.email as string | null) ?? null;
  const university = profile.universityEmail ?? null;
  const addresses = [personal, university].filter(
    (a): a is string => typeof a === "string" && a.length > 0,
  );
  if (addresses.length === 0) {
    return NextResponse.json(
      {
        error:
          "No email addresses on file for your account. Add a university email to your profile.",
      },
      { status: 400 },
    );
  }

  const tokens = buildTokens(
    {
      email: personal,
      displayName: actor.displayName ?? null,
      profile,
    },
    templateId === "rejected-custom"
      ? "This is a sample custom rejection reason for testing."
      : undefined,
  );

  const subject = `[TEST] ${personaliseString(template.subject, tokens)}`;
  const personalisedBlocks = personaliseBlocks(template.blocks, tokens);

  const sentTo: string[] = [];
  const failures: Array<{ address: string; error: string }> = [];

  for (const address of addresses) {
    try {
      await sendEmail({
        to: address,
        subject,
        react: ApplicationEmail({
          subject: personaliseString(template.subject, tokens),
          blocks: personalisedBlocks,
          preheader: subject,
        }),
        fromName: template.fromName,
        kind: "application-test",
        actorUid: actor.uid,
        referenceId: templateId,
      });
      sentTo.push(address);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      failures.push({
        address,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  // Treat "all sends failed" as a hard error — otherwise the UI shows a green
  // "Test sent to ." (empty-array join) when actually nothing landed.
  if (sentTo.length === 0) {
    const reasons = failures.map((f) => `${f.address}: ${f.error}`).join("; ");
    return NextResponse.json(
      { error: `No emails delivered. ${reasons || "Unknown failure."}`, failures },
      { status: 500 },
    );
  }

  return NextResponse.json({ sentTo, failures });
}

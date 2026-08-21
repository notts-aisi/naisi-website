import { NextResponse } from "next/server";
import ApplicationEmail from "@/emails/ApplicationEmail";
import { courseSampleTokens } from "@/features/admin/emailDesigns/courseEmailSamples";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseTemplateDefaults,
  isCourseTemplateId,
  normalizeCourseTemplate,
} from "@/lib/firestore/courseEmails";
import {
  personaliseBlocks,
  personaliseString,
} from "@/lib/firestore/newsletterBlocks";

/**
 * Sends a course email template to the admin's own Google + university
 * addresses so they can proof it in a real inbox.
 *
 * Mirrors `/api/admin/application-emails/[templateId]/send-test` with one
 * behavioural difference that matters: template resolution is FALLBACK-FIRST,
 * exactly as `sendCourseApplicationEmail` does it. `courseEmailTemplates` has
 * no seed step, so "no doc" is a normal state and the defaults are what a real
 * send would use — a test that 404'd there would be testing the wrong thing.
 *
 * The email itself renders through the same `ApplicationEmail` component the
 * real course sends use, so what lands here is what an applicant gets.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ templateId: string }> },
) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { templateId } = await ctx.params;
  if (!isCourseTemplateId(templateId)) {
    return NextResponse.json({ error: "Unknown template" }, { status: 404 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const defaults = courseTemplateDefaults[templateId];
  let subject = defaults.subject;
  let blocks = defaults.blocks;
  let fromName: string | undefined;

  const [templateSnap, actorSnap] = await Promise.all([
    db.collection("courseEmailTemplates").doc(templateId).get(),
    db.collection("users").doc(actor.uid).get(),
  ]);

  if (templateSnap.exists) {
    const stored = normalizeCourseTemplate(templateSnap.id, templateSnap.data() ?? {});
    // A saved-but-empty template loses to the defaults here for the same reason
    // it does at send time: an admin who blanks the body should see the copy
    // that would actually go out, not an empty email.
    if (stored && stored.subject && stored.blocks.length > 0) {
      subject = stored.subject;
      blocks = stored.blocks;
      fromName = stored.fromName;
    }
  }

  const actorData = actorSnap.data() ?? {};
  const profile = (actorData.profile ?? {}) as {
    preferredName?: string;
    universityEmail?: string;
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

  const name =
    profile.preferredName?.trim() ||
    actor.displayName?.trim() ||
    (typeof actorData.displayName === "string" ? actorData.displayName : "") ||
    "Alex Taylor";
  const tokens = courseSampleTokens(templateId, name);

  const personalisedSubject = personaliseString(subject, tokens);
  const personalisedBlocks = personaliseBlocks(blocks, tokens);
  const testSubject = `[TEST] ${personalisedSubject}`;

  const sentTo: string[] = [];
  const failures: Array<{ address: string; error: string }> = [];

  for (const address of addresses) {
    try {
      await sendEmail({
        to: address,
        subject: testSubject,
        react: ApplicationEmail({
          subject: personalisedSubject,
          blocks: personalisedBlocks,
          preheader: testSubject,
        }),
        fromName,
        // A rehearsal of course mail that reached only its own sender — the
        // same thing `course-test` marks on the facilitator routes, so the
        // deliverability tab can tell every course test send from a real one.
        kind: "course-test",
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

  // "All sends failed" is a hard error — otherwise the editor shows a green
  // "Test sent to ." off an empty array join while nothing landed.
  if (sentTo.length === 0) {
    const reasons = failures.map((f) => `${f.address}: ${f.error}`).join("; ");
    return NextResponse.json(
      { error: `No emails delivered. ${reasons || "Unknown failure."}`, failures },
      { status: 500 },
    );
  }

  return NextResponse.json({ sentTo, failures });
}

import { NextResponse } from "next/server";
import AdmissionsReinstatedEmail from "@/emails/AdmissionsReinstatedEmail";
import AdmissionsSubmittedEmail from "@/emails/AdmissionsSubmittedEmail";
import ApplicationEmail from "@/emails/ApplicationEmail";
import CourseNudgeEmail from "@/emails/CourseNudgeEmail";
import {
  ADMISSIONS_PREVIEW_SAMPLE,
  courseSampleTokens,
  courseTemplateUsesAdmissionsTokens,
} from "@/features/admin/emailDesigns/courseEmailSamples";
import {
  courseNudgeTokensFrom,
  renderCourseNudge,
  COURSE_NUDGE_TEMPLATE_ID,
} from "@/lib/email/courseNudgeEmail";
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
  type Block,
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
 * Six of the nine templates render through the same `ApplicationEmail`
 * component the real course sends use, so what lands here is what an applicant
 * gets. THREE HAVE THEIR OWN COMPONENT AND ARE RENDERED THROUGH IT, for the
 * same reason in each case: that is the one implementation the recipient
 * receives, footer and degradation rules included, and a rehearsal that
 * rendered it any other way would be proofing an email nobody gets. The weekly
 * nudge goes through `renderCourseNudge` into `CourseNudgeEmail`; the two
 * admissions receipts go through `AdmissionsSubmittedEmail` and
 * `AdmissionsReinstatedEmail`. Keep this count honest when a template is added.
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

  // The nudge's own renderer, or the shared lifecycle pass. `renderCourseNudge`
  // does the substitution, the escaping, the drop-the-empty-sentence rule and
  // the subject tidy in one call — the same call the send route makes.
  const nudge =
    templateId === COURSE_NUDGE_TEMPLATE_ID
      ? renderCourseNudge({ subject, blocks }, courseNudgeTokensFrom(tokens))
      : null;

  const personalisedSubject = nudge
    ? nudge.subject
    : personaliseString(subject, tokens);
  const personalisedBlocks: Block[] = nudge
    ? nudge.blocks
    : personaliseBlocks(blocks, tokens);
  const testSubject = `[TEST] ${personalisedSubject}`;

  /**
   * The nudge's unsubscribe link is a SAMPLE. A real one is a signed token
   * scoped to one member and one run's cohort channel, and a rehearsal has
   * neither — so the footer proofs the copy and the shape without minting
   * anything that could flip a subscription row. Following it lands on the
   * unsubscribe page's "Invalid or expired link" state, which changes nothing.
   */
  /**
   * The admissions pair render through THEIR OWN components for the same
   * reason the nudge does: each carries a footer link back to the application,
   * and a rehearsal that went through `ApplicationEmail` would proof an email
   * nobody receives. The url is the sample one, so following it from a test
   * send lands on a round that does not exist rather than on the admin's own
   * application.
   */
  const admissions = courseTemplateUsesAdmissionsTokens(templateId)
    ? templateId === "admissions-submitted"
      ? AdmissionsSubmittedEmail({
          subject: personalisedSubject,
          blocks: personalisedBlocks,
          applicationUrl: ADMISSIONS_PREVIEW_SAMPLE.applicationUrl,
          preheader: testSubject,
        })
      : AdmissionsReinstatedEmail({
          subject: personalisedSubject,
          blocks: personalisedBlocks,
          applicationUrl: ADMISSIONS_PREVIEW_SAMPLE.applicationUrl,
          preheader: testSubject,
        })
    : null;

  const react = admissions
    ? admissions
    : nudge
    ? CourseNudgeEmail({
        subject: personalisedSubject,
        blocks: personalisedBlocks,
        unsubscribeUrl: `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")}/api/unsubscribe?t=sample-preview-token`,
        preheader: nudge.preheader || testSubject,
      })
    : ApplicationEmail({
        subject: personalisedSubject,
        blocks: personalisedBlocks,
        preheader: testSubject,
      });

  const sentTo: string[] = [];
  const failures: Array<{ address: string; error: string }> = [];

  for (const address of addresses) {
    try {
      await sendEmail({
        to: address,
        subject: testSubject,
        react,
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

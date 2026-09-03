import Link from "next/link";
import { getAdminDb } from "@/lib/firebase/admin";
import { ensureTemplatesSeeded } from "@/features/admin/emailDesigns/seedTemplates";
import Badge from "@/components/ui/Badge";
import {
  DEFAULT_LABELS,
  RECIPIENT_MODIFIER_LABELS,
  TEMPLATE_IDS,
  normalizeTemplate,
  type TemplateDoc,
  type TemplateId,
} from "@/lib/firestore/applicationEmails";
import {
  COURSE_DEFAULT_LABELS,
  COURSE_TEMPLATE_IDS,
  COURSE_TEMPLATE_TRIGGER,
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateDoc,
  type CourseTemplateId,
  type CourseTemplateTrigger,
} from "@/lib/firestore/courseEmails";
import styles from "@/features/admin/emailDesigns/EmailDesignsList.module.css";

export const dynamic = "force-dynamic";

export default async function EmailDesignsPage() {
  const db = getAdminDb();
  if (!db) {
    return (
      <p style={{ color: "var(--color-danger)" }}>
        Firebase Admin is not configured on this environment.
      </p>
    );
  }

  await ensureTemplatesSeeded(db);

  const [snap, courseSnap] = await Promise.all([
    db.collection("applicationEmailTemplates").get(),
    db.collection("courseEmailTemplates").get(),
  ]);
  const byId = new Map<TemplateId, TemplateDoc>();
  for (const doc of snap.docs) {
    const tpl = normalizeTemplate(doc.id, doc.data());
    if (tpl) byId.set(tpl.templateId, tpl);
  }

  // Course templates are deliberately NOT seeded: the send path is
  // fallback-first (courseApplicationEmails.ts uses `courseTemplateDefaults`
  // when the doc is missing, malformed, or empty), so an unedited template is a
  // normal steady state rather than a gap to fill in.
  const courseById = new Map<CourseTemplateId, CourseTemplateDoc>();
  for (const doc of courseSnap.docs) {
    const tpl = normalizeCourseTemplate(doc.id, doc.data());
    if (tpl) courseById.set(tpl.templateId, tpl);
  }

  const ordered: TemplateDoc[] = TEMPLATE_IDS.map(
    (id) =>
      byId.get(id) ?? {
        templateId: id,
        trigger: "submitted" as const,
        label: DEFAULT_LABELS[id],
        subject: "",
        blocks: [],
        recipients: "both" as const,
      },
  );

  const submitted = ordered.filter((t) => t.trigger === "submitted");
  const approved = ordered.filter((t) => t.trigger === "approved");
  const rejected = ordered.filter((t) => t.trigger === "rejected");

  return (
    <div style={{ width: "100%", maxWidth: "60rem", margin: "0 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          Boilerplate transactional emails sent automatically on membership application
          lifecycle events.
          Edit the subject, body and recipients for each template; rejection reasons are picked
          by the admin at reject time.
        </p>

        <Group heading="When an application is submitted" templates={submitted} />
        <Group heading="When an application is approved" templates={approved} />
        <Group heading="Rejection reasons" templates={rejected} />
        <CourseGroup byId={courseById} />
      </div>
    </div>
  );
}

const COURSE_TRIGGER_LABELS: Record<CourseTemplateTrigger, string> = {
  submitted: "On apply",
  accepted: "On accept",
  waitlisted: "On waitlist",
  rejected: "On reject",
  allocated: "On placement",
  "week-nudge": "Each week",
  "dropped-out": "On leaving",
  "admissions-submitted": "On submitting",
  "admissions-reinstated": "On reopening",
  "admissions-deadline-reminder": "Before the deadline",
  "admissions-appointed": "On appointment",
  "admissions-declined": "On declining a facilitator",
};

function CourseGroup({ byId }: { byId: Map<CourseTemplateId, CourseTemplateDoc> }) {
  return (
    <section className={styles.group}>
      <h2 className={styles.groupHeader}>Course and admissions emails</h2>
      <p
        style={{
          color: "var(--color-text-muted)",
          fontSize: "var(--text-sm)",
          margin: 0,
        }}
      >
        Sent to people applying to an admissions round, and to learners across
        a course run. Any template you haven&apos;t edited sends NAISI&apos;s
        default copy: nothing is broken until you touch it, and you can always
        reset back.
      </p>
      {COURSE_TEMPLATE_IDS.map((id) => {
        const stored = byId.get(id);
        const subject = stored?.subject || courseTemplateDefaults[id].subject;
        return (
          <Link
            key={id}
            href={`/admin/email-designs/course/${id}`}
            className={styles.card}
          >
            <p className={styles.cardTitle}>
              {stored?.label || COURSE_DEFAULT_LABELS[id]}
            </p>
            <p className={styles.cardSubject}>{subject}</p>
            {/* alignItems inline: the shared .cardMeta row is text-only
                elsewhere, and a stretched Badge next to a line of text reads as
                a misaligned pill. */}
            <div className={styles.cardMeta} style={{ alignItems: "center" }}>
              <Badge tone={stored ? "accent" : "neutral"}>
                {COURSE_TRIGGER_LABELS[COURSE_TEMPLATE_TRIGGER[id]]}
              </Badge>
              <span>
                {stored?.updatedAt
                  ? `Edited ${stored.updatedAt.toLocaleDateString()}`
                  : "Using defaults"}
              </span>
            </div>
          </Link>
        );
      })}
    </section>
  );
}

function Group({ heading, templates }: { heading: string; templates: TemplateDoc[] }) {
  if (templates.length === 0) return null;
  return (
    <section className={styles.group}>
      <h2 className={styles.groupHeader}>{heading}</h2>
      {templates.map((t) => (
        <Link
          key={t.templateId}
          href={`/admin/email-designs/${t.templateId}`}
          className={styles.card}
        >
          <p className={styles.cardTitle}>{t.label}</p>
          <p className={styles.cardSubject}>{t.subject || "(no subject set)"}</p>
          <div className={styles.cardMeta}>
            <span>Sends to: {RECIPIENT_MODIFIER_LABELS[t.recipients]}</span>
            {t.updatedAt ? (
              <span>Updated {t.updatedAt.toLocaleDateString()}</span>
            ) : null}
          </div>
        </Link>
      ))}
    </section>
  );
}

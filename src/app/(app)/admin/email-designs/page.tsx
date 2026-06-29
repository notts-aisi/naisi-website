import Link from "next/link";
import { getAdminDb } from "@/lib/firebase/admin";
import { ensureTemplatesSeeded } from "@/features/admin/emailDesigns/seedTemplates";
import {
  DEFAULT_LABELS,
  RECIPIENT_MODIFIER_LABELS,
  TEMPLATE_IDS,
  normalizeTemplate,
  type TemplateDoc,
  type TemplateId,
} from "@/lib/firestore/applicationEmails";
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

  const snap = await db.collection("applicationEmailTemplates").get();
  const byId = new Map<TemplateId, TemplateDoc>();
  for (const doc of snap.docs) {
    const tpl = normalizeTemplate(doc.id, doc.data());
    if (tpl) byId.set(tpl.templateId, tpl);
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
          Boilerplate transactional emails sent automatically on application lifecycle events.
          Edit the subject, body and recipients for each template; rejection reasons are picked
          by the admin at reject time.
        </p>

        <Group heading="When an application is submitted" templates={submitted} />
        <Group heading="When an application is approved" templates={approved} />
        <Group heading="Rejection reasons" templates={rejected} />
      </div>
    </div>
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

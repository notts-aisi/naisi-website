import "server-only";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  TEMPLATE_IDS,
  TEMPLATE_TRIGGER,
  templateDefaults,
  type TemplateId,
} from "@/lib/firestore/applicationEmails";

const COLLECTION = "applicationEmailTemplates";

/**
 * Idempotent upsert of default templates. Creates any missing doc with its
 * boilerplate defaults; leaves existing docs untouched (so admin edits are
 * preserved). Safe to call on every admin page load.
 */
export async function ensureTemplatesSeeded(db: Firestore): Promise<void> {
  const col = db.collection(COLLECTION);
  const snap = await col.get();
  const existing = new Set(snap.docs.map((d) => d.id));

  const missing: TemplateId[] = TEMPLATE_IDS.filter((id) => !existing.has(id));
  if (missing.length === 0) return;

  const batch = db.batch();
  for (const id of missing) {
    const defaults = templateDefaults[id];
    batch.set(col.doc(id), {
      templateId: id,
      trigger: TEMPLATE_TRIGGER[id],
      label: defaults.label,
      subject: defaults.subject,
      blocks: defaults.blocks,
      recipients: defaults.recipients,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "system-seed",
    });
  }
  await batch.commit();
}

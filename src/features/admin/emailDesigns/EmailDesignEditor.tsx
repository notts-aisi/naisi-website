"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import {
  DEFAULT_LABELS,
  RECIPIENT_MODIFIER_LABELS,
  SUBJECT_MAX,
  normalizeTemplate,
  type RecipientModifier,
  type TemplateDoc,
  type TemplateId,
} from "@/lib/firestore/applicationEmails";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import EmailPreview from "@/features/newsletter/editor/EmailPreview";
import styles from "./EmailDesignEditor.module.css";

type Props = {
  templateId: TemplateId;
};

type TestStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; addresses: string[] }
  | { kind: "error"; message: string };

/** Fake tokens used for the preview so admins see real substitutions. */
const PREVIEW_TOKENS: Record<string, string> = {
  preferredName: "Alex",
  firstName: "Alex",
  fullName: "Alex Taylor",
  fieldOfStudy: "Computer Science",
  statusLabel: "Undergraduate",
  customReason:
    "After reviewing your application we weren't able to approve it at this time.",
};

type Overrides = {
  subject?: string;
  blocks?: Block[];
  recipients?: RecipientModifier;
};

export default function EmailDesignEditor({ templateId }: Props) {
  const { user } = useAuth();
  const [template, setTemplate] = useState<TemplateDoc | null>(null);
  const [loading, setLoading] = useState(true);

  // Local edits layered on top of the server snapshot. Empty == no unsaved
  // changes. Deriving display values this way avoids the setState-in-effect
  // hydration anti-pattern.
  const [overrides, setOverrides] = useState<Overrides>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "applicationEmailTemplates", templateId),
      (snap) => {
        if (!snap.exists()) {
          setTemplate(null);
          setLoading(false);
          return;
        }
        const next = normalizeTemplate(snap.id, snap.data());
        if (!next) {
          setLoading(false);
          return;
        }
        setTemplate(next);
        setLoading(false);
      },
      (err) => {
        console.error("[email design] snapshot", err);
        setError(err.message);
        setLoading(false);
      },
    );
    return unsub;
  }, [templateId]);

  const subject = overrides.subject ?? template?.subject ?? "";
  const blocks = overrides.blocks ?? template?.blocks ?? [];
  const recipients = overrides.recipients ?? template?.recipients ?? "both";

  const setSubject = (v: string) => setOverrides((o) => ({ ...o, subject: v }));
  const setBlocksOverride = (v: Block[]) => setOverrides((o) => ({ ...o, blocks: v }));
  const setRecipients = (v: RecipientModifier) =>
    setOverrides((o) => ({ ...o, recipients: v }));

  const dirty = useMemo(() => {
    if (!template) return false;
    if (overrides.subject !== undefined && overrides.subject !== template.subject) return true;
    if (overrides.recipients !== undefined && overrides.recipients !== template.recipients) return true;
    if (overrides.blocks !== undefined && JSON.stringify(overrides.blocks) !== JSON.stringify(template.blocks)) return true;
    return false;
  }, [template, overrides]);

  async function handleSave() {
    if (!user || !template) return;
    setBusy(true);
    setError(null);
    try {
      const db = getClientDb();
      await updateDoc(doc(db, "applicationEmailTemplates", templateId), {
        subject: subject.trim(),
        blocks,
        recipients,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      });
      setOverrides({});
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function handleRevert() {
    setOverrides({});
    setError(null);
  }

  async function handleSendTest() {
    if (dirty) return;
    setTestStatus({ kind: "sending" });
    try {
      const res = await fetch(
        `/api/admin/application-emails/${templateId}/send-test`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Send failed (${res.status})`);
      }
      const body = (await res.json()) as { sentTo: string[] };
      setTestStatus({ kind: "sent", addresses: body.sentTo });
    } catch (err) {
      setTestStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Send failed",
      });
    }
  }

  if (loading) {
    return <p style={{ color: "var(--color-text-muted)" }}>Loading template…</p>;
  }
  if (!template) {
    return (
      <Card padding="lg">
        <p>
          This template doesn&apos;t exist in Firestore yet. Visit the Email designs list to
          trigger the seed, then come back here.
        </p>
      </Card>
    );
  }

  const subjectOver = subject.length > SUBJECT_MAX;

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{DEFAULT_LABELS[templateId]}</h2>
          <p className={styles.tokenHint}>
            Tokens you can use in the subject + body:{" "}
            <code>{"{firstName}"}</code>, <code>{"{fullName}"}</code>,{" "}
            <code>{"{preferredName}"}</code>, <code>{"{fieldOfStudy}"}</code>,{" "}
            <code>{"{statusLabel}"}</code>
            {templateId === "rejected-custom" ? (
              <>
                , <code>{"{customReason}"}</code>
              </>
            ) : null}
          </p>
        </div>
        {dirty ? (
          <Badge tone="warning">Unsaved changes</Badge>
        ) : (
          <Badge tone="neutral">Saved</Badge>
        )}
      </header>

      <div className={styles.grid}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Field
            id="email-subject"
            label="Subject"
            hint={`${subject.length}/${SUBJECT_MAX} characters`}
            error={subjectOver ? "Subject is too long." : undefined}
          >
            <Input
              id="email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={SUBJECT_MAX + 20}
              placeholder="Welcome to NAISI, {firstName}"
            />
          </Field>

          <Field
            id="email-recipients"
            label="Send this email to"
            hint="Which of the two addresses on file should receive this message."
          >
            <Select
              id="email-recipients"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value as RecipientModifier)}
            >
              {(Object.keys(RECIPIENT_MODIFIER_LABELS) as RecipientModifier[]).map((key) => (
                <option key={key} value={key}>
                  {RECIPIENT_MODIFIER_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>

          <BlockEditor
            draftId={templateId}
            storagePrefix={`application-emails/${templateId}`}
            blocks={blocks}
            onChange={setBlocksOverride}
            disabled={busy}
          />

          <div className={styles.actions}>
            <Button variant="primary" onClick={handleSave} disabled={busy || !dirty || subjectOver}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={handleRevert} disabled={busy || !dirty}>
              Revert
            </Button>
            <Button
              variant="secondary"
              onClick={handleSendTest}
              disabled={dirty || testStatus.kind === "sending"}
            >
              {testStatus.kind === "sending" ? "Sending test…" : "Send test to me"}
            </Button>
            {savedFlash && <span className={`${styles.statusLine} ${styles.statusSuccess}`}>Saved.</span>}
            {dirty && (
              <span className={styles.statusLine}>
                Save your changes to send a test.
              </span>
            )}
            {error && <span className={`${styles.statusLine} ${styles.statusError}`}>{error}</span>}
            {testStatus.kind === "sent" && testStatus.addresses.length > 0 && (
              <span className={`${styles.statusLine} ${styles.statusSuccess}`}>
                Test sent to {testStatus.addresses.join(", ")}.
              </span>
            )}
            {testStatus.kind === "sent" && testStatus.addresses.length === 0 && (
              <span className={`${styles.statusLine} ${styles.statusError}`}>
                Test reported as sent but no addresses came back — check server logs.
              </span>
            )}
            {testStatus.kind === "error" && (
              <span className={`${styles.statusLine} ${styles.statusError}`}>
                {testStatus.message}
              </span>
            )}
          </div>
        </div>

        <EmailPreview
          subject={subject || "(no subject)"}
          blocks={blocks}
          endpoint="/api/admin/application-emails/preview"
          extraPayload={{ tokens: PREVIEW_TOKENS }}
          hint="This is what a recipient sees. Tokens are shown with sample values so you can proof the substitution."
        />
      </div>
    </div>
  );
}

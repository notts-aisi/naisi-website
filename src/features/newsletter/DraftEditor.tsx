"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  DRAFT_STATUS_LABEL,
  SUBJECT_MAX,
  normalizeDraft,
  type DraftStatus,
  type NewsletterDraft,
} from "@/lib/firestore/newsletterDrafts";
import {
  bodyMarkdownToBlocks,
  type Block,
} from "@/lib/firestore/newsletterBlocks";
import {
  canApproveNewsletter,
  canDraftNewsletter,
} from "@/lib/firestore/users";
import {
  approveDraft,
  deleteDraft,
  rejectDraft,
  revertToDraft,
  submitDraftForReview,
  updateDraft,
} from "./draftMutations";
import BlockEditor from "@/components/blocks/BlockEditor";
import EmailPreview from "./editor/EmailPreview";
import styles from "../../app/(app)/newsletter/newsletter.module.css";

type Props = {
  draftId: string;
};

type Tab = "compose" | "preview";

function statusTone(status: DraftStatus): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "draft":
      return "neutral";
    case "pending":
      return "warning";
    case "approved":
      return "accent";
    case "sent":
      return "success";
    case "rejected":
      return "danger";
  }
}

export default function DraftEditor({ draftId }: Props) {
  const router = useRouter();
  const { user, role, permissions } = useAuth();
  const [draft, setDraft] = useState<NewsletterDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [subject, setSubject] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [tab, setTab] = useState<Tab>("compose");
  const [sendStatus, setSendStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; subscribers: number; emails: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [testStatus, setTestStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; addresses: string[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "newsletterDrafts", draftId),
      (snap) => {
        if (!snap.exists()) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const next = normalizeDraft(snap.id, snap.data());
        setDraft(next);
        setSubject((cur) => (dirty ? cur : next.subject));
        setBlocks((cur) => {
          if (dirty) return cur;
          if (next.blocks.length > 0) return next.blocks;
          // Legacy draft with only bodyMarkdown — auto-migrate on load.
          if (next.bodyMarkdown.trim()) return bodyMarkdownToBlocks(next.bodyMarkdown);
          return [];
        });
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setError(err.message);
        setLoading(false);
      },
    );
    return unsub;
    // Snapshot is intentionally not restarted when `dirty` changes; functional
    // setters above read the latest `dirty` via closure of setSubject/setBlocks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const viewer =
    role && (role === "admin" || role === "committee" || role === "member")
      ? { role, permissions }
      : null;
  const canDraft = viewer ? canDraftNewsletter(viewer) : false;
  const canApprove = viewer ? canApproveNewsletter(viewer) : false;

  const isAuthor = !!user && !!draft && draft.authorUid === user.uid;
  const status = draft?.status ?? "draft";
  const editable = useMemo(() => {
    if (!draft) return false;
    if (status === "sent") return false;
    if (status === "pending") return canApprove;
    if (status === "approved") return canApprove;
    return isAuthor || canApprove;
  }, [draft, status, canApprove, isAuthor]);

  const previewName = user?.displayName?.split(" ")[0] ?? "Alex";

  async function onSave() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await updateDraft(draft.id, { subject, blocks });
      setDirty(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitForReview() {
    if (!draft) return;
    if (!subject.trim() || blocks.length === 0) {
      setError("Add a subject and at least one block before submitting for review.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (dirty) await updateDraft(draft.id, { subject, blocks });
      await submitDraftForReview(draft.id);
      setDirty(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (dirty) await updateDraft(draft.id, { subject, blocks });
      await approveDraft(draft.id);
      setDirty(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!draft) return;
    if (!rejectNote.trim()) {
      setError("Leave a short note so the author knows what to change.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rejectDraft(draft.id, rejectNote);
      setRejectNote("");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevertToDraft() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await revertToDraft(draft.id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Could not revert");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!draft) return;
    const message =
      draft.status === "sent"
        ? "Permanently delete this sent edition? This removes the record but cannot recall emails that were already sent."
        : "Permanently delete this draft? This can't be undone.";
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      await deleteDraft(draft.id);
      router.push("/newsletter");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  }

  async function onSendTest() {
    if (!draft) return;
    setTestStatus({ kind: "sending" });
    try {
      // Flush pending edits first so the test reflects what's on screen.
      if (dirty) await updateDraft(draft.id, { subject, blocks });
      const res = await fetch(`/api/newsletter/${draft.id}/send-test`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; sentTo?: string[]; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setTestStatus({
          kind: "error",
          message: body?.error ?? `Test send failed (${res.status})`,
        });
        return;
      }
      setTestStatus({ kind: "sent", addresses: body.sentTo ?? [] });
      if (dirty) setDirty(false);
    } catch (err) {
      setTestStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Unknown test-send error",
      });
    }
  }

  async function onOpenPreview() {
    setPreviewBusy(true);
    try {
      const res = await fetch("/api/newsletter/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, blocks, previewName }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        setError(`Preview failed (${res.status})${msg ? `: ${msg.slice(0, 200)}` : ""}`);
        return;
      }
      const html = await res.text();
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const win = window.open(url, "_blank", "noopener,noreferrer");
      if (!win) {
        setError("Couldn't open preview — check your browser's popup blocker.");
      }
      // Revoke the URL after the new tab has had a chance to load it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview error");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function onSend() {
    if (!draft) return;
    if (
      !window.confirm(
        "Send this newsletter to every subscribed user, honouring their delivery prefs? You can't unsend.",
      )
    ) {
      return;
    }
    setSendStatus({ kind: "sending" });
    setError(null);
    try {
      const res = await fetch(`/api/newsletter/${draft.id}/send`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: true;
            sentCount?: number;
            subscribersReached?: number;
            failedCount?: number;
            error?: string;
          }
        | null;
      if (!res.ok || !body?.ok) {
        setSendStatus({
          kind: "error",
          message: body?.error ?? `Send failed (${res.status})`,
        });
        return;
      }
      setSendStatus({
        kind: "sent",
        subscribers: body.subscribersReached ?? 0,
        emails: body.sentCount ?? 0,
      });
    } catch (err) {
      setSendStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Unknown send error",
      });
    }
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading draft…</p>
      </Card>
    );
  }
  if (notFound || !draft) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>
          Draft not found. It may have been deleted.
        </p>
      </Card>
    );
  }

  if (status === "sent") {
    const canDelete = isAuthor || role === "admin";
    return (
      <div className={styles.editor}>
        <div className={styles.statusBar}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <Badge tone={statusTone(status)}>{DRAFT_STATUS_LABEL[status]}</Badge>
            <span className={styles.saveHint}>
              by {draft.authorDisplayName ?? "unknown"}
            </span>
            {draft.sentAt && (
              <span className={styles.saveHint}>
                · sent {draft.sentAt.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
            {draft.sentCount != null && (
              <span className={styles.saveHint}>
                ·{" "}
                {draft.subscribersReached != null
                  ? `${draft.subscribersReached} subscriber${draft.subscribersReached === 1 ? "" : "s"} (${draft.sentCount} email${draft.sentCount === 1 ? "" : "s"})`
                  : `${draft.sentCount} email${draft.sentCount === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
        </div>

        <EmailPreview subject={subject} blocks={blocks} previewName={previewName} />

        <TestAndPreviewBanner />

        {error && <p className={styles.danger}>{error}</p>}

        <div className={styles.editorActions}>
          <Button variant="ghost" onClick={onSendTest} disabled={testStatus.kind === "sending"}>
            {testStatus.kind === "sending" ? "Sending test…" : "Send test to me"}
          </Button>
          <Button variant="ghost" onClick={onOpenPreview} disabled={previewBusy}>
            {previewBusy ? "Opening…" : "Open preview in new tab"}
          </Button>
          <div className={styles.spacer} />
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              style={{
                padding: "0.45rem 0.75rem",
                fontSize: "var(--text-sm)",
                color: "var(--color-text-muted)",
                background: "transparent",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
              }}
            >
              {busy ? "Deleting…" : "Delete edition"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.statusBar}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Badge tone={statusTone(status)}>{DRAFT_STATUS_LABEL[status]}</Badge>
          <span className={styles.saveHint}>
            by {draft.authorDisplayName ?? "unknown"}
          </span>
          {draft.approvedBy && status !== "draft" && status !== "pending" && (
            <span className={styles.saveHint}>· approved</span>
          )}
        </div>
        <div className={styles.spacer} />
        {dirty && editable && <span className={styles.saveHint}>Unsaved changes</span>}
      </div>

      {status === "rejected" && draft.reviewerNotes && (
        <Card padding="md">
          <strong style={{ color: "var(--color-danger)" }}>Returned for revisions</strong>
          <p style={{ marginTop: "var(--space-2)", color: "var(--color-text)" }}>
            {draft.reviewerNotes}
          </p>
        </Card>
      )}

      <div className={styles.tabBar}>
        <button
          type="button"
          className={`${styles.tab} ${tab === "compose" ? styles.tabActive : ""}`}
          onClick={() => setTab("compose")}
        >
          Compose
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === "preview" ? styles.tabActive : ""}`}
          onClick={() => setTab("preview")}
        >
          Preview
        </button>
      </div>

      {tab === "compose" ? (
        <>
          <Card padding="lg">
            <Field id="subject" label="Subject line" hint="Shown in the recipient's inbox preview.">
              <Input
                id="subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setDirty(true);
                }}
                maxLength={SUBJECT_MAX}
                disabled={!editable || busy}
                placeholder="e.g. NAISI April update"
              />
            </Field>
          </Card>

          <BlockEditor
            draftId={draft.id}
            blocks={blocks}
            onChange={(next) => {
              setBlocks(next);
              setDirty(true);
            }}
            disabled={!editable || busy}
          />

          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", margin: 0 }}>
            Tip: you can personalise text anywhere by typing <code>{"{preferredName}"}</code> — it&apos;s
            replaced with each recipient&apos;s name at send time.
          </p>
        </>
      ) : (
        <EmailPreview subject={subject} blocks={blocks} previewName={previewName} />
      )}

      <TestAndPreviewBanner />

      {error && <p className={styles.danger}>{error}</p>}

      <div className={styles.editorActions}>
        <Button variant="ghost" onClick={onSendTest} disabled={testStatus.kind === "sending"}>
          {testStatus.kind === "sending" ? "Sending test…" : "Send test to me"}
        </Button>
        <Button variant="ghost" onClick={onOpenPreview} disabled={previewBusy}>
          {previewBusy ? "Opening…" : "Open preview in new tab"}
        </Button>

        {editable && (
          <Button onClick={onSave} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save draft"}
          </Button>
        )}

        {canDraft && (status === "draft" || status === "rejected") && isAuthor && (
          <Button variant="ghost" onClick={onSubmitForReview} disabled={busy}>
            Submit for review
          </Button>
        )}

        {canApprove && status === "pending" && (
          <>
            <Button onClick={onApprove} disabled={busy}>
              Approve
            </Button>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <Input
                id="rejectNote"
                placeholder="Reason to send back for revisions…"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                style={{ minWidth: "16rem" }}
              />
              <Button variant="ghost" onClick={onReject} disabled={busy}>
                Send back
              </Button>
            </div>
          </>
        )}

        {canApprove && status === "approved" && (
          <Button onClick={onSend} disabled={sendStatus.kind === "sending"}>
            {sendStatus.kind === "sending" ? "Sending…" : "Send now"}
          </Button>
        )}

        {canApprove && (status === "approved" || status === "pending") && (
          <Button variant="ghost" onClick={onRevertToDraft} disabled={busy}>
            Move back to draft
          </Button>
        )}

        <div className={styles.spacer} />

        {(isAuthor || role === "admin") && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            style={{
              padding: "0.45rem 0.75rem",
              fontSize: "var(--text-sm)",
              color: "var(--color-text-muted)",
              background: "transparent",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
            }}
          >
            Delete draft
          </button>
        )}
      </div>

      {sendStatus.kind === "sent" && (
        <Card padding="md">
          <p style={{ color: "var(--color-success)" }}>
            Sent to {sendStatus.subscribers} subscriber
            {sendStatus.subscribers === 1 ? "" : "s"} across {sendStatus.emails} email
            address{sendStatus.emails === 1 ? "" : "es"}.
          </p>
        </Card>
      )}
      {sendStatus.kind === "error" && (
        <Card padding="md">
          <p className={styles.danger}>Send failed: {sendStatus.message}</p>
        </Card>
      )}
    </div>
  );

  function TestAndPreviewBanner() {
    if (testStatus.kind === "sent") {
      return (
        <Card padding="md">
          <p style={{ color: "var(--color-success)", margin: 0 }}>
            Test email sent to {testStatus.addresses.join(" and ")}. Check your inbox
            (and spam folder).
          </p>
        </Card>
      );
    }
    if (testStatus.kind === "error") {
      return (
        <Card padding="md">
          <p className={styles.danger}>Test send failed: {testStatus.message}</p>
        </Card>
      );
    }
    return null;
  }
}

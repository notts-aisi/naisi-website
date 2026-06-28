"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import {
  STATUS_LABELS,
  subjectLabel,
  type NewsletterPrefs,
  type UserDoc,
} from "@/lib/firestore/users";
import {
  REJECTION_REASONS,
  type RejectionReasonKey,
} from "@/lib/firestore/applicationEmails";
import { approveUser, deleteUser, rejectUser } from "./adminMutations";
import RejectReasonPicker from "./emailDesigns/RejectReasonPicker";
import type { UniEmailHolder } from "./useUniEmailIndex";

function sendApplicationEmail(body: {
  templateId: string;
  uid: string;
  customReason?: string;
}) {
  fetch("/api/admin/application-emails/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.warn("[application email] fire-and-forget failed", err);
  });
}

function formatGraduation(isoMonth: string): string {
  const [y, m] = isoMonth.split("-");
  if (!y || !m) return isoMonth;
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatNewsletter(prefs: NewsletterPrefs): string {
  if (!prefs.subscribed) return "Not subscribed";
  const channels: string[] = [];
  if (prefs.deliverToGmail) channels.push("Google");
  if (prefs.deliverToUniEmail) channels.push("university");
  return channels.length ? `Subscribed — ${channels.join(" + ")}` : "Subscribed";
}

export default function ApprovalCard({
  user,
  uniEmailConflicts = [],
}: {
  user: UserDoc;
  /** Other accounts already holding this applicant's university email. */
  uniEmailConflicts?: UniEmailHolder[];
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRejectPicker, setShowRejectPicker] = useState(false);

  async function handleApprove() {
    setBusy("approve");
    setError(null);
    try {
      await approveUser(user.uid);
      sendApplicationEmail({ templateId: "application-approved", uid: user.uid });
    } catch (err) {
      console.error(err);
      setError("Failed to approve — try again.");
      setBusy(null);
    }
  }

  async function handleConfirmReject(
    reasonKey: RejectionReasonKey,
    customReason?: string,
  ) {
    setBusy("reject");
    setError(null);
    try {
      await rejectUser(user.uid, reasonKey);
      sendApplicationEmail({
        templateId: REJECTION_REASONS[reasonKey].templateId,
        uid: user.uid,
        customReason,
      });
      setShowRejectPicker(false);
    } catch (err) {
      console.error(err);
      setError("Failed to reject — try again.");
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Permanently delete ${user.displayName ?? user.email}? This removes their record and sign-in account. This can't be undone.`,
      )
    ) {
      return;
    }
    setBusy("delete");
    setError(null);
    try {
      await deleteUser(user.uid);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(null);
    }
  }

  const signedUp = user.createdAt
    ? user.createdAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "—";

  return (
    <Card padding="lg">
      <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-start" }}>
        <div
          aria-hidden
          style={{
            width: 48,
            height: 48,
            borderRadius: "var(--radius-pill)",
            background: user.photoURL
              ? `center/cover no-repeat url(${user.photoURL})`
              : "var(--color-surface-hover)",
            border: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {user.profile?.preferredName ?? user.displayName ?? "Unnamed"}
              </div>
              <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                {user.email}
              </div>
            </div>
            <Badge>Signed up {signedUp}</Badge>
          </div>

          {uniEmailConflicts.length > 0 && (
            <div
              style={{
                marginTop: "var(--space-4)",
                padding: "var(--space-3) var(--space-4)",
                background: "var(--color-danger-soft)",
                border: "1px solid var(--color-danger)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
              }}
            >
              <strong style={{ color: "var(--color-danger)" }}>
                University email already in use
              </strong>
              <ul style={{ margin: "var(--space-2) 0", paddingLeft: "1.2em" }}>
                {uniEmailConflicts.map((c) => (
                  <li key={c.uid}>
                    {c.displayName || "Unnamed"} ({c.role})
                    {c.verified ? " · verified" : " · not verified"}
                  </li>
                ))}
              </ul>
              <span style={{ color: "var(--color-text-muted)" }}>
                A university email belongs to one account. Approving this
                creates a duplicate. Reject it, or delete the older account if
                this person is re-registering.
              </span>
            </div>
          )}

          {user.profile && (
            <dl
              style={{
                marginTop: "var(--space-4)",
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "var(--space-2) var(--space-4)",
                fontSize: "var(--text-sm)",
              }}
            >
              {user.profile.universityEmail && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>Uni email</dt>
                  <dd
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      flexWrap: "wrap",
                    }}
                  >
                    <span>{user.profile.universityEmail}</span>
                    {user.profile.uniEmailVerifiedAt ? (
                      <Badge tone="success">Verified</Badge>
                    ) : (
                      <Badge tone="warning">Not verified — won&apos;t be emailed</Badge>
                    )}
                  </dd>
                </>
              )}
              {user.profile.status && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>At UoN</dt>
                  <dd>
                    {STATUS_LABELS[user.profile.status]}
                    {user.profile.status === "other" && user.profile.statusOther
                      ? ` — ${user.profile.statusOther}`
                      : ""}
                  </dd>
                </>
              )}
              {(user.profile.subject || user.profile.course) && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>
                    {subjectLabel(user.profile.status)}
                  </dt>
                  <dd>{user.profile.subject ?? user.profile.course}</dd>
                </>
              )}
              {user.profile.year && !user.profile.status && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>Year</dt>
                  <dd>{user.profile.year}</dd>
                </>
              )}
              {user.profile.expectedGraduation && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>Graduating</dt>
                  <dd>{formatGraduation(user.profile.expectedGraduation)}</dd>
                </>
              )}
              <dt style={{ color: "var(--color-text-muted)" }}>Motivation</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{user.profile.motivation}</dd>
              {user.profile.interests && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>Interests</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>{user.profile.interests}</dd>
                </>
              )}
              {user.profile.newsletter && (
                <>
                  <dt style={{ color: "var(--color-text-muted)" }}>Newsletter</dt>
                  <dd>{formatNewsletter(user.profile.newsletter)}</dd>
                </>
              )}
            </dl>
          )}

          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-5)", flexWrap: "wrap" }}>
            <Button onClick={handleApprove} disabled={busy !== null} size="sm">
              {busy === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button
              onClick={() => setShowRejectPicker((v) => !v)}
              disabled={busy !== null}
              variant="ghost"
              size="sm"
            >
              {showRejectPicker ? "Cancel reject" : "Reject…"}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={busy !== null}
              variant="ghost"
              size="sm"
              style={{ color: "var(--color-danger)", marginLeft: "auto" }}
            >
              {busy === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </div>
          {showRejectPicker && (
            <RejectReasonPicker
              onCancel={() => setShowRejectPicker(false)}
              onConfirm={handleConfirmReject}
              busy={busy === "reject"}
            />
          )}
          {error && (
            <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

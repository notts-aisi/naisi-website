"use client";

import { useState, type ReactNode } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import type { CollaboratorDoc } from "@/lib/firestore/collaborators";

const STATUS_BADGE: Record<
  CollaboratorDoc["status"],
  { tone: "accent" | "success" | "danger"; label: string }
> = {
  pending: { tone: "accent", label: "Pending" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <dt
        style={{
          fontSize: "var(--text-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--color-text-subtle)",
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, color: "var(--color-text)", fontSize: "var(--text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {children}
      </dd>
    </div>
  );
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: "var(--color-accent)", wordBreak: "break-all" }}
    >
      {href}
    </a>
  );
}

function VerifyPill({ verified }: { verified: boolean }) {
  const color = verified ? "var(--color-success)" : "var(--color-warning)";
  return (
    <span
      style={{
        marginLeft: "var(--space-2)",
        padding: "0 8px",
        borderRadius: "999px",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        color,
        border: `1px solid ${color}`,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {verified ? "✓ Email verified" : "Email unverified"}
    </span>
  );
}

export default function CollaboratorCard({
  collaborator,
  emailVerified,
  onApprove,
  onReject,
  onDelete,
  busy = false,
}: {
  collaborator: CollaboratorDoc;
  /** Live verification status from Firebase Auth (not the doc). undefined = not
   *  yet loaded; false = confirmed unverified; true = verified. */
  emailVerified?: boolean;
  onApprove: () => void | Promise<void>;
  onReject: (reason: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  busy?: boolean;
}) {
  const { application: app } = collaborator;
  const badge = STATUS_BADGE[collaborator.status];
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(collaborator.rejectionReason ?? "");

  // After a successful reject (or any decision) the snapshot flips the status;
  // close the reason editor so the normal action row renders again without a
  // manual page refresh. Render-time adjustment keyed on the previous status
  // (React's "adjust state on prop change" pattern) — no effect, no flash.
  const [lastStatus, setLastStatus] = useState(collaborator.status);
  if (collaborator.status !== lastStatus) {
    setLastStatus(collaborator.status);
    setRejecting(false);
  }

  return (
    <Card padding="lg">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: "var(--text-lg)" }}>
            {collaborator.fullName || "(no name)"}
          </h3>
          <p style={{ margin: "2px 0 0", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {collaborator.email ?? "—"}
            {emailVerified === true && <VerifyPill verified />}
            {emailVerified === false && <VerifyPill verified={false} />}
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <dl
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          margin: "var(--space-4) 0",
        }}
      >
        <Row label="Project pitch">{app.projectPitch}</Row>
        <Row label="Background">{app.background}</Row>
        <Row label="Institution / affiliation">{app.institution}</Row>
        <Row label="Role / title">{app.roleTitle}</Row>
        <Row label="Areas of interest">{app.interests}</Row>
        <Row label="How they heard about us">{app.heardAbout}</Row>
        <Row label="Knows someone on committee">
          {app.knowsCommittee ? app.committeeContactName || "Yes" : "No"}
        </Row>
        {app.impactJustification ? (
          <Row label="Why high-impact">{app.impactJustification}</Row>
        ) : null}
        {app.linkedinUrl ? (
          <Row label="LinkedIn">
            <ExternalLink href={app.linkedinUrl} />
          </Row>
        ) : null}
        {app.portfolioUrl ? (
          <Row label="Portfolio / website">
            <ExternalLink href={app.portfolioUrl} />
          </Row>
        ) : null}
      </dl>

      {rejecting ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional note to include in the rejection email"
            rows={3}
            maxLength={2000}
          />
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => onReject(reason.trim())}
            >
              Confirm rejection
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          {collaborator.status !== "approved" && (
            <Button size="sm" disabled={busy} onClick={() => onApprove()}>
              Approve
            </Button>
          )}
          {collaborator.status !== "rejected" && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${collaborator.fullName || "this collaborator"}'s application and account? This can't be undone.`,
                )
              ) {
                void onDelete();
              }
            }}
          >
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}
